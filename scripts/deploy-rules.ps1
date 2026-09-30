# ============================================================================
# Deploy the prototype-posture Firestore rules to your live project.
# Run this once to unblock all prototype writes (doctor Break toggle,
# daily token limit, front-desk issue, feedback, etc.).
#
#   node scripts/deploy-rules.ps1          # or: powershell scripts/deploy-rules.ps1
#
# What it does:
#   1. Installs firebase-tools globally (required once).
#   2. Opens `firebase login` in your browser (required once).
#   3. Deploys ONLY Firestore rules (firestore.rules).
#
# NOTE: this deploys the PROTOTYPE posture on purpose. The hardened
# default-deny policy stays in firestore.rules.target and must only be
# deployed TOGETHER with the Functions backend at the migration gate
# (see PRODUCTION_READINESS.md). 
# ============================================================================

$ErrorActionPreference = 'Stop'
$project = if ($env:TOKSPOT_FIREBASE_PROJECT) { $env:TOKSPOT_FIREBASE_PROJECT } else { 'tokenonspot' }

Write-Host "==> Checking firebase CLI..." -ForegroundColor Cyan
if (-not (Get-Command firebase -ErrorAction SilentlyContinue)) {
  Write-Host "    firebase not found. Installing firebase-tools globally (npm)..." -ForegroundColor Yellow
  npm install -g firebase-tools
}

Write-Host "==> Checking login (opens browser when needed)..." -ForegroundColor Cyan
firebase login

Write-Host "==> Deploying Firestore rules to project: $project" -ForegroundColor Cyan
firebase use $project --project $project
firebase deploy --only firestore:rules --project $project

Write-Host "==> Done. Rules now allow signed-in prototype clients to write." -ForegroundColor Green
Write-Host "    (doctor Break toggle, daily limit, token issue, feedback should all work now)" -ForegroundColor Green