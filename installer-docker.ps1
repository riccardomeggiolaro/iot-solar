<#
==============================================================
 Installer Docker per IoT-Solar su Windows (Docker Desktop + WSL2)

 Uso (PowerShell come Amministratore, dalla cartella estratta da iot-solar-docker.zip):
     Set-ExecutionPolicy -Scope Process Bypass
     .\installer-docker.ps1            # scarica l'immagine da ghcr.io (privato)
     .\installer-docker.ps1 -Build     # costruisce l'immagine dal codice sorgente

 Rilanciarlo su un'installazione esistente la AGGIORNA all'ultima versione
 mantenendo configurazione, storico e utenti.

 Cosa fa:
   1. verifica/installa WSL2 e Docker Desktop (via winget)
   2. crea .env con cartelle dati locali e password iniziale casuale per "admin"
   3. apre la porta web nel firewall di Windows
   4. scarica l'immagine da ghcr.io (o la costruisce) e avvia il container
==============================================================
#>
param([switch]$Build)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Info($m)  { Write-Host "[INFO] $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Fail($m)  { Write-Host "[ERROR] $m" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail "Esegui PowerShell come Amministratore" }

# --- 1. WSL2 e Docker Desktop ---------------------------------
$wslOk = $false
try { wsl --status *> $null; $wslOk = ($LASTEXITCODE -eq 0) } catch {}
if (-not $wslOk) {
    Info "Installazione di WSL2..."
    wsl --install --no-distribution
    Warn "WSL2 installato: RIAVVIA il PC e rilancia questo script."
    exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "winget non disponibile: installa Docker Desktop da https://www.docker.com/products/docker-desktop/ e rilancia lo script"
    }
    Info "Installazione di Docker Desktop..."
    winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
    Warn "Docker Desktop installato: RIAVVIA il PC, apri Docker Desktop una volta (accetta i termini) e rilancia questo script."
    exit 0
}

Info "Attendo che Docker sia pronto..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    if ($i -eq 0) {
        $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
        if (Test-Path $dd) { Start-Process $dd }
    }
    Start-Sleep -Seconds 5
}
if (-not $ready) { Fail "Docker non risponde: apri Docker Desktop e rilancia lo script" }

# --- 2. File .env ---------------------------------------------
$firstInstall = -not (Test-Path "docker-data\config\config.json")
$defaults = @{ IOT_SOLAR_IMAGE = "ghcr.io/riccardomeggiolaro/iot-solar"; IOT_SOLAR_TAG = "latest" }
if (Test-Path ".env.example") {
    Get-Content ".env.example" | Where-Object { $_ -match '^\s*(IOT_SOLAR_IMAGE|IOT_SOLAR_TAG)=(.*)$' } | ForEach-Object { $defaults[$Matches[1]] = $Matches[2].Trim() }
}

if (-not (Test-Path ".env")) {
    $chars = [char[]]"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    $adminPassword = -join (1..10 | ForEach-Object { $chars | Get-Random })
    @"
# Generato da installer-docker.ps1
COMPOSE_FILE=docker-compose.yml;docker-compose.windows.yml
IOT_SOLAR_IMAGE=$($defaults["IOT_SOLAR_IMAGE"])
IOT_SOLAR_TAG=$($defaults["IOT_SOLAR_TAG"])
TZ=Europe/Rome

# Cartelle persistenti (relative alla cartella del progetto)
IOT_SOLAR_CONFIG_DIR=./docker-data/config
IOT_SOLAR_DATA_DIR=./docker-data/data

# Porta della dashboard sul PC Windows
IOT_SOLAR_HTTP_PORT=8080

# Password iniziale dell'utente "admin" (usata solo al primo avvio)
IOT_SOLAR_ADMIN_PASSWORD=$adminPassword
"@ | Set-Content -Path ".env" -Encoding ascii
    Info "Creato .env"
} else {
    Info "Uso il file .env esistente"
}

$envMap = @{}
Get-Content ".env" | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $envMap[$Matches[1]] = $Matches[2].Trim() }
$httpPort = if ($envMap["IOT_SOLAR_HTTP_PORT"]) { $envMap["IOT_SOLAR_HTTP_PORT"] } else { "8080" }
$adminPassword = $envMap["IOT_SOLAR_ADMIN_PASSWORD"]

New-Item -ItemType Directory -Force -Path "docker-data\config","docker-data\data" | Out-Null

# --- 3. Firewall ----------------------------------------------
if (-not (Get-NetFirewallRule -DisplayName "IoT-Solar HTTP" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "IoT-Solar HTTP" -Direction Inbound -Protocol TCP -LocalPort $httpPort -Action Allow | Out-Null
    Info "Regola firewall creata: IoT-Solar HTTP (TCP $httpPort)"
}

# --- 4. Immagine e avvio --------------------------------------
if ($Build) {
    if (-not (Test-Path "Dockerfile")) { Fail "-Build richiede il codice sorgente completo (Dockerfile non trovato)" }
    Info "Build dell'immagine e avvio del container (la prima volta richiede alcuni minuti)..."
    docker compose up -d --build
} else {
    Info "Download dell'immagine da ghcr.io..."
    docker compose pull
    if ($LASTEXITCODE -ne 0) {
        Warn "Download non riuscito: il registry e' privato, serve il login a ghcr.io"
        Write-Host "Serve un token GitHub (classic) con il solo permesso read:packages:"
        Write-Host "  GitHub > Settings > Developer settings > Personal access tokens"
        $ghUser = Read-Host "Utente GitHub"
        $secure = Read-Host "Token" -AsSecureString
        $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        $token | docker login ghcr.io -u $ghUser --password-stdin
        if ($LASTEXITCODE -ne 0) { Fail "Login a ghcr.io non riuscito" }
        docker compose pull
        if ($LASTEXITCODE -ne 0) { Fail "Download dell'immagine non riuscito" }
    }
    docker compose up -d --no-build
}
if ($LASTEXITCODE -ne 0) { Fail "docker compose non e' riuscito: controlla l'output sopra" }

# --- 5. Verifica ----------------------------------------------
Info "Attendo l'avvio del servizio..."
$version = $null
for ($i = 0; $i -lt 30; $i++) {
    try { $version = (Invoke-RestMethod -Uri "http://localhost:$httpPort/api/version" -TimeoutSec 3).version; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $version) { Fail "Il servizio non risponde sulla porta $httpPort`: docker compose logs" }

Write-Host "========================================"
Write-Host "IoT-Solar $version installato e avviato"
Write-Host "========================================"
Write-Host "Dashboard:  http://localhost:$httpPort/"
if ($firstInstall) {
    Write-Host ""
    Write-Host "Primo accesso:  utente admin   password $adminPassword"
    Write-Host "(al primo accesso verra' chiesto di cambiarla)"
    Write-Host "L'impianto e' inizialmente SIMULATO: collega gli inverter reali da Configurazione."
}
Write-Host ""
Write-Host "Comandi utili (da questa cartella):"
Write-Host "  docker compose logs -f      log"
Write-Host "  docker compose restart      riavvio"
Write-Host "  docker compose down         stop"
Write-Host "  .\installer-docker.ps1      aggiornamento all'ultima versione"
Write-Host ""
Write-Host "Per l'avvio automatico: Docker Desktop > Settings > General > 'Start Docker Desktop when you sign in'"
