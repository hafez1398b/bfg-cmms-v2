# گزارش آمادگی انتشار Phase 3-A

**Security Gate: PASS** — آسیب‌پذیری‌های Critical و High صفر شده‌اند و آزمون‌های Regression/احراز هویت پاس هستند. **وضعیت کلی انتشار: Not Ready** تا تأیید PostgreSQL واقعی، Load Test و Backup ویندوزی خارج از Arena.

## مبنا و تغییرات E1 / E1-S

- **Branch:** `arena/dab53c60-bfg-cmms-v2`
- **Commit مبنای E1-S:** `c3b87b558b538c5c8e2c5c0ca3a30e0ecb2f0e0f` (`docs(pm): finalize release readiness report`)
- **Commit E1:** `5e4f41b` (`test(pm): align regression suite with migration 018`).
- E1 فقط Assertionهای Regression مربوط به Migration list و ترتیب/قرارداد schema را به قرارداد مصوب 018 همسان کرد. Migration 017 و 018، `schema.sql`، Backend و Frontend تغییر نکرده‌اند.
- E1-S فقط `package.json`، `package-lock.json` و همین گزارش را تغییر می‌دهد؛ قابلیت محصول، route، scripts، Docker و دادهٔ عملیاتی دست‌نخورده‌اند.

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
| `npm ci` پس از به‌روزرسانی هدفمند | **Pass**؛ نصب پاک و همسان با lockfile |
| Syntax سرور | **Pass**؛ `server.js` و 32 فایل `server/*.js` |
| `git diff --check` | **Pass** |

هیچ PostgreSQL runtime در محیط Arena در دسترس نبود: `DATABASE_URL` و `PGHOST` تنظیم نیستند؛ `pg_isready`، `psql` و Docker نیز موجود نیستند. بنابراین این نتایج تست‌های خودکار/قراردادی‌اند و به‌تنهایی اجرای واقعی Migration روی PostgreSQL را اثبات نمی‌کنند.

## ممیزی و ارتقای هدفمند Dependencyهای تولید (E1-S)

`npm audit --omit=dev` پس از تغییر با Exit Code 0 تمام شد: **0 آسیب‌پذیری** (Critical 0، High 0، Moderate 0، Low 0). `npm ci` نیز نصب تمیز را با 0 آسیب‌پذیری گزارش کرد.

| Package | پیش از E1-S | پس از E1-S | Dependency path / اقدام |
|---|---:|---:|---|
| `express` (direct) | 4.22.3 | 4.22.3 | نسخهٔ 4.22.3 موجود در Registry رسمی از بازهٔ آسیب‌پذیر Express خارج است؛ در شاخهٔ 4 نسخهٔ Patch جدیدتری در Registry نبود، پس Major ارتقا انجام نشد. مسیرهای transitive آن تازه شدند. |
| `body-parser` (transitive) | 1.20.6 | 1.20.9 | `express → body-parser`; نسخهٔ 1.20.9 در بازهٔ سازگار Express (`~1.20.5`) است و GHSA-27r3-jxmh-p828 را رفع می‌کند. |
| `proxy-addr` (transitive) | 2.0.7 | 2.0.8 | `express → proxy-addr`; نسخهٔ 2.0.8 در بازهٔ سازگار (`~2.0.7`) است و GHSA-jqcg-44mw-7w3h را رفع می‌کند. |
| `qs` (transitive / override موجود) | 6.16.0 | 6.16.2 | `express → qs` و `express → body-parser → qs`; override از قبل موجود بود و فقط به Patch امن‌تر ارتقا یافت. 6.16.2 با `~6.16.0` سازگار است و GHSA-6pq8-jhm2-2vcw را رفع می‌کند. |

نسخه‌های Patch و محدوده‌های سازگاری با metadata از `registry.npmjs.org` بررسی شدند. Dependency transitive جدیدی به `dependencies` اضافه نشد؛ `express` مستقیم و scripts ثابت ماندند. `npm audit fix` و Force نصب/ارتقا اجرا نشدند.

قبل از ارتقا، مسیرهای آسیب‌پذیر این‌ها بودند: `express@4.22.3 → body-parser@1.20.6 → qs@6.16.0`، `express@4.22.3 → proxy-addr@2.0.7` و `express@4.22.3 → qs@6.16.0`. بعد از ارتقا، به‌ترتیب `body-parser@1.20.9 → qs@6.16.2` و `proxy-addr@2.0.8` نصب‌اند؛ audit خروجی آسیب‌پذیری ندارد.

## PostgreSQL، بار و Backup

- **PostgreSQL runtime:** **Blocked** — در Arena سرور/سرویس PostgreSQL، client یا تنظیم اتصال وجود ندارد؛ مهاجرت و rollback روی پایگاه واقعی اجرا نشد.
- **Load Test:** **Blocked** — به runtime PostgreSQL و محیط آزمون بار متصل نیاز دارد؛ ابزار load-test نیز در Arena نصب/در دسترس نیست.
- **Backup روی Windows:** **Unverified / Blocked** — مسیر یا artifact مربوط به Backup ویندوزی در workspace قابل دسترسی پیدا نشد و فایل‌سیستم Windows از Arena قابل مشاهده نیست. مسئول Release باید وجود، زمان، checksum و قابلیت Restore آن را خارج از Arena تأیید کند. هیچ Backup یا دادهٔ عملیاتی ساخته نشده است.

## تصمیم و مراحل باقی‌ماندهٔ E2

**Security Gate: PASS** برای Dependency audit و Regressionهای خودکار. تصمیم کلی: **Not Ready for Release** تا تکمیل بررسی‌های عملیاتی زیر:

1. تأیید Backup واقعی روی Windows، ثبت مسیر و checksum، و Restore آزمایشی در مقصد امن.
2. اجرای Migration 018 و تست Route/Permission/Scope روی PostgreSQL آزمایشی پس از Backup و ثبت نتیجهٔ rollback.
3. اجرای Load Test روی محیط نزدیک به عملیاتی و ثبت معیارها/خطاها.
4. بازبینی نهایی Release Readiness و تصمیم انتشار. **E2 در این مرحله شروع نشده است.**
