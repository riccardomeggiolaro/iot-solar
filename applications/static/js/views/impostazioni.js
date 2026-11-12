// Impostazioni: una scheda per area (#/impostazioni/<scheda>), come in KINETRA Pesatura.
// La configurazione dell'impianto è riservata agli amministratori; tutti vedono il proprio profilo.

import { api, getMe } from '../api.js';
import { plant } from '../plant.js';
import { esc, toast, openDialog, confirmDialog, ICON } from '../ui.js';
import { renderUtenti } from './impostazioni-utenti.js';

export const ADMIN = 3;

const TABS = {
  impianto:    { label: 'Impianto',          admin: true,  render: renderImpianto },
  dispositivi: { label: 'Dispositivi',       admin: true,  render: renderDispositivi },
  analisi:     { label: 'Allarmi e analisi', admin: true,  render: renderAnalisi },
  simulatore:  { label: 'Simulatore',        admin: true,  render: renderSimulatore },
  utenti:      { label: 'Utenti',            admin: false, render: renderUtenti },
  sistema:     { label: 'Sistema',           admin: true,  render: renderSistema },
};

export function renderImpostazioni(el) {
  let destroyed = false;
  let cleanup = null;
  el.innerHTML = '<div class="page"><nav class="tabs" aria-label="Impostazioni"></nav><div class="settings-body"><p class="muted">Caricamento…</p></div></div>';
  const nav = el.querySelector('.tabs');
  const body = el.querySelector('.settings-body');

  getMe().then(async me => {
    const level = me?.level ?? 0;
    const keys = Object.keys(TABS).filter(k => !TABS[k].admin || level >= ADMIN);
    const sub = location.hash.replace(/^#\/?/, '').split('/')[1];
    const tab = keys.includes(sub) ? sub : keys[0];
    nav.innerHTML = keys.map(t => `<a class="tab" href="#/impostazioni/${t}" ${t === tab ? 'aria-current="page"' : ''}>${esc(TABS[t].label)}</a>`).join('');
    const config = level >= ADMIN ? await api('/api/config') : null;
    if (destroyed) return;
    body.innerHTML = '';
    cleanup = TABS[tab].render(body, { me, level, config });
  }).catch(err => { if (!destroyed) body.innerHTML = `<p class="dt-empty err">Impossibile caricare le impostazioni: ${esc(err.message)}</p>`; });

  return () => { destroyed = true; if (typeof cleanup === 'function') cleanup(); };
}

// ── Componenti comuni ────────────────────────────────────────

/** Sezione con titolo e descrizione. Restituisce il contenitore delle righe. */
export function section(parent, title, description = '') {
  const s = document.createElement('section');
  s.className = 'card settings-section';
  s.innerHTML = `<header><h3>${esc(title)}</h3>${description ? `<p class="muted">${description}</p>` : ''}</header><div class="settings-rows"></div>`;
  parent.appendChild(s);
  return s.querySelector('.settings-rows');
}

/** Salva la configurazione completa sul server (che la valida e la applica subito). */
async function saveConfig(config, message = 'Impostazioni salvate e applicate') {
  const saved = await api('/api/config', { method: 'PUT', body: config });
  toast(message, 'ok');
  plant.refresh();
  return saved;
}

/** Riga con campo numerico/testo: { label, help, path, type, step, min, max, placeholder }. */
function inputRow(f, value) {
  return `<label class="settings-row"><span class="settings-text"><span class="settings-label">${esc(f.label)}</span>
      ${f.help ? `<span class="settings-help">${esc(f.help)}</span>` : ''}</span>
    <input class="input" name="${f.path}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''}
      ${f.max != null ? `max="${f.max}"` : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} value="${esc(value ?? '')}"></label>`;
}

const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((x, k) => x[k], o)[last] = v; };

/** Sezione con campi e pulsante Salva; i campi numerici vuoti diventano null. */
function fieldsSection(parent, { title, description, fields, config, onSaved }) {
  const rows = section(parent, title, description);
  rows.innerHTML = fields.map(f => inputRow(f, getPath(config, f.path))).join('');
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  actions.innerHTML = '<button type="button" class="btn primary">Salva</button>';
  rows.parentElement.appendChild(actions);
  actions.querySelector('button').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const next = structuredClone(config);
    for (const f of fields) {
      const raw = rows.querySelector(`[name="${f.path}"]`).value.trim();
      setPath(next, f.path, f.type === 'number' ? (raw === '' ? null : Number(raw)) : raw);
    }
    btn.disabled = true;
    try { Object.assign(config, await saveConfig(next)); onSaved?.(config); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  });
}

// ── Impianto ─────────────────────────────────────────────────
function renderImpianto(el, { config }) {
  fieldsSection(el, {
    title: 'Dati dell\'impianto', description: 'Compaiono nella dashboard e nel report mensile per il cliente.', config,
    fields: [
      { label: 'Nome impianto', path: 'plant.name' },
      { label: 'Cliente', help: 'Ragione sociale, stampata sul report.', path: 'plant.owner' },
      { label: 'Indirizzo', path: 'plant.address' },
      { label: 'Prezzo dell\'energia (€/kWh)', help: 'Per il valore dell\'energia e delle perdite.', path: 'plant.energy_price_eur_kwh', type: 'number', step: '0.001', min: 0 },
    ],
  });
  fieldsSection(el, {
    title: 'Posizione', description: 'Servono per calcolare la posizione del sole e la produzione attesa.', config,
    fields: [
      { label: 'Latitudine', help: 'Es. 45.41 (nord positivo).', path: 'plant.latitude', type: 'number', step: '0.0001', min: -90, max: 90 },
      { label: 'Longitudine', help: 'Es. 11.88 (est positivo).', path: 'plant.longitude', type: 'number', step: '0.0001', min: -180, max: 180 },
      { label: 'Fuso orario', path: 'plant.timezone', placeholder: 'Europe/Rome' },
    ],
  });
}

// ── Dispositivi ──────────────────────────────────────────────
const TYPE_LABEL = { inverter: 'Inverter', irradiance: 'Sensore irraggiamento' };

function renderDispositivi(el, { config }) {
  el.innerHTML = `
    <section class="card settings-section">
      <header class="settings-head-actions"><div><h3>Dispositivi</h3>
        <p class="muted">Inverter e sensori letti via Modbus TCP (SunSpec). Le modifiche si applicano subito.</p></div>
        <button type="button" class="btn primary" data-a="add">+ Aggiungi dispositivo</button></header>
      <div class="users-list"></div>
    </section>
    <section class="card settings-section"><header><h3>Come collegare un inverter</h3></header><div class="settings-rows">
      <div class="settings-row"><span class="settings-text"><span class="settings-label">Abilita Modbus TCP sull'inverter</span>
        <span class="settings-help">SMA: Modbus server TCP · Fronius: Data export via Modbus "TCP", modello "int + SF" · SolarEdge: Modbus TCP da SetApp · Huawei: Modbus TCP "Abilitato (senza restrizioni)".</span></span></div>
      <div class="settings-row"><span class="settings-text"><span class="settings-label">Porta e unit id</span>
        <span class="settings-help">La porta è di solito 502 (SolarEdge anche 1502). L'unit id è di solito 1 (SMA: 126). Con "Prova" verifichi prima di salvare.</span></span></div>
    </div></section>`;
  const list = el.querySelector('.users-list');

  function draw() {
    const online = Object.fromEntries((plant.data?.devices || []).map(d => [d.name, d.online]));
    list.innerHTML = config.devices.length ? `<table class="dt-table"><thead><tr class="dt-head"><th>Nome</th><th>Tipo</th><th>Indirizzo</th><th class="num">Unit id</th><th class="num">kWp</th><th>Stato</th><th class="dt-actions-h"><span class="sr">Azioni</span></th></tr></thead>
      <tbody>${config.devices.map((d, i) => `<tr class="dt-row">
        <td><strong>${esc(d.name)}</strong></td><td>${esc(TYPE_LABEL[d.type])}</td>
        <td class="nowrap">${esc(d.host)}:${d.port}</td><td class="num">${d.unit_id}</td>
        <td class="num">${d.type === 'inverter' ? d.kwp : '—'}</td>
        <td>${online[d.name] === undefined ? '<span class="badge">—</span>' : online[d.name] ? '<span class="badge ok">Comunica</span>' : '<span class="badge err">Non comunica</span>'}</td>
        <td class="dt-actions">
          <button type="button" class="dt-act" data-edit="${i}" title="Modifica" aria-label="Modifica ${esc(d.name)}">${ICON.edit}</button>
          <button type="button" class="dt-act danger" data-del="${i}" title="Elimina" aria-label="Elimina ${esc(d.name)}">${ICON.delete}</button>
        </td></tr>`).join('')}</tbody></table>`
      : '<p class="empty" style="padding:12px 18px">Nessun dispositivo: aggiungi gli inverter dell\'impianto.</p>';
    list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => deviceForm(Number(b.dataset.edit))));
    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const i = Number(b.dataset.del);
      const ok = await confirmDialog('Eliminare il dispositivo?', `<p><strong>${esc(config.devices[i].name)}</strong> non verrà più letto. Lo storico già registrato resta.</p>`,
        { label: 'Elimina', kind: 'danger', onConfirm: async () => {
          const next = structuredClone(config); next.devices.splice(i, 1);
          Object.assign(config, await saveConfig(next, 'Dispositivo eliminato'));
        } });
      if (ok) draw();
    }));
  }

  function deviceForm(index) {
    const d = index == null
      ? { name: `INV-${config.devices.filter(x => x.type === 'inverter').length + 1}`, type: 'inverter', host: '', port: 502, unit_id: 1, kwp: '' }
      : config.devices[index];
    const body = document.createElement('div');
    body.innerHTML = `<div class="form-grid">
        <label class="field">Nome<input class="input" name="name" required maxlength="40" value="${esc(d.name)}"></label>
        <label class="field">Tipo<select class="input" name="type">
          ${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Indirizzo IP<input class="input" name="host" required placeholder="192.168.1.50" value="${esc(d.host)}"></label>
        <label class="field">Porta<input class="input" name="port" type="number" min="1" max="65535" required value="${d.port}"></label>
        <label class="field">Unit id<input class="input" name="unit_id" type="number" min="0" max="255" required value="${d.unit_id}"></label>
        <label class="field" data-kwp>Potenza (kWp)<input class="input" name="kwp" type="number" min="0" step="0.1" value="${d.kwp}"></label>
      </div>
      <div class="settings-actions inline"><button type="button" class="btn" data-a="test">Prova connessione</button></div>
      <p class="device-status" role="status"></p>`;
    const f = n => body.querySelector(`[name="${n}"]`);
    const syncType = () => { body.querySelector('[data-kwp]').hidden = f('type').value !== 'inverter'; f('kwp').required = f('type').value === 'inverter'; };
    f('type').addEventListener('change', syncType); syncType();
    const read = () => ({ name: f('name').value.trim(), type: f('type').value, host: f('host').value.trim(),
      port: Number(f('port').value), unit_id: Number(f('unit_id').value), kwp: f('type').value === 'inverter' ? Number(f('kwp').value) : 0 });
    body.querySelector('[data-a="test"]').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const out = body.querySelector('.device-status');
      const v = read();
      if (!v.host) { out.className = 'device-status err'; out.textContent = 'Inserisci l\'indirizzo IP.'; return; }
      btn.disabled = true; out.className = 'device-status'; out.textContent = 'Connessione in corso…';
      try {
        const r = await api('/api/devices/test', { method: 'POST', body: v });
        if (r.ok) {
          const info = [r.info.manufacturer, r.info.model, r.info.serial && `matricola ${r.info.serial}`].filter(Boolean).join(' · ');
          const val = v.type === 'inverter' ? `${((r.values.ac_power_w || 0) / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} kW` : `${r.values.poa_wm2 ?? '—'} W/m²`;
          out.className = 'device-status ok'; out.textContent = `✓ Risponde: ${info} · ${val}`;
        } else { out.className = 'device-status err'; out.textContent = `✕ ${r.error}`; }
      } catch (err) { out.className = 'device-status err'; out.textContent = `✕ ${err.message}`; }
      finally { btn.disabled = false; }
    });
    openDialog({
      title: index == null ? 'Nuovo dispositivo' : `Modifica ${d.name}`, body,
      actions: [{ label: 'Annulla', value: null }, { label: 'Salva', kind: 'primary', submit: true }],
      onSubmit: async () => {
        const next = structuredClone(config);
        if (index == null) next.devices.push(read()); else next.devices[index] = read();
        Object.assign(config, await saveConfig(next, index == null ? 'Dispositivo aggiunto' : 'Dispositivo aggiornato'));
      },
    }).then(r => { if (r) draw(); });
  }

  el.querySelector('[data-a="add"]').addEventListener('click', () => deviceForm(null));
  draw();
  const off = plant.on(draw);
  return off;
}

// ── Allarmi e analisi ────────────────────────────────────────
function renderAnalisi(el, { config }) {
  fieldsSection(el, {
    title: 'Soglie degli allarmi', description: 'Quando un inverter viene segnalato perché produce meno del dovuto.', config,
    fields: [
      { label: 'Scostamento dall\'atteso', help: 'Rispetto all\'irraggiamento misurato. 0,20 = 20% in meno.', path: 'analysis.expected_threshold', type: 'number', step: '0.01', min: 0.01, max: 0.99 },
      { label: 'Scostamento dagli altri inverter', help: 'Rispetto alla mediana degli altri inverter, a parità di kWp.', path: 'analysis.peer_threshold', type: 'number', step: '0.01', min: 0.01, max: 0.99 },
      { label: 'Irraggiamento minimo per valutare (W/m²)', help: 'Sotto questa soglia (alba, tramonto) il rendimento non viene giudicato.', path: 'analysis.min_irradiance', type: 'number', min: 0 },
      { label: 'Sovratemperatura inverter (°C)', path: 'analysis.overtemp_c', type: 'number', min: 30, max: 120 },
      { label: 'Letture consecutive prima dell\'allarme', help: 'Evita falsi allarmi per una nuvola passeggera.', path: 'analysis.persist_cycles', type: 'number', min: 1 },
      { label: 'Letture fallite prima di "non comunica"', path: 'analysis.offline_after_failures', type: 'number', min: 1 },
    ],
  });
  fieldsSection(el, {
    title: 'Lettura e calcolo', config,
    fields: [
      { label: 'Intervallo di lettura (secondi)', path: 'polling.interval_s', type: 'number', min: 1, max: 300 },
      { label: 'Rapporto atteso di un impianto sano', help: 'Perdite normali di cavi, temperatura e inverter. Tipico 0,80–0,88.', path: 'analysis.derate', type: 'number', step: '0.01', min: 0.3, max: 1.1 },
      { label: 'Conservazione dello storico (giorni)', path: 'database.retention_days', type: 'number', min: 7 },
    ],
  });
  fieldsSection(el, {
    title: 'Notifiche', description: 'All\'apertura e alla chiusura di un allarme viene inviato un JSON a questo indirizzo (es. per Telegram, email o Slack tramite n8n o Make).', config,
    fields: [{ label: 'Webhook', path: 'alarms.webhook_url', placeholder: 'https://…' }],
  });
}

// ── Simulatore ───────────────────────────────────────────────
function renderSimulatore(el, { config }) {
  const rows = section(el, 'Simulatore', 'Un impianto virtuale per dimostrazioni e prove: genera i dati via Modbus come inverter veri. Va spento per collegare l\'impianto reale.');
  rows.innerHTML = `
    <label class="settings-row"><span class="settings-text"><span class="settings-label">Simulatore attivo</span>
      <span class="settings-help">Con il simulatore attivo i dispositivi devono puntare a 127.0.0.1 e alla sua porta.</span></span>
      <span class="switch"><input type="checkbox" name="enabled" ${config.simulator.enabled ? 'checked' : ''}><span class="switch-ui"></span></span></label>
    ${inputRow({ label: 'Velocità del tempo', help: '1 = tempo reale; 120 = una giornata di sole in circa 6 minuti.', path: 'speed', type: 'number', min: 0.1 }, config.simulator.speed)}
    ${inputRow({ label: 'Ora di partenza', help: 'Ora del giorno simulata all\'avvio (vuoto = ora attuale).', path: 'start_hour', type: 'number', step: '0.5', min: 0, max: 23.5 }, config.simulator.start_hour)}
    ${inputRow({ label: 'Porta Modbus', path: 'port', type: 'number', min: 1, max: 65535 }, config.simulator.port)}`;
  const actions = document.createElement('div');
  actions.className = 'settings-actions';
  actions.innerHTML = '<button type="button" class="btn primary">Salva</button>';
  rows.parentElement.appendChild(actions);
  actions.querySelector('button').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const next = structuredClone(config);
    const v = n => rows.querySelector(`[name="${n}"]`);
    next.simulator.enabled = v('enabled').checked;
    next.simulator.speed = Number(v('speed').value);
    next.simulator.start_hour = v('start_hour').value === '' ? null : Number(v('start_hour').value);
    next.simulator.port = Number(v('port').value);
    btn.disabled = true;
    try { Object.assign(config, await saveConfig(next, next.simulator.enabled ? 'Simulatore attivo' : 'Simulatore spento')); }
    catch (err) { toast(err.message, 'err'); }
    finally { btn.disabled = false; }
  });
}

// ── Sistema ──────────────────────────────────────────────────
function renderSistema(el) {
  const rows = section(el, 'Informazioni');
  rows.innerHTML = '<div class="settings-row"><span class="settings-text"><span class="settings-label">Versione</span><span class="settings-help" data-v>—</span></span></div>' +
    '<div class="settings-row"><span class="settings-text"><span class="settings-label">Aggiornamento</span><span class="settings-help">Rilancia l\'installer (<code>sudo ./installer-docker.sh -y</code> su Linux, <code>.\\installer-docker.ps1</code> su Windows): configurazione, storico e utenti restano.</span></span></div>' +
    '<div class="settings-row"><span class="settings-text"><span class="settings-label">Backup</span><span class="settings-help">Copia le cartelle della configurazione e dei dati (<code>/etc/iot-solar</code> e <code>/var/opt/iot-solar</code> su Linux, <code>docker-data</code> su Windows).</span></span></div>';
  fetch('/api/version').then(r => r.json()).then(v => { rows.querySelector('[data-v]').textContent = `KINETRA Energia ${v.version}`; }).catch(() => {});
}
