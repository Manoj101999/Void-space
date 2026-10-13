# VOID·SPACE - Shutdown Script
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "Stopping Docker infrastructure..." -ForegroundColor Yellow
node scripts/dev-down.mjs

Write-Host "Services stopped." -ForegroundColor Green
