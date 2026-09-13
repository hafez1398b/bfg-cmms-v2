# Equipment Navigation — Architecture & Acceptance Report

Date: 2026-09-13

Scope: incremental upgrade of the existing **درخت تجهیزات** (`pgTree`), with no parallel Equipment/Floor Plan module.

## Architecture audit and decision

| Concern | Existing/reused implementation | Decision |
|---|---|---|
| Menu/page | `MENU` entry `tree`, `pgTree`, global `go(page)` | Keep the original menu and replace only `pgTree` rendering through the enhancement layer. |
| Tree/List | `public/equipment-v2/equipment-v2.js` | Both views use the same `EquipmentRepository`; no duplicate registry. |
| Data access | `public/equipment-v2/equipment-adapter.js` | One DTO contract over PostgreSQL and explicit local compatibility mode. |
| Identity | `assets.id` and `assets.code` | Internal operations retain ID; canonical public route uses EquipmentCode. Both adapters resolve ID or code. |
| Detail | Existing dossier domains plus Equipment enhancement | Preserve previous domains and expose them in a layered 17-tab full detail page. Passport values are derived from structure, PM, WO and history. |
| Routing | Existing SPA had only `#eq=ID` QR behavior | Add History API route `/equipment/{EquipmentCode}`, `popstate`, and Express index fallback. |
| State | Existing global UI state | Extend `window.EQV2`, persisted under `bfg_equipment_ui_state_v2` in `sessionStorage`. |
| Data integrity | Existing assets, PM, WO, requests, items and audit data | No destructive migration, deletion, synthetic KPI, synthetic failure/cost/history, or duplicate entity. |

## Navigation flow

```text
Existing Equipment menu (tree)
  ├─ Tree — single click → select + summary
  │        double click → /equipment/{code}
  └─ List — single click → select + summary
           double click → /equipment/{code}

/equipment/{code}
  ├─ breadcrumb → ancestor context / parent detail
  ├─ Components → sub-equipment/component detail route
  ├─ browser Back/Forward → deterministic route restoration
  └─ «بازگشت به تجهیزات» → exact saved Tree/List state
```

## Acceptance criteria verification

| # | Criterion | Result | Verification |
|---:|---|---|---|
| 1 | Tree and List share one registry | PASS | Static regression + repository integration test |
| 2 | Single click only selects/shows summary | PASS | Event-path review; destructive actions remain separate permission-gated buttons |
| 3 | Double click opens exact detail in both views | PASS | Capture-phase delegated `dblclick` automated test |
| 4 | Detail retains ID/code context | PASS | Adapter code-resolution and route-context tests |
| 5 | Bookmarkable `/equipment/B1P01` and refresh fallback | PASS | HTTP smoke: root `200`, bookmark `200`, identical SPA index response |
| 6 | Header has persistent Back, code, name, factory, location, status | PASS | Detail DOM test + responsive sticky header CSS |
| 7 | Clickable Factory/Category/Subcategory breadcrumb | PASS | Adapter ancestry test + detail DOM test |
| 8 | Back returns to exact source view | PASS | Automated Tree and List restoration tests |
| 9 | Tree expanded nodes, filters, selection and scroll persist | PASS | Automated restoration test + session serialization |
| 10 | List search, filters, sort, page, selection and scroll persist | PASS | Automated restoration test + session serialization |
| 11 | SPA navigation avoids unnecessary reload | PASS | `pushState`, `replaceState`, `popstate`; HTTP fallback only serves refresh/direct entry |
| 12 | Existing detail domains remain available | PASS | Automated assertion over all 17 detail tabs |
| 13 | Sub-equipment/components with Equipment identity get independent detail | PASS | Children use the same `data-equipment-detail` route contract |
| 14 | Parent → child → component and browser Back are predictable | PASS | Independent code routes + `popstate` restoration |
| 15 | Repeated double click does not duplicate detail | PASS | Route busy guard and same canonical path reuse test |
| 16 | Desktop/tablet/mobile usability; Back stays visible on mobile | PASS (implementation) | Responsive breakpoints and sticky mobile header/back CSS; final physical-device visual smoke remains recommended |
| 17 | KPI/health/cost only from sufficient real data | PASS | Adapter returns `null`/N/A where evidence is insufficient; reliability requires valid failure and runtime inputs |
| 18 | PostgreSQL detail supports filters, code resolution, path and children | PASS (contract) | Route unit tests with query mocks; live PostgreSQL was unavailable in this workspace |
| 19 | No parallel Equipment/Floor Plan menu/module returns | PASS | Regression tests verify one `tree` entry and absence of Floor Plan files/routes |

## Detail layers retained/added

1. شناسنامه تجهیز
2. ساختار / Components
3. برنامه نگهداری و تعمیرات
4. چک‌لیست‌ها و بازرسی‌ها
5. درخواست‌های تعمیر
6. Work Orders
7. سوابق تعمیرات
8. سوابق خرابی
9. PM History
10. قطعات یدکی مصرف‌شده
11. هزینه‌های تعمیرات
12. توقفات تجهیز
13. شاخص‌های قابلیت اطمینان
14. مستندات و فایل‌ها
15. ریسک‌ها
16. RCA / تحلیل خرابی
17. سایر / سابقه تغییرات

## Verification summary

- `npm test`: **23/23 passed**.
- `node --check`: passed for `server.js`, Equipment API routes, adapter, and UI navigation.
- `git diff --check`: passed.
- Runtime HTTP smoke on port 8080:
  - `/` → `200`
  - `/equipment/B1P01` → `200`, same SPA entry document
  - `/equipment-v2/equipment-v2.js` → `200`
  - unauthenticated `/api/equipment/B1P01` → `401` as required by RBAC
- No destructive database operation or migration was executed.

## Environment limitation

PostgreSQL was not listening on `localhost:5432`; therefore the PostgreSQL SQL contract is covered by route-level automated tests, but a live authenticated database smoke test was not possible. Browser automation is not installed, so interaction coverage uses a DOM VM harness and HTTP runtime checks; a final visual pass on actual tablet/mobile widths is recommended before production promotion.
