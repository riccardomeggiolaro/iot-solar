// Dashboard: produzione in tempo reale, inverter, allarmi attivi, storico e simulatore.

import { api, getMe } from '../api.js';
import { plant, deviceState } from '../plant.js';
import { esc, eur, kw, kwh, toast, formatDateTime } from '../ui.js';
import { lineChart } from './chart.js';

const ADMIN = 3;
let selected = null;

export function renderDashboard(el) {
  let destroyed = false;
  let me = { level: 0 };
  let ticks = 0;
  el.innerHTML = `
    <div class="page">
      <p class="settings-notice" data-sim hidden>Stai vedendo un <b>impianto simulato</b>: per collegare gli inverter reali vai su
        <a href="#/impostazioni/dispositivi">Impostazioni › Dispositivi</a> e disattiva il simulatore.</p>
      <section class="kpi-grid">
        <div class="card kpi"><div class="card-h"><h2>Potenza ora</h2></div><div class="card-b"><div class="kpi-value" data-k="power">—</div><div class="kpi-sub muted" data-k="power-sub"></div></div></div>
        <div class="card kpi"><div class="card-h"><h2>Energia oggi</h2></div><div class="card-b"><div class="kpi-value" data-k="energy">—</div><div class="kpi-sub muted" data-k="energy-sub"></div></div></div>
        <div class="card kpi loss"><div class="card-h"><h2>Perdita stimata oggi</h2></div><div class="card-b"><div class="kpi-value" data-k="loss">—</div><div class="kpi-sub muted" data-k="loss-sub"></div></div></div>
        <div class="card kpi"><div class="card-h"><h2>Irraggiamento</h2></div><div class="card-b"><div class="kpi-value" data-k="irr">—</div><div class="kpi-sub muted">sul piano dei moduli</div></div></div>
      </section>
      <div class="dash-grid">
        <section class="card table-card">
          <div class="card-h"><h2>Inverter</h2></div>
          <div class="card-b dt-scroll"><table class="dt-table">
            <thead><tr class="dt-head"><th>Inverter</th><th>Stato</th><th class="num">Potenza</th><th>Reale / atteso</th><th class="num">Oggi</th><th class="num">Temp.</th></tr></thead>
            <tbody data-k="devices"><tr><td colspan="6" class="dt-empty">Caricamento…</td></tr></tbody>
          </table></div>
        </section>
        <section class="card">
          <div class="card-h"><h2>Allarmi attivi</h2><a class="btn small" href="#/allarmi">Storico</a></div>
          <div class="card-b alarm-list" data-k="alarms"></div>
        </section>
      </div>
      <section class="card">
        <div class="card-h"><h2 data-k="chart-title">Storico 24 ore</h2>
          <div class="legend"><span class="lg-real">Reale</span><span class="lg-exp">Atteso</span></div></div>
        <div class="card-b"><div class="chart" data-k="chart"></div></div>
      </section>
      <section class="card" data-k="sim" hidden>
        <div class="card-h"><h2>Simulatore · prova un guasto</h2></div>
        <div class="card-b">
          <div class="form-grid sim-form">
            <label class="field">Dispositivo<select class="input" data-s="dev"></select></label>
            <label class="field"><span>Sporco <em>(0–1)</em></span><input class="input" type="number" min="0" max="1" step="0.05" data-s="soiling"></label>
            <label class="field"><span>Stringhe perse <em>(0–1)</em></span><input class="input" type="number" min="0" max="1" step="0.1" data-s="string_loss"></label>
            <label class="check"><input type="checkbox" data-s="fault"> Guasto (FAULT)</label>
            <label class="check"><input type="checkbox" data-s="offline"> Scollegato</label>
            <button type="button" class="btn primary" data-s="apply">Applica</button>
          </div>
          <p class="muted sim-state" data-s="state"></p>
        </div>
      </section>
    </div>`;
  const $ = s => el.querySelector(`[data-k="${s}"]`);

  function update(p) {
    if (destroyed || !p) return;
    el.querySelector('[data-sim]').hidden = !p.simulator;
    $('power').textContent = kw(p.power_w);
    $('power-sub').textContent = p.expected_w ? `atteso ${kw(p.expected_w)} · ${p.kwp} kWp` : `${p.kwp} kWp installati`;
    $('energy').textContent = kwh(p.energy_today_wh);
    $('energy-sub').textContent = `valore ${eur(p.energy_today_wh / 1000 * p.energy_price_eur_kwh)}`;
    $('loss').textContent = eur(p.lost_today_eur);
    $('loss-sub').textContent = `${kwh(p.lost_today_wh)} non prodotti`;
    $('irr').textContent = p.poa_wm2 == null ? '—' : `${Math.round(p.poa_wm2)} W/m²`;

    const inv = p.devices.filter(d => d.type === 'inverter');
    if (!inv.some(d => d.name === selected)) selected = inv[0]?.name ?? null;
    $('devices').innerHTML = inv.map(d => {
      const v = d.values || {};
      const st = deviceState(d);
      const max = Math.max(v.ac_power_w || 0, d.expected_w || 0, 1);
      const ratio = d.expected_w ? (v.ac_power_w || 0) / d.expected_w : null;
      const bar = ratio == null ? 'ok' : ratio < 0.8 ? 'err' : ratio < 0.9 ? 'warn' : 'ok';
      return `<tr class="dt-row clickable ${d.name === selected ? 'open' : ''}" data-name="${esc(d.name)}">
        <td><strong>${esc(d.name)}</strong><div class="muted small">${d.kwp} kWp</div></td>
        <td><span class="badge ${st.kind}">${esc(st.label)}</span></td>
        <td class="num">${d.online ? kw(v.ac_power_w) : '—'}</td>
        <td><div class="ratio"><span class="ratio-bar"><i class="${bar}" style="width:${(v.ac_power_w || 0) / max * 100}%"></i>${d.expected_w ? `<b style="left:${d.expected_w / max * 100}%"></b>` : ''}</span>
          <span class="muted small">${ratio == null ? '' : Math.round(ratio * 100) + '%'}</span></div></td>
        <td class="num">${kwh(d.energy_today_wh)}</td>
        <td class="num">${d.online && v.temperature_c != null ? Math.round(v.temperature_c) + ' °C' : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="dt-empty">Nessun inverter: aggiungili in Impostazioni › Dispositivi.</td></tr>';
    $('devices').querySelectorAll('tr[data-name]').forEach(tr => tr.addEventListener('click', () => {
      selected = tr.dataset.name; update(plant.data); loadHistory();
    }));

    const canAck = me.level >= 2;
    $('alarms').innerHTML = p.active_alarms.length ? p.active_alarms.map(a => alarmItem(a, p.energy_price_eur_kwh, canAck)).join('')
      : '<p class="empty">Nessun allarme: l\'impianto funziona regolarmente.</p>';
    $('alarms').querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', async () => {
      try { await api(`/api/alarms/${b.dataset.ack}/ack`, { method: 'POST' }); toast('Allarme preso in carico', 'ok'); plant.refresh(); }
      catch (err) { toast(err.message, 'err'); }
    }));

    if (ticks++ % 6 === 0) loadHistory();
    const simCard = $('sim');
    simCard.hidden = !(p.simulator && me.level >= ADMIN);
    if (!simCard.hidden) loadSim();
  }

  async function loadHistory() {
    if (!selected) return;
    $('chart-title').textContent = `Storico 24 ore · ${selected}`;
    try {
      const rows = await api(`/api/devices/${encodeURIComponent(selected)}/history`, { query: { hours: 24 } });
      if (!destroyed) lineChart($('chart'), rows, [{ key: 'expected_w', cls: 'exp' }, { key: 'ac_power_w', cls: 'real' }]);
    } catch (_) {}
  }

  // ── Simulatore ─────────────────────────────────────────────
  let simDevices = {};
  const s = k => el.querySelector(`[data-s="${k}"]`);
  async function loadSim() {
    try {
      const r = await api('/api/simulator');
      const names = Object.keys(r.devices);
      if (s('dev').options.length !== names.length) {
        s('dev').innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
        simDevices = r.devices; fillSim();
      }
      simDevices = r.devices;
      s('state').textContent = `Ora simulata ${formatDateTime(r.state.sim_time)} · sole a ${r.state.sun_elevation}° · nuvolosità ${r.state.cloud_factor}`;
    } catch (_) {}
  }
  function fillSim() {
    const d = simDevices[s('dev').value] || {};
    const isInv = d.type === 'inverter';
    s('soiling').value = d.soiling ?? 0; s('string_loss').value = d.string_loss ?? 0;
    s('fault').checked = !!d.fault; s('offline').checked = !!d.offline;
    ['soiling', 'string_loss', 'fault'].forEach(k => { s(k).disabled = !isInv; });
  }
  s('dev').addEventListener('change', fillSim);
  s('apply').addEventListener('click', async () => {
    const name = s('dev').value;
    const body = { offline: s('offline').checked };
    if (simDevices[name]?.type === 'inverter') Object.assign(body, {
      soiling: Number(s('soiling').value), string_loss: Number(s('string_loss').value), fault: s('fault').checked });
    try {
      simDevices[name] = await api(`/api/simulator/${encodeURIComponent(name)}`, { method: 'POST', body });
      toast(`Simulatore: ${name} aggiornato. Gli allarmi compaiono dopo alcune letture.`, 'ok');
      plant.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  getMe().then(m => { me = m; update(plant.data); }).catch(() => {});
  const off = plant.on(update);
  update(plant.data);
  return () => { destroyed = true; off(); };
}

/** Riga di un allarme (usata anche dalla pagina Allarmi). */
export function alarmItem(a, price, canAck) {
  const kind = a.severity === 'critical' ? 'err' : 'warn';
  const who = a.message.startsWith(a.device) ? '' : `${a.device === 'IMPIANTO' ? 'Impianto' : a.device} · `;
  return `<div class="alarm-item ${kind}">
    <div class="alarm-t">${esc(who)}${esc(a.message)}</div>
    ${a.hint ? `<div class="alarm-h muted">${esc(a.hint)}</div>` : ''}
    <div class="alarm-m muted">
      <span>dal ${esc(formatDateTime(a.started_at * 1000))}</span>
      ${a.lost_wh > 0 ? `<span>persi ${kwh(a.lost_wh)} (${eur(a.lost_wh / 1000 * price)})</span>` : ''}
      ${a.acknowledged ? '<span class="badge ok">Preso in carico</span>'
        : canAck ? `<button type="button" class="btn small" data-ack="${a.id}">Prendi in carico</button>` : ''}
    </div></div>`;
}
