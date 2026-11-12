#!/bin/bash
# ==============================================================
# Installer Docker per IoT-Solar (Debian, Ubuntu, Raspberry Pi OS)
#
# Uso:   sudo ./installer-docker.sh [-y] [--build]
#   -y        modalita' non interattiva
#   --build   costruisce l'immagine dal codice sorgente invece di scaricarla
#             da ghcr.io (richiede il progetto completo con il Dockerfile)
#
# Rilanciarlo su un'installazione esistente la AGGIORNA all'ultima versione
# mantenendo configurazione, storico e utenti.
#
# Variabili per il login non interattivo al registry privato:
#   GHCR_USER, GHCR_TOKEN (token GitHub con permesso read:packages)
# ==============================================================
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
print_info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

ASSUME_YES=false
BUILD=false
for arg in "$@"; do
    case "$arg" in
        -y) ASSUME_YES=true ;;
        --build) BUILD=true ;;
        *) print_error "Opzione sconosciuta: $arg"; exit 1 ;;
    esac
done

if [ "$EUID" -ne 0 ]; then
    print_error "Questo script deve essere eseguito con sudo o come root"
    exit 1
fi

SOURCE_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTALL_DIR="/opt/iot-solar"
CONFIG_DIR="/etc/iot-solar"
DATA_DIR="/var/opt/iot-solar"
FIRST_INSTALL=false
[ -f "$CONFIG_DIR/config.json" ] || FIRST_INSTALL=true

# --- 1. Docker -------------------------------------------------
if ! command -v docker &>/dev/null; then
    print_info "Docker non trovato: installazione in corso..."
    apt-get update
    apt-get install -y ca-certificates curl
    curl -fsSL https://get.docker.com | sh
else
    print_info "Docker gia' installato: $(docker --version)"
fi
if ! docker compose version &>/dev/null; then
    print_info "Installazione del plugin docker compose..."
    apt-get update
    apt-get install -y docker-compose-plugin
fi
systemctl enable --now docker

# --- 2. File del progetto -------------------------------------
if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
    print_info "Copia dei file in $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR"
    tar -C "$SOURCE_DIR" --exclude=.git --exclude=.venv --exclude=docker-data --exclude=.env -cf - . | tar -C "$INSTALL_DIR" -xf -
fi
cd "$INSTALL_DIR"

# --- 3. Cartelle persistenti e .env ---------------------------
mkdir -p "$CONFIG_DIR" "$DATA_DIR"
if [ ! -f .env ]; then
    ADMIN_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 10)"
    sed -e "s|^IOT_SOLAR_CONFIG_DIR=.*|IOT_SOLAR_CONFIG_DIR=$CONFIG_DIR|" \
        -e "s|^IOT_SOLAR_DATA_DIR=.*|IOT_SOLAR_DATA_DIR=$DATA_DIR|" \
        -e "s|^IOT_SOLAR_ADMIN_PASSWORD=.*|IOT_SOLAR_ADMIN_PASSWORD=$ADMIN_PASSWORD|" \
        .env.example > .env
    chmod 600 .env
    print_info "Creato $INSTALL_DIR/.env"
else
    print_info "Uso il file .env esistente"
    ADMIN_PASSWORD="$(grep -E '^IOT_SOLAR_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
fi

# --- 4. Firewall ----------------------------------------------
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
    print_info "Apertura della porta 8080 nel firewall..."
    ufw allow 8080/tcp comment 'IoT-Solar'
fi

# --- 5. Immagine e avvio --------------------------------------
if [ "$BUILD" = true ]; then
    if [ ! -f Dockerfile ]; then
        print_error "--build richiede il codice sorgente completo (Dockerfile non trovato)"
        exit 1
    fi
    print_info "Build dell'immagine e avvio del container (puo' richiedere qualche minuto)..."
    docker compose up -d --build
else
    print_info "Download dell'immagine da ghcr.io..."
    if ! docker compose pull; then
        print_warning "Download non riuscito: il registry e' privato, serve il login a ghcr.io"
        echo "Serve un token GitHub (classic) con il solo permesso read:packages:"
        echo "  GitHub > Settings > Developer settings > Personal access tokens"
        if [ -z "$GHCR_USER" ]; then read -r -p "Utente GitHub: " GHCR_USER; fi
        if [ -z "$GHCR_TOKEN" ]; then read -r -s -p "Token: " GHCR_TOKEN; echo; fi
        echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
        docker compose pull
    fi
    docker compose up -d --no-build
fi

# --- 6. Verifica ----------------------------------------------
print_info "Attendo l'avvio del servizio..."
for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8080/api/version >/dev/null 2>&1; then break; fi
    sleep 2
done
if ! curl -fsS http://127.0.0.1:8080/api/version >/dev/null 2>&1; then
    print_error "Il servizio non risponde sulla porta 8080"
    echo "Controllare con: cd $INSTALL_DIR && docker compose logs"
    exit 1
fi
VERSION="$(curl -fsS http://127.0.0.1:8080/api/version | sed -E 's/.*"version":"([^"]*)".*/\1/')"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "========================================"
echo "IoT-Solar $VERSION installato e avviato"
echo "========================================"
echo "Dashboard:  http://${IP:-<ip-macchina>}:8080/"
if [ "$FIRST_INSTALL" = true ]; then
    echo ""
    echo "Primo accesso:  utente admin   password $ADMIN_PASSWORD"
    echo "(al primo accesso verra' chiesto di cambiarla)"
    echo "L'impianto e' inizialmente SIMULATO: collega gli inverter reali da Configurazione."
fi
echo ""
echo "Comandi utili (da $INSTALL_DIR):"
echo "  Log:        docker compose logs -f"
echo "  Riavvio:    docker compose restart"
echo "  Stop:       docker compose down"
echo "  Aggiorna:   sudo ./installer-docker.sh -y   (oppure docker compose pull && docker compose up -d)"
