# VOID·SPACE - Dev Server Startup Script
$ErrorActionPreference = 'Stop'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  VOID·SPACE - Starting Local Stack" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Ensure .env exists
if (-not (Test-Path ".env")) {
    Write-Host "[1/3] Creating .env from .env.example..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
}

# 2. Ensure docker infrastructure is running
Write-Host "[2/3] Checking Docker infrastructure..." -ForegroundColor Yellow
try {
    node scripts/dev-up.mjs
} catch {
    Write-Warning "dev-up encountered an error: $_"
}

# 3. Start development servers (API on :4000, Web on :3000, Worker)
Write-Host "[3/3] Launching Turbo dev servers (API + Web + Worker)..." -ForegroundColor Green
Write-Host ""
Write-Host "Web Application will be available at:" -ForegroundColor Cyan
Write-Host "  - http://localhost:3000" -ForegroundColor White
Write-Host "  - https://localhost" -ForegroundColor White
Write-Host ""
Write-Host "Press Ctrl+C to stop all services." -ForegroundColor DarkGray
Write-Host ""

pnpm dev
