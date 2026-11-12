# Architettura KINETRA Energia

## Panoramica

```
 campo                              gateway KINETRA Energia (PC industriale / mini PC / Docker)
┌──────────────┐  Modbus TCP   ┌───────────────────────────────────────────────────────────┐
│ Inverter 1..N│──────────────▶│ md_inverter  ── SunSpecReader: scoperta modelli, polling   │
│ (SunSpec)    │               │      │                                                    │
├──────────────┤               │      ▼                                                    │
│ Piranometro  │──────────────▶│ md_monitor ── ciclo ogni N s ─┬─▶ md_database (SQLite)      │
│ (modello 302)│               │                               ├─▶ md_analysis (atteso, pari)│
└──────────────┘               │                               └─▶ md_alarms (isteresi, €,   │
                               │                                              webhook)      │
 sviluppo/demo                 │ applications/app_api ── FastAPI: /api/*, dashboard         │
┌──────────────┐               │                                                            │
│ md_simulator │ (stesso processo, porta Modbus locale, guasti iniettabili)                 │
└──────────────┘               └───────────────────────────────────────────────────────────┘
```

La struttura ricalca quella di iot-weight: `modules/md_*` per i moduli
indipendenti e `applications/` per l'API. A differenza di iot-weight tutto gira in un unico
event loop **asyncio**, senza thread: lettura Modbus, API e simulatore convivono senza lock globali.

| Modulo | Ruolo | Corrispondente in iot-weight |
|---|---|---|
| `md_sunspec` | mappa registri SunSpec, codifica/decodifica | protocolli dei terminali di pesatura |
| `md_inverter` | client Modbus TCP, scoperta automatica dei modelli | `md_weigher` |
| `md_simulator` | impianto virtuale Modbus | – |
| `md_analysis` | modello solare, produzione attesa, anomalie | – |
| `md_alarms` | ciclo di vita degli allarmi, notifiche | – |
| `md_database` | storico misure e allarmi | `md_database` |
| `md_monitor` | orchestrazione del ciclo di lettura | `main.py` + thread |
| `md_auth` | utenti, password bcrypt, token JWT, livelli | `utils_auth` + middleware |
| `md_report` | report mensile PDF (reportlab) | `utils_report` (WeasyPrint) |
| `md_runtime` | schema di config.json, applicazione delle modifiche senza riavvio | `lb_config` |
| `app_api` | REST + pagine web | `app_api` |
| `static/` | interfaccia: `index.html`, `login.html`, `css/`, `js/` (moduli ES), `img/` | `static/ui-v2` |

## Acquisizione dati

- **SunSpec** è lo standard Modbus dell'industria FV: all'indirizzo 40000 (o 50000, o 0) si trova il
  marcatore `SunS`, seguito da una catena di modelli `[ID, lunghezza, registri…]`. Il lettore scopre
  i modelli una sola volta, poi legge solo i blocchi necessari.
- Modelli gestiti: **1** (anagrafica), **101/102/103** (inverter mono/split/trifase, interi con
  fattore di scala), **302** (irraggiamento).
- Le richieste verso lo stesso host:porta sono **serializzate**: dietro un gateway Modbus TCP/RS485
  il bus è half-duplex. Un dispositivo che non risponde viene marcato subito e non blocca gli altri
  più di un timeout.

## Analisi

Ogni ciclo l'analizzatore produce delle *condizioni* con tre esiti: anomalia, ok, non valutabile.
Lo stato "non valutabile" (notte, irraggiamento basso, inverter limitato dalla rete) non apre e non
chiude gli allarmi: così non si hanno falsi rientri al tramonto.

1. **Atteso da sensore**: `P_attesa = kWp × POA × derate` (derate ≈ 0,85 tiene conto di temperatura,
   cavi ed efficienza inverter; si tara sul singolo impianto). Allarme se lo scostamento supera il 20%.
2. **Confronto tra pari**: potenza specifica (kW/kWp) di ogni inverter rispetto alla mediana degli
   altri. Allarme se è inferiore del 15%. È la verifica più robusta: nuvole, stagione e sensore
   sporco colpiscono tutti allo stesso modo e si annullano.
3. **Impianto**: se *tutti* gli inverter sono sotto l'atteso ma tra loro sono allineati, il problema è
   comune (sporco generalizzato) o è il sensore a sbagliare.

Il suggerimento sulla causa dipende dall'entità del calo: oltre il 90% sezionatori/fusibili, tra il 35% e il 90%
stringa o MPPT fuori servizio, sotto il 35% sporco/ombra/degrado.

**Energia persa**: integrale nel tempo di `max(atteso − reale, 0)`, salvato per ogni allarme e per
giornata, e convertito in € con il prezzo dell'energia configurato.

## Interfaccia

Stessa struttura e stessi componenti di KINETRA Pesatura (`ui-v2` di iot-weight):
- nessuna compilazione e nessuna libreria esterna (funziona senza internet), moduli JavaScript ES;
- guscio `index.html` con menu laterale (barra in basso su telefono), barra in alto con titolo e
  indicatori di stato, tema chiaro/scuro; accesso su `login.html` (`/login`);
- `css/app.css` (colori come token, layout), `css/data.css` (schede, tabelle, finestre, impostazioni)
  ripresi da iot-weight; `css/energia.css` contiene solo le parti nuove (valori principali, grafici);
- `js/api.js` e `js/ui.js` come in iot-weight; `js/plant.js` aggiorna lo stato ogni 5 secondi per
  barra di stato e schermate; le viste sono in `js/views/` (Dashboard, Allarmi, Report, Impostazioni a schede).

## Utenti e sicurezza

- Password con bcrypt; sessioni con token JWT (HS256) firmati da una chiave casuale generata al primo
  avvio in `secret.key` nella cartella dati. Durata configurabile (`api.token_hours`, default 30 giorni).
- Livelli: 1 sola lettura, 2 utente (prende in carico gli allarmi), 3 amministratore (configurazione,
  utenti di livello inferiore, simulatore), 4 super admin (anche gli amministratori).
- Al primo avvio viene creato `admin` con la password di `IOT_SOLAR_ADMIN_PASSWORD`; gli installer la
  generano casuale. Chi ha una password provvisoria deve cambiarla prima di usare le API.
- Il token viaggia solo nell'header `Authorization`, mai nell'URL; il PDF si scarica con una richiesta autenticata.
- Il login risponde con `access_token`, come iot-weight.
- Recupero dell'admin: `python -m modules.md_auth.reset_admin NUOVA_PASSWORD`.

## Configurazione dal web

`PUT /api/config` valida la configurazione con lo schema pydantic di `md_runtime/settings.py`
(coordinate, kWp obbligatori per gli inverter, nomi e indirizzi Modbus non duplicati…), la salva in modo
atomico su `config.json`, poi ferma e ricrea monitor e simulatore con i nuovi parametri. Storico, allarmi
aperti e sessioni degli utenti restano. `POST /api/devices/test` prova un dispositivo prima di salvarlo.

## Energia e rendimento

- **Energia prodotta**: somma degli incrementi del contatore dell'inverter tra letture successive.
  Gli incrementi negativi (contatore azzerato, inverter sostituito) e quelli impossibili per la potenza
  misurata vengono scartati. Il contatore resta affidabile anche se il monitoraggio si ferma per qualche minuto.
- **Rendimento**: energia reale / attesa calcolate *sugli stessi intervalli*. Viene mostrato solo
  quando l'atteso è significativo (almeno 0,5 kWh/kWp).

## Distribuzione

- Immagine Docker unica per `linux/amd64` e `linux/arm64`, pubblicata privata su ghcr.io dalla GitHub
  Action `docker-image.yml`: `latest` a ogni push su `main`, `X.Y.Z` e release con lo zip di installazione
  a ogni tag `vX.Y.Z`.
- Linux: `network_mode: host`. Windows (Docker Desktop): rete bridge con la porta 8080 pubblicata.
- Cartelle persistenti: configurazione (`/etc/iot-solar`) e dati (`/var/opt/iot-solar`).
- Aggiornamento: rilanciare l'installer oppure `docker compose pull && docker compose up -d`.

## Allarmi

- Isteresi: un'anomalia deve persistere per `persist_cycles` letture prima di aprire l'allarme
  (OFFLINE e FAULT aprono subito) e sparire per 3 letture prima di chiuderlo.
- Gli allarmi aperti sopravvivono al riavvio (ricaricati dal database).
- Notifica: POST JSON al `webhook_url` (utile per Telegram/Slack/email tramite n8n, Make, ecc.).

## Roadmap

### V1 – Monitoraggio e diagnosi (questa versione)
- [x] Lettura SunSpec, storico, dashboard
- [x] Atteso da sensore e da confronto tra pari, allarmi, perdita in €
- [x] Simulatore con guasti
- [ ] Modelli SunSpec float (111/112/113) e contatori (201–204) per l'autoconsumo
- [ ] Previsione meteo (Open-Meteo) come "sensore virtuale" per gli impianti senza piranometro
- [x] Utenti con livelli, configurazione dal web, report PDF mensile, installer Linux/Windows
- [ ] Invio automatico del report via email a fine mese
- [ ] Assistenza remota (tunnel SSH come iot-weight)

### V2 – Gestionale installatore
- Server cloud multi-impianto: i gateway inviano i dati via MQTT (come `md_message_broker`)
- Anagrafica clienti/impianti, interventi generati dagli allarmi con priorità per € persi
- App mobile per il tecnico: checklist intervento, foto, firma

### V3 – Ottimizzazione energetica
- Previsione di produzione a 48 h, gestione batterie e colonnine EV
- Spostamento dei carichi aziendali sulle ore di sole, calcolo del risparmio
