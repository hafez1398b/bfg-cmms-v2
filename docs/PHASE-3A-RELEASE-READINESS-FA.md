# گزارش آمادگی انتشار Phase 3-A — پذیرش Windows Staging

## تصمیم فعلی

**نتیجهٔ Staging: Passed برای تشکیل بستهٔ Staging و ایجاد Draft PR.** این نتیجه مجوز Merge یا انتشار Production نیست.

- PR این مرحله باید **فقط Draft** باشد.
- **Merge و Auto-merge تا تأیید دستی ممنوع است.**
- استقرار Production انجام نشده است.
- دادهٔ Production تغییر نکرده است.
- هیچ Fixture، دادهٔ جعلی یا رکورد عملیاتی آزمایشی ساخته نشده است.
- در UAT هیچ Save، Generate، Archive، Schedule، Occurrence، Work Order یا Completion اجرا نشده است.

## مبنای Source و Runtime

| مورد | شاهد ثبت‌شده |
|---|---|
| Windows source branch | `phase3a-staging` |
| Windows HEAD پذیرفته‌شده | `f5b5662ee5fce3a163f818f336e9a34ca03e258b` |
| App version | `4.0.0` |
| API version | `5.0.0` |
| Runtime | `development / server-only` |
| Container | Healthy |
| Health API | `status=ready`، `database=true`، `schemaReady=true` |

Commitهای ارجاع‌شده در این گزارش در تاریخچهٔ مخزن وجود دارند:

- D1: `7118583225e68f0b1c2a6f42cae7b7d1980f7f59`
- D1.1: `e50d2d1c7dc4328f674fcf1f6b179fb7e680c68c`
- D1.2: `cf9a775005238a4ca10be0181e5a53df8f7d69a9`
- D2: `f5b5662ee5fce3a163f818f336e9a34ca03e258b`

## سابقهٔ UAT و اصلاحات D1 تا D1.2

### شکست اولیهٔ PM UI

در UAT اولیه، اتصال UI جدید PM به Store واقعی Server-only کامل نبود؛ دسترسی مستقیم UI به Store مرورگر/Global با Store واژگانی Maintenance سازگار نبود و نمایش قابل اتکای Planهای واقعی Backend و روابط آن‌ها تضمین نمی‌شد. همچنین Quick Action پروندهٔ تجهیز، مرجع تجهیز را تا فرم مرکزی PM حفظ نمی‌کرد. بنابراین نتیجهٔ اولیهٔ PM UI قابل پذیرش نبود.

### اصلاحات و شواهد Regression

1. **D1 — `7118583`:** UI Phase 3-A به Projection واقعی و غیرپایدار Maintenance در Server-only متصل شد؛ خواندن Plan و Asset از accessor کنترل‌شده انجام شد و دادهٔ عملیاتی به Local Storage منتقل نشد.
2. **D1.1 — `e50d2d1`:** دسترسی Collection مربوط به Work Order در accessor حفظ شد تا نمایش ارتباط Occurrence/Work Order با اصلاح D1 شکسته نشود.
3. **D1.2 — `cf9a775`:** Quick Action «PM+» در پروندهٔ تجهیز به همان فرم مرکزی New PM Plan هدایت شد؛ شناسهٔ canonical تجهیز تا فرم حفظ و تجهیز درست preselect شد. مرجع ناشناخته، جزئی یا دارای کد تکراری Fail Closed می‌شود و تجهیز حدس زده نمی‌شود.

### نتیجهٔ نهایی PM UI UAT

- PM UI در حالت Server-only بارگذاری شد.
- Planهای موجود Backend نمایش داده شدند.
- جزئیات Plan و Checklist نمایش داده شدند.
- در نبود شواهد Completion تأییدشده، Due/Next Due دقیقاً `N/A — داده کافی ثبت نشده است` باقی ماند.
- فرم مرکزی «New PM Plan» باز شد.
- PM+ پروندهٔ تجهیز همان فرم مرکزی را باز کرد و تجهیز صحیح preselect شد.
- هیچ عملیات نوشتنی در UAT اجرا نشد.
- Smoke نهایی پس از D2: **Pass؛ هیچ رکوردی ذخیره نشد.**

## Critical Security Blocker و رفع D2

در Windows Staging، Generic Data API امکان خواندن Collectionهای حساس و دورزدن Domain API را فراهم می‌کرد. مسیر Generic users اطلاعات بیش‌ازحد می‌داد و Generic write شامل SQL پویا و امکان Privilege Escalation در ساخت کاربر بود. این مورد یک Release Blocker بحرانی بود.

D2 در Commit `f5b5662` این Blocker را بست:

- Generic Dynamic SQL write حذف شد.
- Generic `POST`، `PUT` و `DELETE` Fail Closed شدند.
- Collection و Column ارسالی Caller دیگر Identifier SQL تولید نمی‌کنند.
- ساخت کاربر به `POST /api/users` با Auth، CSRF، `users.create`، Role allowlist، ID سمت سرور، Password policy و Audit امن منتقل شد.
- فقط System Administrator می‌تواند کاربر با نقش Administrator بسازد.
- Password و Hash در Response، Audit یا Log قرار نمی‌گیرند.
- Directory موردنیاز PM/Maintenance به `GET /api/users/directory` منتقل شد و فقط `id/name/role` برمی‌گرداند.
- Generic readها دارای Policy ثابت، Permission صریح و ستون‌های مصوب شدند؛ `auditX` نیز بدون Permission قابل خواندن نیست.
- Collectionهای Equipment، Maintenance و Inventory از Generic API به Domain API ارجاع/رد می‌شوند.

Negative checkهای ثبت‌شده در Runtime ویندوز:

| بررسی | نتیجهٔ مشاهده‌شده |
|---|---|
| Generic write بدون Authentication | `403 CSRF_FAILED` |
| `POST /api/data/users` با نشست معتبر | `400 Bad Request`؛ بدون ایجاد رکورد |
| POST به Collection دلخواه با نشست معتبر | `400 Bad Request`؛ بدون ایجاد رکورد |
| کلیدهای خروجی Directory | فقط `id`, `name`, `role` |
| تعداد Directory در Staging فعلی | `1` |

هیچ تست امنیتی یا UAT رکورد عملیاتی ایجاد نکرد.

## Passed

### Migration و قرارداد Database

Runner رسمی و بررسی‌شده:

```text
npm run update:apply -- <local-backup-path>
node scripts/apply-update.js <local-backup-path>
```

نتایج Windows Staging:

- اجرای اول Migration 018: `applied=["018"]` و `skipped=["002"..."017"]`.
- اجرای دوم: `applied=[]` و `skipped=["002"..."018"]`.
- `schema_migrations`، Migration 018 را ثبت کرده است.
- جدول `pm_occurrences` وجود دارد.
- ستون `work_orders.occurrence_id` وجود دارد.
- ستون `pm_occurrences.work_order_id` وجود ندارد.
- FK یک‌طرفه از `work_orders.occurrence_id` به Occurrence تأیید شد.
- سه Unique Index الزامی تأیید شدند:
  - `idx_pm_occurrences_plan_period_unique`
  - `idx_work_orders_occurrence_unique`
  - `idx_pm_plans_active_asset_code_unique`
- Permissionهای `pm.restore` و `pm.schedule` برای `mgr` و `planner` تأیید شدند.

### Backup و Restore Drill

- Backup فعال پیش از Migration: `backups/pre-phase3-e2-20261029-161920.dump`
- اندازه: `201787` بایت
- SHA-256: `eb56e280551014d1cb7573ac16360367862a9b3bb2308ea8dbb27b1e437480d8`
- Restore Drill با موفقیت در Database موقت `bfg_cmms_restore_test_20261029_163158` انجام شد.
- Database عملیاتی در Restore Drill تغییر نکرد.
- Database موقت و Dump موقت زیر `/tmp` پس از اعتبارسنجی حذف شدند.

فایل Backup بخشی از بستهٔ Release نیست و نباید در Git، PR یا Archive قرار گیرد.

### Performance Smoke

آزمون `GET /api/health` در Windows Staging:

| معیار | نتیجه |
|---|---:|
| Requests | 100 |
| Concurrency | 10 |
| Success | 100/100 |
| Error rate | 0% |
| Median | 30.44 ms |
| p95 | 594.95 ms |
| Max | 708.99 ms |

این نتیجه یک Smoke/Load محدود روی Health endpoint است و جایگزین Capacity Planning تولید نیست.

### Tests و Dependency Security

- Windows با `TZ=UTC`: **288/288 Pass**.
- `npm audit` در Registry رسمی: **0 vulnerability**.
- تست‌های Auth/Session/CSRF، Permission/Scope، PM D1/D1.2، Equipment، Server-only و D2 پاس شدند.
- هیچ تستی برای موفق نشان‌دادن نتیجه، دادهٔ عملیاتی جعلی ایجاد نکرد.

### Image Evidence

- Docker build استاندارد برای `f5b5662` موفق شد.
- Local tag: `bfg-cmms-app:f5b5662`
- Build manifest digest: `sha256:007a6faa32e349c5991e5115b121fa17c2c2c4ce6b289b1d057628869ca481c7`
- Image موقت D1.2 به‌علت خطای `403` Docker Hub از Base محلی ساخته شده بود.
- پس از بازیابی Docker Hub، Image نهایی D2 با Dockerfile استاندارد ساخته شد.
- **هیچ شاهدی برای Push شدن Image محلی به Registry وجود ندارد و این گزارش چنین ادعایی نمی‌کند.**

## Deferred

موارد زیر در Phase 3-A E3 تکمیل‌شده محسوب نمی‌شوند:

- استقرار Production و هرگونه تغییر دادهٔ Production.
- Merge به `main` یا فعال‌سازی Auto-merge.
- Release Tag یا GitHub Release.
- Push کردن Docker Image به Registry.
- Android packaging/signing یا پذیرش Android.
- راه‌اندازی یا تأیید نهایی HTTPS، DNS و Production reverse proxy.
- Capacity/soak test کامل Production؛ فقط Health smoke ثبت شده است.
- معماری آیندهٔ DeepSeek، Gemini و Selene؛ این موضوع خارج از Phase 3-A E3 است و در این گزارش تکمیل‌شده تلقی نمی‌شود.

## Manual approval still required

پیش از خروج PR از Draft یا هر Merge، موارد زیر باید دستی تأیید شوند:

- [ ] بازبینی Code و Security تغییرات PM و D2.
- [ ] تطبیق SHA-256 بستهٔ Staging با Sidecar و Manifest.
- [ ] تأیید اینکه Archive فقط از فایل‌های tracked در Commit نهایی ساخته شده و Secret/Backup/Runtime data ندارد.
- [ ] تأیید DBA برای Backup، Restore Drill و قرارداد یک‌طرفهٔ Occurrence/Work Order.
- [ ] تأیید Product Owner برای نتیجهٔ PM UI UAT و رفتار دقیق `N/A`.
- [ ] تأیید Release Manager برای Merge جداگانه و برنامهٔ Production deployment/rollback.
- [ ] تأیید مستقل HTTPS/DNS/Registry در صورت قرارگرفتن در دامنهٔ Release بعدی.

تا تکمیل این Checklist، **PR باید Draft بماند و Merge ممنوع است.**

## مرز بستهٔ Staging

بسته پس از Commit مستندات E3 و از همان HEAD نهایی با روش tracked-files-only ساخته می‌شود. موارد زیر از بسته حذف می‌شوند: metadata گیت، Secretها و فایل‌های Environment دارای مقدار، Override محلی Preview، Backup/Dump، `node_modules`، Log، Cookie/Token، Local config و دادهٔ عملیاتی تولیدشده. Manifest و Sidecar checksum کنار بسته، مرجع نهایی نام فایل، اندازه و SHA-256 هستند.
