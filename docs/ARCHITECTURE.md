# Architettura IoT-Solar

## Panoramica

```
 campo                              gateway IoT-Solar (PC industriale / mini PC / Docker)
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
| `app_api` | REST + dashboard | `app_api` |

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
- [ ] Autenticazione utenti (riusare lo schema di iot-weight)
- [ ] Report PDF mensile di rendimento (WeasyPrint, come iot-weight)

### V2 – Gestionale installatore
- Server cloud multi-impianto: i gateway inviano i dati via MQTT (come `md_message_broker`)
- Anagrafica clienti/impianti, interventi generati dagli allarmi con priorità per € persi
- App mobile per il tecnico: checklist intervento, foto, firma

### V3 – Ottimizzazione energetica
- Previsione di produzione a 48 h, gestione batterie e colonnine EV
- Spostamento dei carichi aziendali sulle ore di sole, calcolo del risparmio
