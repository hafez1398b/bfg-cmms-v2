param(
    [ValidateRange(1024,65535)][int]$Port = 3000,
    [ValidateRange(1024,65535)][int]$DatabasePort = 55439
)
$ErrorActionPreference = 'Stop'
$demo = (Get-Location).Path
if (-not (Test-Path -LiteralPath '.\compose.demo.yml') -or -not (Test-Path -LiteralPath '.\server.js')) {
    throw 'Run this script from the extracted BFG-CMMS-Local-Demo folder.'
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) { throw 'Install Node.js LTS, open a new PowerShell window, and retry.' }
$nodeMajor = & $node.Source -p "process.versions.node.split('.')[0]"
if ([int]$nodeMajor -lt 22) { throw 'Install Node.js 22 or newer, open a new PowerShell window, and retry.' }
if (-not (Test-Path -LiteralPath '.env.demo')) {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $lines = foreach ($key in @('DEMO_DB_PASSWORD', 'DEMO_JWT_SECRET', 'DEMO_ADMIN_PASSWORD')) {
            $bytes = New-Object byte[] 32
            $rng.GetBytes($bytes)
            "$key=$([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())"
        }
        $lines | Set-Content -LiteralPath '.env.demo' -Encoding ASCII
    } finally { $rng.Dispose() }
}
$values = ConvertFrom-StringData -StringData (Get-Content -LiteralPath '.env.demo' -Raw)
foreach ($key in @('DEMO_DB_PASSWORD', 'DEMO_JWT_SECRET', 'DEMO_ADMIN_PASSWORD')) {
    if ($values[$key] -notmatch '^[0-9a-f]{32,128}$') { throw "Invalid demo setting: $key" }
}
$override = '.demo-local-node.yml'
@"
services:
  database:
    ports:
      - "127.0.0.1:${DatabasePort}:5432"
"@ | Set-Content -LiteralPath $override -Encoding ASCII

& docker compose --env-file .env.demo -p bfg-cmms-local-demo -f compose.demo.yml -f $override up --build --detach --wait --wait-timeout 120 database
if ($LASTEXITCODE -ne 0) { throw 'The demo PostgreSQL container could not start. See the Docker output above.' }
& $npm.Source ci --omit=dev --offline --cache .demo-npm-cache
if ($LASTEXITCODE -ne 0) { throw 'Offline npm setup failed. Check that the original ZIP was fully extracted.' }

$env:DATABASE_URL = "postgresql://bfg_demo:$($values.DEMO_DB_PASSWORD)@127.0.0.1:${DatabasePort}/bfg_demo"
$env:JWT_SECRET = $values.DEMO_JWT_SECRET
$env:ADMIN_INITIAL_PASSWORD = $values.DEMO_ADMIN_PASSWORD
$env:ADMIN_USERNAME = 'admin'
$env:PORT = [string]$Port
$env:NODE_ENV = 'development'
$env:EXECUTION_MODE = 'server-only'
$env:ALLOW_LOCAL_COMPATIBILITY = 'false'
$env:AUTO_SEED_BESPAR1 = 'false'

& $node.Source scripts/company-bootstrap.js
if ($LASTEXITCODE -ne 0) { throw 'The demo database could not be initialized.' }

$url = "http://127.0.0.1:$Port"
$app = Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $demo `
    -RedirectStandardOutput (Join-Path $demo 'demo-node.out.log') `
    -RedirectStandardError (Join-Path $demo 'demo-node.err.log') -NoNewWindow -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ($app.HasExited) { break }
    try {
        if ((Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2).status -eq 'ready') {
            $ready = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'The app is unavailable. Check demo-node.err.log in this folder.' }
Write-Host "Demo URL: $url"
Write-Host 'Username: admin'
Write-Host "Demo password: $($values.DEMO_ADMIN_PASSWORD)"
Start-Process $url
