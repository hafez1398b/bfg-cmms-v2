<div dir="rtl">

# سامانه جامع نت — بسپار فوم غرب | BFG CMMS/EAM v4.0.0

سیستم یکپارچه مدیریت نگهداری و تعمیرات (CMMS) و مدیریت دارایی‌های فیزیکی (EAM) — فارسی، راست‌چین، چندکاربره با سینک لحظه‌ای.

## معماری (نسخه ۲ — Sync & Multi-User)

```
┌─────────────────────────────────────────────────────┐
│  مرورگر (public/index.html — اپ تک‌فایلی RTL)        │
│  • ۲۲ ماژول: دستورکار، PM، انبار، کالیبراسیون، PTW…  │
│  • BFG SYNC ENGINE: کش آفلاین + diff اتوماتیک        │
└──────────────┬──────────────────────┬───────────────┘
        REST /api (JWT)          Socket.IO 'sync'
┌──────────────┴──────────────────────┴───────────────┐
│  server.js (Express + Socket.IO)                     │
│  • احراز JWT + bcrypt                                │
│  • /api/bootstrap, /api/sync/:col, /api/seq/next     │
└──────────────┬──────────────────────────────────────┘
┌──────────────┴──────────────────────────────────────┐
│  PostgreSQL (schema.sql)                             │
│  • users (تایپ‌شده، رمز هش‌شده)                      │
│  • entities (JSONB سند-محور — همه ماژول‌ها)          │
│  • seq_counters (شماره‌گذاری اتمیک اسناد)             │
└─────────────────────────────────────────────────────┘
```

**مدل داده:** سرور منبع حقیقت است؛ `localStorage` فقط کش آفلاین است. هر تغییر محلی بلافاصله در کش نوشته و با تأخیر ~۱ ثانیه به‌صورت diff روی `/api/sync` ارسال می‌شود؛ تغییرات کاربران دیگر با Socket.IO لحظه‌ای اعمال می‌شود. قطعی شبکه → نوار هشدار + ادامه کار آفلاین + سینک خودکار پس از اتصال.

## اجرای سریع (دمو بدون دیتابیس)

```bash
npm install
npm run demo        # PG_MEM=1 — دیتابیس حافظه‌ای موقت
# http://localhost:8080  →  ورود: admin / 1234
```
در اولین ورود، داده‌های نمونه به‌صورت خودکار روی سرور seed می‌شوند.

## اجرای production (PostgreSQL)

```bash
createdb bfg_cmms
cp .env.example .env   # DATABASE_URL و JWT_SECRET تصادفی تنظیم کنید
npm install
npm start
```
اسکیما هنگام استارت سرور به‌صورت خودکار اعمال می‌شود (`CREATE IF NOT EXISTS`). اجرای دستی نیز ممکن است: `psql -d bfg_cmms -f schema.sql`

## API

| مسیر | توضیح |
|---|---|
| `POST /api/auth/login` | ورود → `{token, user}` |
| `GET /api/bootstrap` | دریافت همه داده‌ها (یک‌بار پس از ورود) |
| `POST /api/seed` | seed اولیه — فقط یک‌بار، وقتی سرور خالی است |
| `POST /api/sync/:collection` | `{kind, upserts:[{id,ord,data}], deletes:[ids], src}` — upsert/delete گروهی + پخش سوکت |
| `POST /api/seq/next` | `{key, cur}` → شماره بعدی سند (اتمیک، بدون تکرار در چندکاربره) |
| `POST /api/admin/reset` | (admin) پاک‌سازی داده‌ها برای seed مجدد |
| `GET /api/health` | سلامت سرویس و دیتابیس |

## نکات امنیتی

- رمزها با bcrypt هش می‌شوند و هش/رمز هرگز از API بیرون داده نمی‌شود.
- `JWT_SECRET` پیش‌فرض را حتماً تغییر دهید: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- کاربر موقت اولیه: `admin / 1234` — پس از اولین ورود، کاربران سامانه (دمو/واقعی) جایگزین می‌شوند. در محیط واقعی بلافاصله رمز admin را تغییر دهید.
- حذف خودِ مدیر و حذف آخرین مدیر فعال توسط سرور مسدود می‌شود؛ نام کاربری تکراری با خطای `username_exists` رد می‌شود.

## استقرار روی Windows Server

راهنمای کامل (Node + PostgreSQL + PM2 + IIS Reverse Proxy): [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md)

## فایل‌های مهم

| فایل | توضیح |
|---|---|
| `server.js` | بک‌اند (Express + Socket.IO + PostgreSQL/pg-mem) |
| `schema.sql` | users + entities(JSONB) + meta + seq_counters |
| `public/index.html` | کل فرانت‌اند (۲۲ ماژول) + لایه BFG SYNC ENGINE در انتهای فایل |
| `create-admin.js` | ساخت کاربر admin سفارشی (اختیاری) |
| `apply-changes.js`, `fix-and-start.js`, `manage-project.js`, `prepare-server.js` | ⚠️ اسکریپت‌های کمکی قدیمیِ مهاجرت — دیگر لازم نیستند |

## محدودیت‌های شناخته‌شده (گام‌های بعدی)

- حل تداخل ویرایش هم‌زمان یک رکورد: last-writer-wins است.
- کالکشن‌های کاربرمحور (`notifs`, `logins`, `panelCfg`…) فقط محلی می‌مانند.
- پیام‌رسان داخل ساختار `chats` سینک می‌شود؛ جداول `messages` اختصاصی در نسخه بعد.
- پیشنهاد بعدی: ارسال Web Push / ایمیل، فایل‌آپلود S3، و گزارش‌ساز SQL سمت سرور.

</div>
