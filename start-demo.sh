#!/bin/bash
# BFG CMMS — راه‌انداز سریع دمو (بازیابی خودکار محیط)
set -e
cd "$(dirname "$0")"

# 1) فایل محیطی
if [ ! -f .env ]; then
  echo "⚙️  ساخت .env پیش‌فرض..."
  cat > .env << 'ENV'
HOST=0.0.0.0
PORT=8080
JWT_SECRET=dev_secret_change_me_in_production
DATABASE_URL=postgres://postgres:123@localhost:5432/bfg_cmms
ENV
fi

# 2) وابستگی‌ها
if [ ! -d node_modules/express ] || [ ! -d node_modules/pg-mem ]; then
  echo "📦 نصب وابستگی‌ها..."
  npm install --silent
fi

# 3) اجرا
echo "🚀 اجرای سرور روی پورت 8080 ..."
PG_MEM=1 PORT=8080 exec node server.js
