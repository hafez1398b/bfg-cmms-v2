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
- فایل .env را ویرایش کنید:
  DATABASE_URL=postgres://postgres:your_password@localhost:5432/bfg_cmms

### 5. نصب وابستگیها
- cd C:\bfg-cmms
- npm install

### 6. اجرای Schema
- C:\Program Files\PostgreSQL\18\bin\psql.exe -U postgres -d bfg_cmms -f C:\bfg-cmms\schema.sql

### 7. ایجاد کاربر Admin
- node create-admin.js

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
