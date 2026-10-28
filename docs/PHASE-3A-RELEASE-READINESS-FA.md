# گزارش آمادگی انتشار Phase 3-A

**وضعیت موقت انتشار: Not Ready** — آزمون‌های Regression همسان شدند و کل مجموعه تست پاس است؛ اما ممیزی وابستگی‌ها Critical/High گزارش می‌کند و تأیید PostgreSQL، Load Test و نسخهٔ Backup ویندوزی از Arena ممکن نیست.

## مبنا و تغییرات E1

- **Branch:** `arena/dab53c60-bfg-cmms-v2`
- **Commit مبنا:** `c5c99e265fc85a322a04637fb7c8491593b665bb` (`feat(pm): add phase 3a due and occurrence interface`)
- **Commit E1:** `5e4f41b` (`test(pm): align regression suite with migration 018`).
- E1 فقط Assertionهای Regression مربوط به Migration list و ترتیب/قرارداد schema را به قرارداد مصوب 018 همسان کرد. Migration 017 و 018، `schema.sql`، Backend و Frontend تغییر نکرده‌اند.

## دلیل شکست‌های قبلی

دو Assertion قدیمی از زمانی مانده بودند که Migration 017 آخرین نسخهٔ شماره‌دار بود:

1. تست Migration 017 کل ادامهٔ `schema.sql` را با فایل 017 برابر می‌گرفت؛ درحالی‌که قرارداد مصوب 018 اکنون پس از بلوک 017 به `schema.sql` افزوده شده است. تست اکنون مرز 018 را پیدا می‌کند، برابری کامل بلوک 017 را جداگانه حفظ می‌کند و سپس ترتیب و برابری کامل بلوک 018 را می‌سنجد.
2. تست Migration list نسخه‌ها را تا 017 محدود کرده بود. اکنون 018 را نیز به‌عنوان آخرین فایل شماره‌دار و با نام دقیق قرارداد انتظار دارد.

هیچ تستی حذف یا Skip نشده و Assertionهای صحت 017/018 تضعیف نشده‌اند. Contract اختصاصی 018 همچنان کنترل می‌کند که `pm_occurrences.work_order_id` و رابطهٔ معکوس وجود نداشته باشد؛ لینک canonical از سمت `work_orders.occurrence_id` است.

## نتایج آزمون

| بررسی | نتیجه |
|---|---:|
| `test/pm-phase3a-schema-contract.test.js` | **5/5 Pass** |
| `test/pm-phase3a.test.js` | **10/10 Pass** |
| B3 و B4 (`test/pm-phase3a-b3.test.js`, `test/pm-phase3a-b4.test.js`) | **24/24 Pass** |
| Route / Permission / Scope گام C | **9/9 Pass** |
| Frontend D و Dashboard | **10/10 Pass** |
| Auth / Session / CSRF | **8/8 Pass** |
| Server-only / localStorage | **5/5 Pass** |
| Regressionهای Migration 017 و Module Registry اصلاح‌شده | **16/16 Pass** |
| `npm test` کامل | **268 Pass, 0 Fail, 0 Skip** |
| Syntax فایل‌های JavaScript تغییرکرده در E1 | **Pass**؛ هر سه فایل تست با `node --check` بررسی شدند |
| `git diff --check` | **Pass** |

هیچ PostgreSQL runtime در محیط Arena در دسترس نبود: `DATABASE_URL` و `PGHOST` تنظیم نیستند؛ `pg_isready`، `psql` و Docker نیز موجود نیستند. بنابراین این نتایج تست‌های خودکار/قراردادی‌اند و به‌تنهایی اجرای واقعی Migration روی PostgreSQL را اثبات نمی‌کنند.

## ممیزی وابستگی‌های تولید

فرمان `npm audit --omit=dev` اجرا شد و با Exit Code 1، **4 آسیب‌پذیری** گزارش کرد:

- **Critical: 1** — `proxy-addr`، GHSA-jqcg-44mw-7w3h (IP spoofing در trust subnetهای IPv4-mapped IPv6)
- **High: 1** — `body-parser`، GHSA-27r3-jxmh-p828 (Denial of Service پس از بایت‌های انتهایی بدنهٔ فشرده)
- **Moderate: 2** — `qs` و زنجیرهٔ وابستگی مصرف‌کنندهٔ آن (`express`)

`npm audit fix` اجرا نشده است. رفع آسیب‌پذیری‌ها نیازمند بررسی و تغییر وابستگی در کار جداگانه است؛ تا آن زمان تصمیم موقت انتشار **Not Ready** باقی می‌ماند.

## PostgreSQL، بار و Backup

- **PostgreSQL runtime:** **Blocked** — در Arena سرور/سرویس PostgreSQL، client یا تنظیم اتصال وجود ندارد؛ مهاجرت و rollback روی پایگاه واقعی اجرا نشد.
- **Load Test:** **Blocked** — به runtime PostgreSQL و محیط آزمون بار متصل نیاز دارد؛ ابزار load-test نیز در Arena نصب/در دسترس نیست.
- **Backup روی Windows:** **Unverified / Blocked** — مسیر یا artifact مربوط به Backup ویندوزی در workspace قابل دسترسی پیدا نشد و فایل‌سیستم Windows از Arena قابل مشاهده نیست. مسئول Release باید وجود، زمان، checksum و قابلیت Restore آن را خارج از Arena تأیید کند. هیچ Backup یا دادهٔ عملیاتی ساخته نشده است.

## تصمیم و مراحل باقی‌ماندهٔ E2

تصمیم موقت: **Not Ready for Release** تا رفع موارد زیر:

1. تأیید Backup واقعی روی Windows، ثبت مسیر و checksum، و Restore آزمایشی در مقصد امن.
2. اجرای Migration 018 و تست Route/Permission/Scope روی PostgreSQL آزمایشی پس از Backup و ثبت نتیجهٔ rollback.
3. اجرای Load Test روی محیط نزدیک به عملیاتی و ثبت معیارها/خطاها.
4. بررسی و رفع جداگانهٔ Critical/Highهای `npm audit --omit=dev` بدون اجرای خودکار `npm audit fix` و سپس ممیزی مجدد.
5. بازبینی Release Readiness و تصمیم نهایی انتشار. **E2 در این مرحله شروع نشده است.**
