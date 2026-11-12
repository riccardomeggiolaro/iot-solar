// Allarmi: elenco attivi o storico, con presa in carico (utente e superiori).

import { api, getMe } from '../api.js';
import { plant } from '../plant.js';
import { esc, eur, kwh, toast, formatDateTime } from '../ui.js';

const CODES = {
  OFFLINE: 'Non comunica', FAULT: 'Inverter in guasto', OVERTEMP: 'Sovratemperatura',
  UNDERPERF_EXPECTED: 'Sotto l\'atteso', UNDERPERF_PEER: 'Sotto gli altri inverter', PLANT_UNDERPERF: 'Calo dell\'impianto',
};

function duration(a) {
  const s = (a.ended_at || Date.now() / 1000) - a.started_at;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${(s / 3600).toLocaleString('it-IT', { maximumFractionDigits: 1 })} h`;
  return `${(s / 86400).toLocaleString('it-IT', { maximumFractionDigits: 1 })} g`;
}

export function renderAllarmi(el) {
  let destroyed = false;
  let me = { level: 0 };
  let onlyActive = location.hash.includes('/attivi');
  el.innerHTML = `
    <div class="page">
      <div class="page-h"><h2>Allarmi</h2>
        <div class="segmented" role="radiogroup" aria-label="Filtro">
          <label><input type="radio" name="f" value="all" ${onlyActive ? '' : 'checked'}><span>Tutti</span></label>
          <label><input type="radio" name="f" value="active" ${onlyActive ? 'checked' : ''}><span>Solo attivi</span></label>
        </div></div>
      <section class="card table-card"><div class="dt-scroll"><table class="dt-table">
        <thead><tr class="dt-head"><th>Stato</th><th>Dispositivo</th><th>Problema</th><th>Inizio</th><th class="num">Durata</th><th class="num">Persa</th><th class="dt-actions-h"><span class="sr">Azioni</span></th></tr></thead>
        <tbody><tr><td colspan="7" class="dt-empty">Caricamento…</td></tr></tbody>
      </table></div></section>
    </div>`;
  const body = el.querySelector('tbody');
  el.querySelectorAll('input[name=f]').forEach(r => r.addEventListener('change', () => { onlyActive = r.value === 'active'; load(); }));

  async function load() {
    try {
      const rows = await api('/api/alarms', { query: onlyActive ? { active: true } : { limit: 300 } });
      if (destroyed) return;
      const price = plant.data?.energy_price_eur_kwh ?? 0;
      body.innerHTML = rows.map(a => {
        const active = !a.ended_at;
        const status = active ? `<span class="badge ${a.severity === 'critical' ? 'err' : 'warn'}">Attivo</span>` : '<span class="badge">Rientrato</span>';
        const action = active && !a.acknowledged && me.level >= 2
          ? `<button type="button" class="btn small" data-ack="${a.id}">Prendi in carico</button>`
          : a.acknowledged ? '<span class="badge ok">Preso in carico</span>' : '';
        return `<tr class="dt-row ${active ? '' : 'row-muted'}">
          <td>${status}</td>
          <td><strong>${esc(a.device === 'IMPIANTO' ? 'Impianto' : a.device)}</strong></td>
          <td><div>${esc(CODES[a.code] || a.code)}</div><div class="muted small">${esc(a.message)}</div>${a.hint && active ? `<div class="muted small">${esc(a.hint)}</div>` : ''}</td>
          <td class="nowrap">${esc(formatDateTime(a.started_at * 1000))}</td>
          <td class="num nowrap">${duration(a)}</td>
          <td class="num nowrap">${a.lost_wh > 0 ? `${kwh(a.lost_wh)}<div class="muted small">${eur(a.lost_wh / 1000 * price)}</div>` : '—'}</td>
          <td class="dt-actions">${action}</td></tr>`;
      }).join('') || `<tr><td colspan="7" class="dt-empty">${onlyActive ? 'Nessun allarme attivo.' : 'Nessun allarme registrato.'}</td></tr>`;
      body.querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', async () => {
        try { await api(`/api/alarms/${b.dataset.ack}/ack`, { method: 'POST' }); toast('Allarme preso in carico', 'ok'); load(); plant.refresh(); }
        catch (err) { toast(err.message, 'err'); }
      }));
    } catch (err) {
      if (!destroyed) body.innerHTML = `<tr><td colspan="7" class="dt-empty err">Impossibile caricare gli allarmi: ${esc(err.message)}</td></tr>`;
    }
  }

  getMe().then(m => { me = m; load(); }).catch(load);
  const off = plant.on(() => load());
  return () => { destroyed = true; off(); };
}
