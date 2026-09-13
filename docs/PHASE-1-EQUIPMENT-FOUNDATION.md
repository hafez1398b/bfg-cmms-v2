# Phase 1 — Equipment Foundation & Explorer V2

**Status:** implemented and locally verified

**Change policy:** minimum safe change / maximum functional improvement

**Database migration:** intentionally **not applied** to the configured PostgreSQL instance

## Delivered scope

Phase 1 upgrades the existing `tree` Equipment page in place. It does not add a second Equipment menu entry or a Floor Plan module. No historical table, work order, PM record, or equipment record is removed.

### Architecture

```text
Existing Equipment Tree page (`tree`)
        │
        ▼
EquipmentRepository (shared adapter)
   ├─ authenticated session ─► /api/equipment ─► PostgreSQL (source of truth)
   └─ no JWT session ────────► explicit local-compatibility adapter (preview/legacy only)

When the feature flag is disabled, the original tree renderer is used as an internal fallback on the same route; it is not exposed as a duplicate menu module.
```

The PostgreSQL path is authoritative in authenticated operation. The compatibility adapter exists only to keep the existing standalone/local SPA usable and is visibly labelled in the UI.

### Equipment API and server-side RBAC

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/equipment/feature` | Read `equipment_v2` feature flag |
| GET | `/api/equipment` | Filtered, sorted, paginated equipment list |
| GET | `/api/equipment/tree` | Lazy tree children |
| GET | `/api/equipment/:id` | Equipment dossier data |
| POST | `/api/equipment` | Create a structural/equipment node |
| PATCH | `/api/equipment/:id` | Allow-listed edit with row-version check |
| POST | `/api/equipment/:id/move` | Transactional move with cycle prevention |
| DELETE | `/api/equipment/:id` | Soft delete only |

Mutation authorization is enforced by `server/equipment-service.js`, not by UI visibility. Technician/operator mutation is denied; planner cannot delete; manager/admin can perform structural operations. Move and edit support optimistic concurrency. Delete preserves history and refuses a parent that still has active children.

### Integrated Equipment List + Tree

The single Equipment page provides:

- unified selection between List and lazy-loaded Tree;
- single-click summary selection and double-click navigation to a full-width, multi-tab equipment dossier;
- a context-aware Back button that returns to the originating Tree or List view;
- dossier tabs for identity, completed maintenance history, PM plans, spare parts, documents and structural changes;
- search, status/criticality filters, allow-listed sorting and bounded pagination;
- configurable columns, CSV export and print styling;
- create/edit, drag-and-drop move and soft delete;
- an internal original-renderer fallback controlled by the feature flag;
- exactly one Equipment menu entry and no Floor Plan menu/module;
- `N/A` / «داده کافی نیست» instead of fabricated health, KPI, or cost values.

## Additive database foundation

`migrations/003_equipment_v2_foundation.sql`:

- adds lifecycle, sort, optimistic-concurrency and nullable health fields to `assets`;
- creates `feature_flags` and `system_restore_points`;
- adds list/tree/search/PM/restore-point indexes;
- contains no `DROP` or `TRUNCATE` statement.

The feature key is `equipment_v2`; its metadata records `classic-equipment` as fallback.

## Backup, migration and rollback runbook

### Preconditions

1. Confirm `DATABASE_URL` points to the intended database.
2. Restrict access to the local `backups/` directory; it is Git-ignored and must never be published.
3. Create and inspect a restore point:

```bash
npm run backup:equipment
```

This creates a repeatable-read JSON snapshot under `backups/equipment/`, writes it with mode `0600`, records per-table counts, and verifies an SHA-256 digest.

4. Only after the output reports a verified snapshot, run:

```bash
npm run migrate:equipment-v2
```

The migration guard refuses to run without a snapshot less than 24 hours old. This Phase 1 delivery deliberately exercised the refusal path and did **not** migrate a real database.

### Operational rollback

1. Immediately disable V2 while retaining the classic page:

```sql
UPDATE feature_flags SET enabled = FALSE, updated_at = now()
WHERE key = 'equipment_v2';
```

2. Stop Equipment V2 writes and place the application in maintenance mode.
3. Validate the selected snapshot checksum and table counts.
4. Restore affected tables from the verified JSON snapshot in a DBA-reviewed transaction/staging database first; reconcile records by primary key rather than truncating production tables.
5. Validate asset counts, parent relationships, WO/PM links and audit history before reopening traffic.

Dropping Phase 1 columns/tables is not part of routine rollback: they are additive and harmless while the flag is disabled. Any physical schema reversal requires a separate reviewed migration after dependency analysis.

## Verification evidence

Executed locally on 2026-09-12:

- syntax checks for API, service, adapter, V2 UI, backup and migration scripts: passed;
- `npm test`: all service, route, regression and canonical-data tests passed;
- static page and Equipment V2 assets served successfully on port 8080;
- unauthenticated `/api/equipment` returned HTTP 401;
- migration without a restore point returned `RESTORE_POINT_REQUIRED` and exited non-zero;
- `git diff --check`: passed.

### Verification boundary

The configured PostgreSQL service was not available/approved for a real backup and migration. Therefore no claim is made that Migration 003 has run against production-like data. Browser-level authenticated PostgreSQL CRUD should be repeated after a DBA-approved restore point and migration in the target environment.
