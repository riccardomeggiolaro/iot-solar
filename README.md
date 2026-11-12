# IoT-Solar

Monitoraggio intelligente di impianti fotovoltaici per **PMI, aziende agricole e installatori**
(impianti da 20 a 500 kWp, anche con inverter di marche diverse).

Non si limita a mostrare quanto produce l'impianto: **calcola quanto dovrebbe produrre**,
individua da solo l'inverter o la stringa che rende meno, suggerisce la causa probabile e
stima **quanti euro si stanno perdendo**, così il manutentore sa subito dove intervenire.

## Cosa fa (versione 1)

- **Lettura diretta dagli inverter** via Modbus TCP con lo standard **SunSpec**
  (SMA, Fronius, SolarEdge, Kostal, ABB/FIMER, Huawei e altri): nessun portale cloud del produttore.
- **Produzione attesa** per ogni inverter, con due metodi indipendenti:
  - dal **sensore di irraggiamento** (piranometro/cella di riferimento, modello SunSpec 302);
  - dal **confronto tra inverter**: chi rende molto meno della mediana degli altri ha un problema
    suo. Funziona anche senza sensore e con il cielo nuvoloso.
- **Allarmi** con isteresi (niente falsi allarmi per una nuvola) e notifica via webhook:
  dispositivo offline, inverter in FAULT, sovratemperatura, rendimento sotto l'atteso o sotto i pari,
  calo uniforme di tutto l'impianto (sporco generalizzato o sensore da pulire).
- **Perdita in €** per ogni allarme e per la giornata.
- **Dashboard web** che funziona anche senza internet, e **API REST**.
- **Utenti con livelli** (sola lettura, utente, amministratore, super admin) come iot-weight.
- **Configurazione dal web**: impianto, inverter (con pulsante *Prova connessione*), soglie degli
  allarmi. Le modifiche si applicano senza riavviare.
- **Report PDF mensile** per il cliente: energia prodotta e attesa, rendimento, euro persi, allarmi.
- **Installer Docker** per Linux (anche Raspberry Pi) e Windows, con aggiornamento a un comando.
- **Simulatore** integrato di un impianto completo, con iniezione di guasti, per sviluppo e demo.

## Installazione presso il cliente

Con gli installer Docker per Linux e Windows: vedi **[docs/INSTALLAZIONE.md](docs/INSTALLAZIONE.md)**.

## Avvio per sviluppo

```bash
pip install -r requirements.txt
python main.py
```

Apri <http://localhost:8080> e accedi con `admin` / `admin`: al primo accesso viene chiesto di cambiare la password.
Al primo avvio viene creato `config.json` da `config.example.json`, con un impianto **simulato** da 180 kWp
(4 inverter e un piranometro). Dal riquadro **Simulatore** in fondo alla dashboard puoi staccare stringhe,
sporcare moduli, mandare un inverter in FAULT o scollegarlo, e vedere comparire gli allarmi.

Per vedere un'intera giornata in pochi minuti: Configurazione → Simulatore → velocità 120, ora di partenza 6.

Con Docker partendo dal codice sorgente: `docker compose up -d --build`.

## Rilascio di una versione

1. Aggiorna il numero nel file `VERSION`.
2. Crea e pubblica il tag: `git tag v0.2.0 && git push origin v0.2.0`.

La GitHub Action esegue i test, costruisce l'immagine per amd64 e arm64, la pubblica **privata** su
`ghcr.io/riccardomeggiolaro/iot-solar` e crea una release con `iot-solar-docker.zip`, il pacchetto
di installazione senza codice sorgente. Ogni push su `main` aggiorna l'immagine `latest`.

## Test

```bash
pip install -r requirements-dev.txt
pytest -q
```

## Documentazione

- [docs/INSTALLAZIONE.md](docs/INSTALLAZIONE.md): installazione, primo accesso, aggiornamento, backup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architettura, algoritmi di analisi, roadmap.
- API: <http://localhost:8080/docs> (Swagger generato da FastAPI).
