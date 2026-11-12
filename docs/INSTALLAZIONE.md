# Installazione di IoT-Solar

IoT-Solar gira in un container Docker su:
- **Linux**: Debian, Ubuntu, Raspberry Pi OS; PC e mini PC x86 oppure Raspberry Pi 4/5;
- **Windows 10/11**, con Docker Desktop.

Il PC deve stare nella stessa rete degli inverter.

## Cosa serve

- Il pacchetto `iot-solar-docker.zip`, che si scarica dalla pagina *Releases* del repository.
- Un token GitHub per scaricare l'immagine, che è privata: GitHub → Settings → Developer settings →
  Personal access tokens → *Tokens (classic)*, con il solo permesso **read:packages**.
  L'installer lo chiede la prima volta; dopo, Docker lo ricorda.

## Linux

```bash
unzip iot-solar-docker.zip && cd iot-solar-docker
sudo ./installer-docker.sh
```

L'installer:
1. installa Docker, se manca;
2. copia i file in `/opt/iot-solar`;
3. crea le cartelle `/etc/iot-solar` (configurazione) e `/var/opt/iot-solar` (storico, utenti);
4. genera una password casuale per l'utente `admin`;
5. scarica l'immagine e avvia il servizio.

Alla fine stampa l'indirizzo della dashboard e la password del primo accesso.

## Windows

PowerShell **come Amministratore**, nella cartella estratta dallo zip:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\installer-docker.ps1
```

Se mancano WSL2 o Docker Desktop, lo script li installa e chiede di riavviare il PC: dopo il riavvio
va rilanciato. Configurazione e dati restano nella sottocartella `docker-data`.

Per l'avvio automatico all'accensione: Docker Desktop → Settings → General →
"Start Docker Desktop when you sign in".

## Primo accesso

1. Apri `http://<indirizzo-del-PC>:8080`.
2. Accedi con l'utente `admin` e la password mostrata dall'installer. Ti verrà chiesto di cambiarla.
3. Al primo avvio l'impianto è **simulato**. Vai su **Configurazione**:
   - inserisci i dati dell'impianto: nome, cliente, coordinate, prezzo dell'energia;
   - in **Dispositivi** elimina quelli simulati e aggiungi gli inverter reali (IP, porta 502, unit id, kWp);
     con **Prova** verifichi subito la comunicazione;
   - in **Simulatore** imposta *Attivo: No*;
   - premi **Salva e applica**: non serve riavviare.
4. In **Utenti** crea gli accessi per il cliente (*Sola lettura*) e per i tecnici (*Utente*).

### Abilitare Modbus TCP sugli inverter

| Marca | Dove |
|---|---|
| SMA | Interfaccia web dell'inverter → Configurazione → Modbus: attivare il server TCP (porta 502) |
| Fronius | Interfaccia web → Comunicazione → Modbus: "Data export via Modbus = TCP", modello "int + SF" |
| SolarEdge | App SetApp → Comunicazione → Modbus TCP: abilitato (porta 1502 o 502) |
| Huawei | App FusionSolar/SUN2000 → Impostazioni → Modbus TCP: "Abilitato (senza restrizioni)" |

L'unit id è di solito 1, oppure 126 su SMA. In caso di dubbio prova i valori con il pulsante **Prova**.

## Aggiornamento

Rilancia l'installer: scarica l'ultima versione e mantiene configurazione, storico e utenti.

```bash
sudo /opt/iot-solar/installer-docker.sh -y
```

In alternativa, dalla cartella di installazione:

```bash
docker compose pull && docker compose up -d
```

Per installare una versione precisa, imposta `IOT_SOLAR_TAG=0.2.0` nel file `.env`.

## Comandi utili

Dalla cartella di installazione (`/opt/iot-solar` su Linux):

| Cosa | Comando |
|---|---|
| Log | `docker compose logs -f` |
| Riavvio | `docker compose restart` |
| Stop | `docker compose down` |
| Stato | `docker compose ps` |

## Backup

Basta copiare le due cartelle persistenti: `/etc/iot-solar` e `/var/opt/iot-solar` su Linux,
`docker-data` su Windows. Per una copia sicura del database ferma prima il servizio con `docker compose down`.

## Password admin dimenticata

Un altro super admin può reimpostarla dalla pagina **Utenti**. In alternativa, dalla cartella di installazione:

```bash
docker compose exec iot-solar python -m modules.md_auth.reset_admin NUOVA_PASSWORD
```

Il comando reimposta la password dell'utente `admin`, o lo ricrea se non esiste. Storico e
configurazione non vengono toccati. Al primo accesso verrà chiesto di cambiarla.
