-- =====================================================================
-- BFG CMMS/EAM — PostgreSQL schema  v2 (Sync & Multi-User)
-- ---------------------------------------------------------------------
-- مدل داده:
--   users    → جدول تایپ‌شده برای احراز هویت و مدیریت کاربران
--   entities → ذخیره‌سازی سند-محور (JSONB) برای همه ماژول‌های سامانه
--   meta     → کلید/مقدار سراسری (شمارنده شماره سند، وضعیت seed و ...)
-- ساختار entities به‌گونه‌ای است که فرانت‌اند بدون تغییر در شکل آبجکت‌ها
-- کار کند و ماژول‌های جدید بدون نیاز به ALTER TABLE سینک شوند.
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'tech',
  unit       TEXT,
  phone      TEXT,
  active     BOOLEAN DEFAULT TRUE,
  hr         JSONB DEFAULT '{}'::jsonb,   -- پرونده پرسنلی (کد پرسنلی، شیفت، مهارت‌ها، 2FA و ...)
  extra      JSONB DEFAULT '{}'::jsonb,   -- سایر فیلدهای فرانت‌اند (spec و ...)
  created_at TIMESTAMPTZ DEFAULT now()
);

-- هر ردیف = یک موجودیت در یک کالکشن فرانت‌اند
CREATE TABLE IF NOT EXISTS entities (
  collection TEXT NOT NULL,                          -- نام کالکشن: wos, assets, chats, settings ...
  id         TEXT NOT NULL,                          -- شناسه موجودیت (کلید آبجکت یا id رکورد)
  ord        DOUBLE PRECISION,                      -- ترتیب در آرایه فرانت‌اند (جدیدتر = کوچک‌تر)
  kind       TEXT NOT NULL DEFAULT 'arr',            -- arr | obj | val — نوع کالکشن
  data       JSONB NOT NULL,
  seq        BIGSERIAL,                              -- ترتیب درج در سرور (tie-breaker)
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_entities_col ON entities (collection, ord ASC NULLS LAST, seq ASC);

-- کلید/مقدار سراسری: وضعیت seed و ...
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- شمارنده اتمیک شماره اسناد: wo / wr / ptw / doc / ... (سرویس POST /api/seq/next)
CREATE TABLE IF NOT EXISTS seq_counters (
  key TEXT PRIMARY KEY,
  n   INT NOT NULL DEFAULT 0
);

-- نکته: کاربر مدیر پیش‌فرض (admin / admin123) در صورت خالی بودن جدول users
-- به‌صورت خودکار هنگام استارت سرور با bcrypt ساخته می‌شود (server.js).
