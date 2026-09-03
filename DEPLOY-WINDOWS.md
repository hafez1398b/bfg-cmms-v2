# راهنمای استقرار سامانه CMMS روی Windows Server 2022

## پیشنیازها
- Windows Server 2022
- Node.js 20 LTS
- PostgreSQL 18
- IIS (برای Reverse Proxy)

## مراحل استقرار

### 1. نصب Node.js
- دانلود از https://nodejs.org/en/download/
- نصب با گزینههای پیشفرض

### 2. نصب PostgreSQL 18
- دانلود از https://www.postgresql.org/download/windows/
- نصب با گزینههای پیشفرض
- رمز عبور برای کاربر postgres تعیین کنید

### 3. انتقال فایلهای پروژه
- فایلهای پروژه را به پوشه C:\bfg-cmms کپی کنید

### 4. تنظیم .env
- فایل .env را بر اساس .env.example بسازید و ویرایش کنید:
  DATABASE_URL=postgres://postgres:your_password@localhost:5432/bfg_cmms
  JWT_SECRET=<خروجی دستور: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
- دیتابیس را بسازید: C:\Program Files\PostgreSQL\18\bin\psql.exe -U postgres -c "CREATE DATABASE bfg_cmms"

### 5. نصب وابستگیها
- cd C:\bfg-cmms
- npm install

### 6. اجرای Schema
- ✨ به‌صورت خودکار هنگام استارت سرور اعمال می‌شود.
- اجرای دستی (اختیاری): C:\Program Files\PostgreSQL\18\bin\psql.exe -U postgres -d bfg_cmms -f C:\bfg-cmms\schema.sql

### 7. اولین ورود
- وارد شوید با: admin / 1234
- در اولین ورود، داده‌ها (کاربران و اطلاعات پایه) به‌صورت خودکار روی سرور seed می‌شوند.
- بلافاصله رمز admin را از ماژول «کاربران و نقش‌ها» تغییر دهید.
- (اختیاری) ساخت admin سفارشی بدون داده دمو: node create-admin.js

### 8. اجرای سامانه با PM2
- npm install -g pm2
- pm2 start server.js --name "bfg-cmms"
- pm2 save
- pm2 startup

### 9. پیکربندی IIS (Reverse Proxy)
1. IIS Manager را باز کنید
2. Application Request Routing (ARR) را نصب کنید
3. URL Rewrite را نصب کنید
4. وبسایت جدید با پورت 80 ایجاد کنید
5. web.config را در پوشه public قرار دهید

### 10. پیکربندی فایروال
- پورت 80 را باز کنید:
  New-NetFirewallRule -DisplayName "HTTP" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow

## تست نهایی
- مرورگر را باز کنید: http://server-ip
- ورود با: admin / admin123

## پشتیبانگیری
- روزانه از دیتابیس پشتیبان بگیرید:
  pg_dump -U postgres -d bfg_cmms -f "C:\backup\bfg_cmms_$(Get-Date -Format 'yyyyMMdd').sql"
