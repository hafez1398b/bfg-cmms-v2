# BASPAR / BFG — Second Correction Execution Audit

Date: 2026-09-13
Status: Phase 0 audit complete; production rebuild required
Authority: this document evaluates the repository only against the supplied **Second Correction** specification.

## Executive finding

The repository is currently a hybrid prototype, not a production multi-user CMMS/EAM. Equipment V2 has a PostgreSQL API and optimistic versioning, but most business modules still use a browser-local `DB` object and `localStorage`. The notification, AI, workflow, audit and realtime paths in the monolithic frontend are therefore not end-to-end server-backed. Treating the current UI as production-ready would violate the acceptance criteria.

A production implementation must make PostgreSQL the only business source of truth, move security-sensitive AI and notification logic to the backend, authenticate Socket.IO, enforce authorization on every domain operation, and replace generic collection CRUD with domain APIs.

## Evidence-based current-state matrix

| Area | Current evidence | Verdict |
|---|---|---|
| Shared backend | `server.js` exposes PostgreSQL routes, but `public/index.html` primarily reads/writes a browser-local `DB` | FAIL |
| Authentication | Backend JWT login exists; main frontend login validates plaintext local users and stores local session identity | FAIL |
| Authorization | Equipment routes have backend RBAC; generic `/api/data/:collection` permits authenticated users without domain permission checks | PARTIAL / UNSAFE |
| Concurrency | Equipment assets have `row_version`; other critical entities do not have enforced optimistic concurrency | PARTIAL |
| Audit | Equipment mutation writes `audit_x` transactionally; most frontend actions write local audit arrays | PARTIAL |
| Realtime | Socket.IO broadcasts generic events to every unauthenticated socket; connection handler is duplicated three times; frontend has no complete authorized subscription path | FAIL |
| Notifications | `DB.notifs` and browser `notify()` are local-only; no durable targeted notification entity/service/API | FAIL |
| AI | Provider calls and API keys are managed in browser code/local storage; no backend context authorization, durable recommendations or approval state machine | FAIL / SECURITY RISK |
| Workflow | Designer and runs are browser-local; notifications/actions are not transactional server workflows | FAIL |
| Maintenance requests | PostgreSQL table exists, but principal UX/logic remains local and no server-side wizard submission orchestration exists | FAIL |
| Work orders | PostgreSQL table and generic API exist; no complete domain state machine, authorization, concurrency and event/outbox chain | PARTIAL |
| Failure entity | Failures are inferred from completed WOs; no independent durable Failure entity | FAIL |
| RCA | Some report JSON rendering exists; no normalized RCA entity/tools linked to Failure | FAIL |
| Health score | Nullable asset field exists; no explainable server computation pipeline | FAIL |
| Offline sync | No service worker/domain command queue/idempotency/conflict UI | FAIL |
| Responsive | Extensive CSS exists and Equipment V2 is responsive; no full device/browser acceptance harness | PARTIAL |
| Windows installer | Deployment notes exist; no installable shared-backend Windows application package | FAIL |
| Tests | 23 Equipment-focused tests pass; no notification/AI/multi-user/realtime/security/offline/Windows E2E suite | INSUFFICIENT |

## Critical defects that explain the reported broken features

### Notification

Current effective path:

```text
Frontend action → local DB.notifs → local DOM badge
```

Missing production path:

```text
Authorized API command → PostgreSQL transaction → notification recipient rows
→ transactional outbox → authenticated Socket.IO rooms → client cache/UI
```

The current implementation cannot reliably notify another user or another device because notifications are not durably targeted server records.

### AI

Current effective path:

```text
Browser-local context/key → provider request from browser → rendered text/local audit
```

Problems:

- provider secret may be stored in browser local storage;
- backend cannot authorize which equipment/history a prompt can access;
- responses are not normalized durable recommendations;
- approval/application states are not enforced server-side;
- no server-side timeout, provider logging, provenance validation or action boundary.

### Realtime

- Socket.IO handshake has no JWT authentication.
- Events are broadcast globally with `io.emit`.
- No user/role/factory/equipment rooms.
- No transactional outbox, so DB commit and event delivery can diverge.
- Three identical connection handlers are registered.

### Generic CRUD/security

- Generic collection writes dynamically construct SQL column names from client input.
- Authentication is present, but domain authorization is absent for these writes.
- Generic DELETE is a physical delete.
- Updates lack `row_version` checks.
- Important writes and emitted events are not inside one domain transaction/outbox operation.

## Required target architecture

```text
Web / Mobile PWA / Windows shell
           │ HTTPS + JWT
           ▼
Express domain API
  ├─ Authentication + scoped authorization
  ├─ Maintenance Request service
  ├─ Work Order service
  ├─ Failure/RCA service
  ├─ PM/Checklist service
  ├─ Inventory service
  ├─ Notification service
  ├─ AI orchestration and recommendation service
  └─ Offline command/sync service
           │
           ▼
PostgreSQL transactions
  ├─ domain tables + row_version
  ├─ audit_log before/after
  ├─ notifications + recipients
  ├─ provenance
  └─ event_outbox
           │
           ▼
Outbox dispatcher → authenticated Socket.IO rooms
  user:{id}, role:{role}, factory:{id}, equipment:{id}
```

PostgreSQL must be the only production source of truth. Local data may exist only as an explicitly labeled development/demo adapter and must never be selected silently in production.

## Domain state chains

### Maintenance request

```text
Draft wizard → server validation → request transaction
→ audit + outbox + targeted notification
→ triage/approval → Work Order
```

### Failure and AI

```text
Inspection/measurement/request → Failure
→ AI analysis request with authorized evidence
→ AI Recommendation (Pending Approval)
→ human Approve/Reject
→ optional Work Order / PM / Checklist change
→ maintenance → verification → equipment history
```

No AI result becomes a confirmed diagnosis, failure history, action or KPI input before authorized human approval.

## Data model required in the next migration

- `user_scopes`, `role_permissions`
- `notifications`, `notification_recipients`
- `event_outbox`, `event_delivery_attempts`
- `failures`, `failure_measurements`, `failure_attachments`
- `rca_cases`, `rca_nodes`, `rca_actions`
- `ai_runs`, `ai_recommendations`, `recommendation_reviews`
- `checklist_templates`, `checklist_executions`, `checklist_results`
- `sync_commands`, `idempotency_keys`
- provenance columns/status constraints
- `row_version`, `updated_at`, soft-delete metadata on mutable domain entities

## Incremental execution gates

### Phase 1 — Security and shared-data foundation

1. Disable local business source of truth in production.
2. Use backend login in the application shell.
3. Introduce domain authorization/scopes.
4. Remove unsafe generic write/delete paths.
5. Add concurrency and transactional audit foundation.

Exit gate: two authenticated users operate against one PostgreSQL database; unauthorized writes fail at API level; conflicting updates return 409 with current server representation.

### Phase 2 — Event/outbox and notification repair

1. Add durable notification/outbox schema.
2. Authenticate Socket.IO.
3. Add scoped rooms and recipient filtering.
4. Implement notification APIs/read state/history.
5. Wire domain events to notifications.

Exit gate: multi-client E2E proves commit → persisted targeted notification → realtime delivery → read acknowledgement.

### Phase 3 — Maintenance Request and Work Order wizards

Implement server-backed wizard contracts, drafts, evidence uploads, review/submit and workflow transitions. Apply the same reusable step engine to other forms.

### Phase 4 — Failure, RCA and critical propagation

Implement independent Failure/RCA entities, risk calculation, critical event propagation and links across equipment/history/WO.

### Phase 5 — Backend AI orchestration

Move provider credentials/calls to backend; retrieve only authorized evidence; persist run/recommendation/provenance; enforce human approval before actions.

### Phase 6 — Explainable health and prediction

Compute only with minimum evidence thresholds; persist factor breakdown/model version/time window; return N/A otherwise.

### Phase 7 — Offline, responsive and Windows distribution

Add PWA service worker and idempotent command queue; conflict UI; package the same hosted frontend as a Windows shell pointed at the shared backend. No local Windows database.

### Phase 8 — Full verification

Run PostgreSQL integration tests, parallel-user concurrency, Socket.IO authorization/delivery, notification E2E, AI provider contract, wizard/browser breakpoints, offline reconnection, installer smoke, OWASP checks and restore tests.

## Current environment blockers

- PostgreSQL is not available at the configured local endpoint, so production DB transactions and migration verification cannot currently be executed.
- No AI provider credential/model endpoint is available to run a live AI contract test. Tests may mock provider transport, but the feature cannot be marked live-E2E until an authorized test provider is configured.
- The current session was closed after its prior PR was merged; local commits are possible, but GitHub push/PR operations require a new coding session.

## Phase 0 result

The existing code cannot be certified against the Second Correction requirements. The appropriate path is a controlled domain-by-domain rebuild behind the existing UI, not further UI-only patches. No destructive migration should run until PostgreSQL backup/restore and migration verification are available.
