# فاز صفر — ممیزی ماژول Equipment و چرخه نگهداری

> **تصمیم معماری پس از ممیزی:** بنا به درخواست کاربر، ماژول مستقل Floor Plan و ورودی جداگانه Equipment V2 از محصول هدف حذف شدند. ارجاعات Floor Plan در این سند فقط وضعیت workspace در زمان ممیزی را ثبت می‌کنند. قابلیت‌های جدید اکنون داخل همان منوی «درخت تجهیزات» ادغام می‌شوند.

**پروژه:** Arena CMMS / Enterprise.cmms.BFG

**دامنه:** Equipment → Structure → Component → Spare → PM → Checklist → Planning → Request → WO → History → KPI → Passport

**وضعیت این سند:** Audit Only — در این فاز هیچ Migration یا تغییر کد اجرایی انجام نشده است.

---

## 1. خلاصه مدیریتی

سامانه فعلی یک CMMS عملیاتی و گسترده با Asset Tree، درخواست، دستورکار، PM، برنامه‌ریزی، انبار، اسناد، Audit، RBAC و گزارش‌گیری است؛ بنابراین بازنویسی توجیه ندارد. با این حال مدل Equipment هنوز برای Digital Asset Management حرفه‌ای کافی نیست.

مهم‌ترین واقعیت معماری، وجود دو منبع داده است:

1. **Browser Demo Store:** آبجکت سراسری `DB` در `localStorage` با کلید `bfg_cmms_v1`؛ بخش عمده UI فعلی مستقیماً روی آن کار می‌کند.
2. **PostgreSQL:** جداول `assets`, `work_orders`, `requests`, `pm_plans`, `items`, ... و REST API در `server.js`.

این دو مسیر مدل و نام‌گذاری یکسانی ندارند و UI عمدتاً از PostgreSQL تغذیه نمی‌شود. پیش از توسعه عمیق، باید Data Adapter واحد ایجاد شود؛ در غیر این صورت هر قابلیت جدید دو بار پیاده‌سازی و داده‌ها ناسازگار خواهند شد.

**نتیجه ممیزی:** توسعه باید افزایشی باشد، اما شروع مستقیم از UI بدون تثبیت Domain Model و Adapter داده ریسک بالایی دارد. ترتیب امن: migrationهای additive → APIهای domain-specific → adapter سازگاری → List/Tree → Dossier مشترک.

---

## 2. معماری فعلی

### Backend

- Node.js + Express در `server.js`
- PostgreSQL با `pg.Pool`
- JWT برای authentication
- Socket.IO برای اعلان تغییر collection
- Static SPA از پوشه `public`
- API تخصصی Floor Plan در `server/floor-plan-routes.js`
- فایل‌های نقشه در File Storage محلی؛ مسیر در DB

### Frontend

- SPA بدون Framework
- فایل اصلی `public/index.html` حدود ۱.۳MB و بیش از ۱۷هزار خط
- Render بر پایه template string و توابع global
- Router دستی با تابع `go(page)`
- چندین enhancement layer که توابع قبلی را wrap/override می‌کنند
- Design System، RTL، Dark Mode، Modal، Drawer، Toast، Charts و Jalali Date موجود است
- ماژول Floor Plan جدا شده، ولی Equipment همچنان داخل monolith است

### Data Flow

```text
Current UI → global DB object → localStorage
                       ↘ audit / notifications / reports

REST client (محدود) → Express generic API → PostgreSQL
Floor Plan UI/API    → domain route          → PostgreSQL/File Storage
```

### نتیجه

- UI و PostgreSQL هنوز یک Source of Truth مشترک ندارند.
- توسعه جدید باید در فایل‌های ماژولار انجام شود، نه با افزودن enhancement layer جدید به انتهای `index.html`.
- حذف یا بازنویسی یک‌باره monolith ممنوع و پرریسک است؛ Strangler Pattern مناسب است.

---

## 3. مدل فعلی Equipment

### PostgreSQL

جدول `assets` هم‌زمان برای Company، Factory، Category، Location، Equipment، Subsystem و Sub Equipment استفاده می‌شود:

- `id`, `parent`, `code`, `name`, `type`
- `cls`, `status`, `crit`
- `maker`, `model`, `serial`, `year`, `install`
- `power`, `hours`
- `history JSONB`, `ext JSONB`, `propCode`
- `category_id` و `requires_coding` در migration افزایشی قبلی

جدول `asset_categories` رابطه کارخانه و دسته سازمانی را ایجاد کرده است. ساختار Canonical فعلی:

```text
شرکت بسپار فوم غرب
├── دفتر مرکزی
└── کارخانجات
    ├── بسپار ۱
    │   └── ۱۰ دسته سازمانی
    ├── بسپار ۲
    └── ... بسپار ۶
```

### Browser Store

Assetها در `DB.assets` با adjacency list (`parent`) نگهداری می‌شوند. نوع گره با ترکیبی از فیلدهای زیر مشخص می‌شود:

- `type`: site / unit / line / eq
- `nodeKind`: company / factory / category / main / sub / sys / panel
- `cls`, `cat`

### قابلیت‌های موجود

- Tree سلسله‌مراتبی
- Expand/Collapse
- Search
- افزودن تجهیز
- ویرایش مشخصات پایه
- Drag & Drop تجهیز به Parent غیرتجهیزی
- فرم Migration و ثبت دلیل جابه‌جایی
- Soft Delete با `deleted=true`
- جلوگیری از بایگانی Parent دارای فرزند
- جلوگیری از بایگانی تجهیز دارای WO باز
- ثبت تغییرات در `history` و Audit
- اتصال Asset به PM، WO، Inventory، Project، Instrument و Floor Plan

### کمبودها

- List View و Tree View یکپارچه و حرفه‌ای وجود ندارد؛ گزارش پیشرفته جایگزین کامل List نیست.
- `assets.parent` در DB فاقد Foreign Key و کنترل cycle است.
- Location و Asset Structure از هم تفکیک Domain نشده‌اند.
- ترتیب فرزندان، path، depth، materialized path و lazy loading وجود ندارد.
- Drag & Drop فقط Equipment را به Parent غیرتجهیزی می‌برد؛ Component-level reorder/re-parent کامل نیست.
- Rename/Move/Deactivate عملیات domain-specific و transactional API ندارند.
- Soft Delete فقط در Browser Store است و ستون‌های استاندارد `deleted_at/deleted_by` در PostgreSQL وجود ندارد.
- مدل polymorphic فعلی برای گزارش‌گیری و integrity در عمق زیاد کافی نیست.

---

## 4. مدل فعلی Sub Equipment / Subsystem / Component

### موجود

- `nodeKind=sys`, `nodeKind=sub`, `nodeKind=panel` در Browser Store
- امکان ساخت برخی زیرسیستم‌ها و زیرتجهیزها در Wizardهای موجود
- نمایش فرزندان در Tree و Detail Center
- اتصال PM و مسئول به برخی زیرگره‌ها
- برخی Cardها و چک‌لیست تخصصی تابلو برق و خودرو

### مفقود

- Entity مستقل یا قرارداد مشخص برای Component وجود ندارد.
- Component Type پویا وجود ندارد.
- فیلدهای Part Number، expected life، maintenance interval، voltage، capacity و manufacturer عمدتاً داخل JSON یا اصلاً موجود نیستند.
- Critical Component و Critical Reason مدل نشده است.
- هیچ وضعیت governance برای AI Suggestion روی ساختار وجود ندارد.
- اسناد مستقیماً به Component متصل نمی‌شوند.
- uniqueness و cycle prevention برای درخت Component وجود ندارد.

### تصمیم پیشنهادی

Asset اصلی در جدول `assets` باقی بماند. برای ساختار فنی، جداول additive زیر مناسب‌ترند:

- `asset_nodes`: Sub Equipment / Subsystem / Main Component / Sub Component
- `component_types`: نوع پویا و قابل مدیریت
- `component_criticality_reasons`
- یا در صورت الزام به reuse کامل، `assets` با discriminator و constraintهای جدید Extend شود.

انتخاب نهایی باید در Phase 3 پس از Prototype Query Plan انجام شود. توصیه اولیه: Location/Equipment در `assets` و ساختار فنی در `asset_nodes`، زیرا lifecycle، فیلدها و inventory relation متفاوت‌اند.

---

## 5. مدل فعلی PM

### PostgreSQL

`pm_plans` شامل:

- Asset، عنوان، `interval_days`, `last_run`
- owner/supervisor، تخصص، نوع
- `checklist JSONB`
- status، recurring، source_ref و ext

### UI فعلی

- Listing PM
- محاسبه Next Date با افزودن `interval` روز
- ایجاد PM
- مشاهده checklist ساده
- تولید WO از PM
- اتصال PM به Asset
- گزارش‌ها و برخی KPIهای PM

### شکاف‌ها

- Frequency/Unit استاندارد وجود ندارد.
- Month/Year با day approximation محاسبه می‌شود.
- Meter trigger وجود ندارد.
- TIME OR METER / TIME AND METER وجود ندارد.
- Meter Reading history وجود ندارد.
- PM Due entity و state machine مستقل وجود ندارد.
- Required Spare/Tool و estimated cost ساختاریافته نیست.
- completion چرخه Last Done/Next Due را transactionally به‌روزرسانی نمی‌کند.
- Planning Card مستقیماً از Due تولید نمی‌شود.

---

## 6. مدل فعلی Planning

### موجود

`plan_events` و `DB.planEvents` شامل تاریخ، ساعت، مسئول، تیم، واحد، کارخانه، پروژه، WO، Asset، PM، Request، HSE، وظایف، گزارش‌ها و progress است.

قابلیت‌ها:

- Calendar/Timeline
- Drag & Drop تاریخ
- مسئول و تیم
- اولویت و تکرار
- اعلان داخلی
- فرم چندمرحله‌ای توسعه‌یافته
- اتصال به Asset/WO/PM/Request/Project

### کمبودها

- Planning Card تخصصی PM Due یا Approved Request نیست.
- source type و source id contract شفاف ندارد.
- انتقال داده به WO استاندارد و transaction-based نیست.
- Shift، required spare/tool reservation و checklist template snapshot کامل نیست.
- Queue و capacity planning تکنسین وجود ندارد.
- state machine رسمی Planning وجود ندارد.

---

## 7. مدل فعلی Request

### موجود

- جدول `requests` و `DB.requests`
- Wizard درخواست تعمیر
- Asset، شرح، urgency، impact، requester، وضعیت و history
- تأیید و تبدیل به WO
- ارتباط با گزارش، Detail Center و Audit

### کمبودها

- Subsystem/Component/Defect reference ندارد.
- Approved Request → Planning Queue اجباری نیست.
- تبدیل مستقیم به WO مسیر غالب است.
- API domain-specific و transition guard ندارد.
- state transitionها در DB constraint نشده‌اند.

---

## 8. مدل فعلی Work Order و History

### Work Order

`work_orders` شامل Asset، Request، assignee، status، priority، times، parts، media، report، cost و PTW است. قابلیت‌های UI:

- Kanban
- Drag status
- Assignment
- شروع/پایان کار
- گزارش فنی، تصویر، صوت و فایل
- قطعات مصرفی
- PTW/HSE
- چک‌لیست‌های خاص خودرو و تابلو
- Detail Center، Print و Audit

### Maintenance History

دو نمایش فعلی دارد:

1. `assets.history JSONB` برای تغییرات و بخشی از سوابق
2. Work Orderهای بسته‌شده برای تاریخچه عملیاتی

این دوگانگی باعث خطر duplicate/inconsistent history می‌شود.

### داده‌های ۱۴۰۵

فیلدهای `confirmation_status`, `provisional_fields`, `period_label`, `source_metadata` برای ثبت امن داده‌های ناقص افزوده شده‌اند. رکوردهای پیشنهادی باید Draft باقی بمانند و نباید در KPIهای قطعی وارد شوند.

### شکاف‌ها

- Maintenance History canonical entity/view وجود ندارد.
- PM و EM در UI تفکیک کامل ندارند.
- Root Cause، downtime، component و actual cost schema ثابت ندارند.
- completion transaction شامل history + meter + PM update + inventory issue نیست.
- historical integrity در API enforce نمی‌شود.

### پیشنهاد

Work Order completed منبع حقیقت باشد و `maintenance_history` یک SQL View/Materialized View یا projection غیرقابل ویرایش از completion records باشد؛ نه جدول دستی موازی.

---

## 9. مدل فعلی Checklist

### موجود

- checklist آرایه‌ای داخل PM
- `genChk` و checklistهای اختصاصی خودرو/تابلو
- status و note در برخی executionها
- ایجاد WO در بعضی failure flowها
- Print در بعضی فرم‌ها

### مفقود

- Checklist Template مستقل
- Template Version
- Checklist Execution مستقل
- Execution Item با OK/Attention/Failed/N/A
- acceptance criteria، actual value، unit، attachment
- Failed Item → Defect → Request/WO عمومی
- approval و immutable completion snapshot
- A4/A5 portrait/landscape عمومی

مدل فعلی برای Checklist صنعتی عمومی قابل توسعه مستقیم نیست و باید با حفظ JSONهای قبلی، migration تطبیقی داشته باشد.

---

## 10. مدل فعلی Inventory

### موجود

- `items`, `stock_docs`
- موجودی، حداقل، حداکثر، قیمت، محل، category
- link قدیمی `key_for JSONB`
- join table جدید `asset_spare_parts`
- مصرف قطعه در WO از طریق `parts JSONB`
- هشدار کمبود موجودی

### مفقود

- اتصال Component به Spare Part
- available/reserved quantity تفکیک‌شده
- reservation برای Planning/WO
- Warehouse و Bin entity مستقل
- Supplier/Part Number ساختاریافته
- Critical Spare flag و lead time
- transaction امن issue/return در completion WO

---

## 11. مدل فعلی Documents

### موجود

- جدول flat به نام `docs`
- title، category، version، status، size، format، date
- Document Center و metadata/files در Detail Center
- فایل‌های نقشه Floor Plan با storage path

### مفقود

- رابطه استاندارد polymorphic با Equipment/Component/WO/PM
- Document Type taxonomy مطابق Manual/Datasheet/Drawing/...
- revision جدا از version
- uploaded_by، storage_path، hash، MIME، access scope
- lifecycle جاری/منسوخ/در انتظار تأیید در API
- history نسخه‌ها

---

## 12. KPI و Health فعلی

### موجود

- توابع محاسبه و Dashboardهای KPI
- MTBF/MTTR، availability و هزینه در برخی صفحات
- Trend chartهای SVG
- Drill-down گزارش‌ها

### ریسک

- برخی مقدارها در UI قدیمی hard-coded یا demo-derived هستند.
- بعضی KPIها کل `DB` را در Browser scan می‌کنند.
- داده‌های Draft/Proposed از confirmed جدا نشده‌اند.
- operating calendar و planned downtime مشخص نیست.
- unit/currency normalization وجود ندارد.

### الزام طراحی

Health Score فقط از confirmed facts محاسبه شود. در نبود denominator، operating time، downtime یا completion کافی، مقدار `N/A — داده کافی برای محاسبه وجود ندارد` نمایش داده شود.

---

## 13. Equipment Passport و فرم مرجع

دو تصویر مرجع بررسی شد. فرم مرجع دارای این ساختار است:

1. Header رسمی با لوگو، عنوان «شناسنامه تجهیزات و ثبت سوابق تعمیرات»، کد سند، تاریخ ویرایش و صفحه
2. جدول مشخصات شناسنامه‌ای تجهیز
3. شرح مختصر نحوه کار
4. ملاحظات ایمنی و زیست‌محیطی با Highlight
5. لیست قطعات دو ستونه
6. جدول دوره‌های سرویس با Highlight زرد
7. جدول سوابق تعمیر با PM/EM، توقف، زمان‌ها، شرح و مدت

### وضعیت فعلی

- شناسنامه ساده و Print عمومی وجود دارد.
- فیلدهای پایه Asset و تاریخچه WO قابل بازیابی‌اند.
- Passport رسمی منطبق با فرم مرجع، pagination و Page X of Y وجود ندارد.
- Parts باید از Equipment Structure خوانده شوند؛ فعلاً keyParts عمدتاً JSON است.

### پیشنهاد

Passport یک Report Projection read-only باشد و داده را از Asset، Node، PM و Completed WO بخواند. هیچ فیلد تاریخی در فرم Passport دوباره ذخیره نشود.

---

## 14. API فعلی

### موجود

- `/api/auth/login`
- Generic CRUD: `/api/data/:collection`
- Floor Plan domain API
- JWT authentication
- Socket.IO event

### مشکلات مهم

1. Generic Update/Delete نام collection و field را مستقیم در SQL قرار می‌دهد؛ allowlist در همه methodها یکسان enforce نشده است.
2. authentication وجود دارد اما authorization عملیاتی روی APIهای generic وجود ندارد.
3. mapping بعضی collectionها با نام جدول متفاوت است؛ مانند `wos/work_orders`, `pms/pm_plans`, `planEvents/plan_events`, `auditX/audit_x`.
4. API response DTO با Browser model هم‌نام نیست؛ snake_case/camelCase mismatch دارد.
5. optimistic locking/version field وجود ندارد.
6. transaction برای completion flow وجود ندارد.
7. pagination/filter/sort server-side عمومی وجود ندارد.
8. سه Socket.IO connection handler تکراری است.
9. CORS روی `*` است.
10. rate limiting، request validation و structured error contract وجود ندارد.

### نتیجه

برای قابلیت‌های جدید نباید generic CRUD گسترش یابد. Routerهای domain-specific با schema validation، permission guard، transaction و audit لازم است.

---

## 15. RBAC و Security فعلی

### موجود

- Roleهای admin, mgr, planner, tech, op, store, hse, cal
- Permission Manager نسخه ۲
- عملیات view/create/edit/delete/approve/close/archive/print/export
- user override و role matrix
- page-level enforcement
- permission-denied audit در UI

### شکاف

Permissionها در سطح module فعلی‌اند و عناوین دقیق درخواستی مانند `Component.Manage` یا `Checklist.Execute` مستقل نیستند. مهم‌تر اینکه enforcement عمدتاً Client-side است؛ API generic فقط JWT را بررسی می‌کند.

### الزام

Permissionهای جدید باید claim/permission server-side باشند و هر mutation در Backend دوباره بررسی شود. UI guard فقط برای UX است، نه امنیت.

---

## 16. قابلیت‌های قابل استفاده مجدد

- Design tokens، RTL، Dark Mode و responsive primitives
- Modal/Drawer/Toast/Badge/Tabs
- Tree rendering و migration interaction به‌عنوان prototype
- Detail Center و Entity relation navigation
- RBAC UI و permission resolver
- Audit Trail v2
- Notification infrastructure
- Planning calendar/timeline
- WO Kanban و completion/report flows
- Jalali date helpers
- Export/Print infrastructure
- Floor Plan module و Asset locator
- PostgreSQL tables اصلی و روابط Asset/WO/PM/Inventory

---

## 17. قابلیت‌های مفقود به تفکیک فاز

| فاز | وضعیت فعلی | Gap اصلی |
|---|---|---|
| 1 List + Tree | Tree پایه موجود | List حرفه‌ای، lazy load، reorder، API |
| 2 Dossier | Dossier شش‌تب قدیمی موجود | Header/action contract و component واحد |
| 3 Structure | nodeKindهای محدود | مدل Component و type پویا |
| 4 Inventory | Asset↔Spare موجود | Component↔Spare، reservation |
| 5 PM | time/day موجود | meter و compound trigger |
| 6 Checklist | JSON و تخصصی | template/execution عمومی |
| 7 Planning | calendar موجود | due/request queue و assignment transaction |
| 8 Request | request→WO موجود | request→planning و component context |
| 9 History | WO + asset.history | projection canonical و integrity |
| 10 Docs/KPI | پایه موجود | entity links، N/A-safe KPI و cache |
| 11 Passport | print ساده | فرم رسمی منطبق تصویر |
| 12 AI | AI عمومی موجود | governed structure wizard |
| 13 Quality | QA دستی | automated regression/security/performance |

---

## 18. Migrationهای لازم — فقط پیشنهاد، هنوز اجرا نشده

### Migration A — Tree Safety

- `assets.parent_id` FK تدریجی یا validation trigger برای ستون فعلی
- `sort_order`, `path`, `depth`, `version`
- `is_active`, `deleted_at`, `deleted_by`, `delete_reason`
- indexهای `(parent, sort_order)`, `(category_id, status)`, `(code)`
- cycle prevention function

### Migration B — Technical Structure

- `component_types`
- `asset_nodes`
- `asset_node_critical_reasons`
- unique sibling code و index parent

### Migration C — Component Inventory

- `component_spare_parts`
- `warehouses`, `warehouse_bins`
- `inventory_balances`, `inventory_reservations`

### Migration D — PM Engine

- `maintenance_plans` extension یا additive columns
- `pm_triggers`
- `meter_readings`
- `pm_due_events`
- `plan_required_items`, `plan_required_tools`

### Migration E — Checklist

- `checklist_templates`
- `checklist_template_versions`
- `checklist_template_items`
- `checklist_executions`
- `checklist_execution_items`
- `defects`

### Migration F — Documents

- `documents` extension
- `document_versions`
- `entity_documents`

### Migration G — Audit/Concurrency

- entity version / optimistic lock
- append-only audit event details
- DB-level history protection

تمام migrationها باید forward-only، additive، idempotent و دارای rollback plan باشند. قبل از اجرا باید backup metadata و restore point ثبت شود.

---

## 19. Risk Assessment

| ریسک | شدت | توضیح | کنترل پیشنهادی |
|---|---:|---|---|
| Dual Source of Truth | بحرانی | localStorage و PostgreSQL مستقل | Data Adapter و API-first |
| Monolith override chain | بحرانی | تغییر یک تابع می‌تواند ده wrapper را بشکند | ماژول مستقل + contract tests |
| Generic API authorization | بحرانی | JWT بدون permission mutation | domain routes + server RBAC |
| Historical fabrication | بحرانی | demo/hard-coded KPI و history | confirmed/proposed filters |
| Migration data loss | زیاد | polymorphic assets و روابط JSON | additive migration + backup + dry run |
| Tree cycle/orphan | زیاد | parent بدون FK | cycle guard + FK strategy |
| KPI inaccuracy | زیاد | denominator/operating time ناقص | N/A policy + formula registry |
| Browser performance | زیاد | full scans و recursive render | pagination/lazy load/index/cache |
| Checklist data explosion | متوسط/زیاد | item copy بدون template version | template/execution separation |
| Concurrent edits | زیاد | version/locking ندارد | optimistic concurrency |
| Passport inconsistency | متوسط | ورود دوباره داده | read-only projection |

---

## 20. معماری هدف پیشنهادی

```text
Equipment UI Modules
  ├─ Equipment Explorer (List/Tree)
  ├─ Digital Dossier
  ├─ Structure Editor
  ├─ Maintenance Plan
  ├─ Checklist Execution
  ├─ History / KPI
  └─ Passport Report
          ↓
Equipment Data Adapter
  ├─ REST Repository (Production)
  └─ Local Demo Repository (temporary compatibility)
          ↓
Domain APIs + RBAC + Validation + Audit
          ↓
PostgreSQL
```

اصل migration UI: صفحه قدیمی حفظ شود؛ مسیر جدید ابتدا پشت feature flag ایجاد و پس از قبولی regression به مسیر اصلی تبدیل شود.

---

## 21. ترتیب اجرای امن

### Gate 0 — پیش‌نیاز شروع Phase 1

1. Backup/restore point DB
2. تعیین PostgreSQL به‌عنوان Source of Truth
3. تعریف DTO و Data Adapter
4. ثبت baseline regression
5. اصلاح authorization APIهای mutation مرتبط
6. Feature flag برای Equipment V2

### Phase 1 پیشنهادی

- Equipment Explorer ماژولار
- List/Tree switch بدون reload کامل
- server-side list query
- lazy children endpoint
- انتخاب مشترک و بازکردن Dossier واحد
- بدون تغییر schema component در این فاز

### Acceptance Gate هر فاز

```text
Build → Unit/Integration Test → Migration Dry Run → Permission Test
→ API Regression → Data Integrity Check → User Verification → Continue
```

---

## 22. تصمیم نهایی فاز صفر

- **Rewrite:** رد می‌شود.
- **Reuse:** Asset، WO، Request، PM، Inventory، Planning، RBAC، Audit و UI primitives حفظ می‌شوند.
- **Extend:** مدل درخت، Component، Trigger، Checklist، Documents و Data Quality به‌صورت additive توسعه می‌یابد.
- **Source of Truth:** باید PostgreSQL باشد؛ localStorage فقط adapter موقت Demo.
- **History:** Completed WO منبع حقیقت؛ Proposed/Draft هرگز وارد KPI قطعی نمی‌شود.
- **AI:** فقط suggestion با source/confidence/status و approval اجباری.
- **Passport:** projection رسمی read-only مطابق فرم تصویری.

**وضعیت آمادگی Phase 1:** مشروط به Gate 0، خصوصاً Data Adapter و API authorization. هیچ Migration پیشنهادی این سند در فاز صفر اجرا نشده است.
