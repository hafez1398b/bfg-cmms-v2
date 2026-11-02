# راهنمای استقرار سامانه CMMS روی Windows Server 2022

این راهنما دستورهای عمومی استقرار را ثبت می‌کند؛ نتیجهٔ Windows Staging در `docs/PHASE-3A-RELEASE-READINESS-FA.md` آمده است. این فایل شامل Credential یا مقدار واقعی Environment نیست.

## پیش‌نیازها

- Windows Server 2022
- Node.js 20 LTS
- PostgreSQL و ابزارهای `psql`، `pg_dump` و `pg_restore`
- IIS/Reverse Proxy سازمانی در صورت نیاز
- فضای محلی امن برای Backup

## 1. انتقال بسته و کنترل checksum

بستهٔ تأییدشده را در یک مسیر محلی مانند `C:\bfg-cmms` Extract کنید. پیش از نصب، SHA-256 فایل ZIP را با Sidecar منتشرشده مقایسه کنید:

```powershell
Get-FileHash -Algorithm SHA256 .\bfg-cmms-phase3a-staging-<commit>.zip
```

در صورت اختلاف checksum ادامه ندهید.

## 2. تنظیم Secretها و Environment

Environment موردنیاز را فقط در Secret Store سازمان، Service account یا فایل محلی خارج از Git تنظیم کنید. فایل واقعی `.env`، Connection String، Password، Token، Cookie و کلیدهای AI نباید در Git، بستهٔ Staging، Log یا تیکت قرار گیرند.

نام متغیرهای لازم در `.env.example` مستند شده است. مقدار واقعی آن‌ها را در Command line یا خروجی کنسول چاپ نکنید.

## 3. نصب وابستگی‌ها

از Lockfile رسمی استفاده کنید:

```powershell
Set-Location C:\bfg-cmms
npm ci
```

برای Staging/Release از `npm install` که می‌تواند Lockfile را تغییر دهد استفاده نکنید.

## 4. پایگاه تازه یا به‌روزرسانی پایگاه موجود

### پایگاه تازه

فقط برای Database خالی و تازه، Schema کامل را اجرا کنید:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -d bfg_cmms -f "C:\bfg-cmms\schema.sql"
```

Authentication پایگاه باید از مکانیزم امن PostgreSQL/Service account انجام شود؛ Password را به دستور اضافه نکنید.

### پایگاه موجود

`schema.sql` را روی پایگاه عملیاتی موجود به‌عنوان جایگزین Migration runner اجرا نکنید. ابتدا Backup محلی Custom-format تهیه و checksum آن را ثبت کنید:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "C:\secure-backups\bfg-cmms-pre-update-$stamp.dump"
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" --format=custom --file=$backup --dbname=bfg_cmms
Get-FileHash -Algorithm SHA256 $backup
```

سپس Runner رسمی را با مسیر همان Backup اجرا کنید:

```powershell
npm run update:apply -- $backup
```

فرم مستقیم و معادل Runner:

```powershell
node scripts/apply-update.js $backup
```

Runner فقط Migrationهای شماره‌دار Pending را اجرا می‌کند، Backup محلی را کنترل می‌کند و نتیجه را در `schema_migrations` ثبت می‌کند. اجرای دوم باید Migration اعمال‌شده را Skip کند. اگر Backup وجود ندارد، checksum نامعتبر است، Migration خطا می‌دهد یا Health آماده نیست، ادامهٔ استقرار متوقف شود؛ Migration را دستی دور نزنید.

## 5. ایجاد مدیر اولیه

فقط در نصب تازه، پس از تنظیم امن Password اولیه در Environment محلی:

```powershell
npm run provision:admin
```

Password پیش‌فرض یا مشترک استفاده نکنید و مقدار Password را در مستندات یا Log قرار ندهید.

## 6. اجرای سرویس

برنامه باید با Service account محدود و Process Manager مورد تأیید سازمان اجرا شود. نمونهٔ PM2:

```powershell
pm2 start server.js --name "bfg-cmms"
pm2 save
```

پورت Backend را فقط برای Reverse Proxy یا شبکهٔ داخلی مجاز کنید. تنظیم نهایی HTTPS، DNS و Certificate یک تأیید مستقل عملیاتی است و صرف اجرای این دستورها تکمیل آن را اثبات نمی‌کند.

## 7. کنترل سلامت

پس از Start یا Update:

```powershell
Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:8080/api/health"
```

پاسخ آماده باید این قرارداد را داشته باشد:

```json
{"status":"ready","database":true,"schemaReady":true}
```

همچنین نسخهٔ App/API را از Runtime config کنترل کنید و تست‌های Release را با timezone مورد تأیید اجرا کنید:

```powershell
$env:TZ = 'UTC'
npm test
npm audit --registry=https://registry.npmjs.org
```

هیچ Header احراز هویت، Cookie یا Token را هنگام ثبت خروجی تست چاپ نکنید.

## 8. Restore Drill

Restore Drill باید فقط در Database موقت و جدا از Database عملیاتی انجام شود. قبل از `pg_restore` نام مقصد را دو بار کنترل کنید. پس از تأیید Schema، Migration ledger و قراردادهای کلیدی، Database موقت و فایل‌های موقت حذف شوند؛ Backup اصلی پیش از Migration حفظ می‌شود.

بازیابی روی Database عملیاتی فقط با Change approval و Runbook بازگشت مجاز است. `schema_migrations` را دستی حذف یا بازنویسی نکنید.

## 9. Reverse Proxy و Firewall

IIS/Reverse Proxy باید Same-origin، محدودیت اندازه، Timeout و Headerهای امنیتی را مطابق سیاست سازمان اعمال کند. بازکردن مستقیم پورت Backend روی اینترنت مجاز نیست. وضعیت HTTPS/DNS باید جداگانه و دستی تأیید شود.
