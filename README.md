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
- **Simulatore** integrato di un impianto completo, con iniezione di guasti, per sviluppo e demo.

## Avvio rapido (simulatore)

```bash
pip install -r requirements.txt
python main.py
```

Apri <http://localhost:8080>. Senza `config.json` viene usato `config.example.json`, che avvia un
impianto simulato da 180 kWp (4 inverter e un piranometro). Dal riquadro **Simulatore** in fondo alla
dashboard puoi spegnere stringhe, sporcare moduli, mandare un inverter in FAULT o scollegarlo, e
vedere gli allarmi comparire.

Per una demo di un'intera giornata in pochi minuti, imposta in config `"simulator": {"speed": 120, "start_hour": 6}`.

## Su un impianto reale

1. `cp config.example.json config.json`
2. Imposta `"simulator": {"enabled": false}`.
3. In `devices` inserisci IP, porta (di solito 502), `unit_id` e kWp di ogni inverter. Abilita Modbus TCP
   / SunSpec dal menu dell'inverter (su SMA: "Modbus" attivo; su Fronius: "Data export via Modbus" con
   "float" o "int+SF"; su SolarEdge: "Modbus TCP" dal SetApp).
4. Se c'è un piranometro SunSpec, aggiungilo con `"type": "irradiance"`.

## Docker

```bash
docker compose up -d --build
```

La configurazione va in `./config/config.json`, lo storico in `./data`.

## Test

```bash
pip install -r requirements-dev.txt
pytest -q
```

## Documentazione

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architettura, algoritmi di analisi, roadmap.
- API: <http://localhost:8080/docs> (Swagger generato da FastAPI).
