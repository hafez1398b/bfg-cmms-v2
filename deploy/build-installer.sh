#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
output="${1:-bfg-cmms-company-installer.tar.gz}"
temporary="$(mktemp /tmp/bfg-cmms-installer.XXXXXX.tar.gz)"
trap 'rm -f "$temporary"' EXIT
rm -f "$output" "${output}.sha256"
tar --exclude='.git' --exclude='.env' --exclude='.env.*' --exclude='node_modules' --exclude='backups' --exclude='*.log' --exclude='*.patch' --exclude='*.tar.gz*' --transform='s,^,bfg-cmms-company-installer/,' -czf "$temporary" .
mv "$temporary" "$output"
sha256sum "$output" > "${output}.sha256"
echo "Installer: $output"
echo "Checksum: ${output}.sha256"
