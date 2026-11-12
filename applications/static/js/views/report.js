// Report mensile: riepilogo, produzione giornaliera, dettaglio inverter e PDF per il cliente.

import { api, downloadProtectedFile } from '../api.js';
import { esc, eur, kwh, pct, toast, formatNumber } from '../ui.js';
import { barChart } from './chart.js';

let month = new Date().toISOString().slice(0, 7);

export function renderReport(el) {
  let destroyed = false;
  el.innerHTML = `
    <div class="page">
      <div class="page-h"><h2>Report mensile</h2>
        <div class="page-actions">
          <input class="input month-input" type="month" value="${month}" aria-label="Mese">
          <button type="button" class="btn primary" data-a="pdf">Scarica PDF</button>
        </div></div>
      <section class="kpi-grid" data-k="kpis"></section>
      <section class="card">
        <div class="card-h"><h2>Produzione giornaliera</h2>
          <div class="legend"><span class="lg-real">Prodotta (kWh)</span><span class="lg-exp">Attesa (kWh)</span></div></div>
        <div class="card-b"><div class="chart" data-k="chart"></div></div>
      </section>
      <section class="card table-card">
        <div class="card-h"><h2>Dettaglio inverter</h2></div>
        <div class="card-b dt-scroll"><table class="dt-table">
          <thead><tr class="dt-head"><th>Inverter</th><th class="num">kWp</th><th class="num">Prodotta</th><th class="num">kWh/kWp</th><th class="num">Rendimento</th><th class="num">Persa</th><th class="num">Allarmi</th></tr></thead>
          <tbody data-k="inverters"></tbody>
        </table></div>
      </section>
    </div>`;
  const $ = k => el.querySelector(`[data-k="${k}"]`);
  const input = el.querySelector('.month-input');
  const ym = () => input.value.split('-').map(Number);

  input.addEventListener('change', () => { month = input.value; load(); });
  el.querySelector('[data-a="pdf"]').addEventListener('click', async e => {
    const [year, m] = ym();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = 'Preparazione…';
    try { await downloadProtectedFile(`/api/report/monthly.pdf?year=${year}&month=${m}`, `report-${year}-${String(m).padStart(2, '0')}.pdf`); }
    catch (err) { toast('Impossibile generare il report: ' + err.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Scarica PDF'; }
  });

  async function load() {
    const [year, m] = ym();
    if (!year) return;
    try {
      const r = await api('/api/report/monthly', { query: { year, month: m } });
      if (destroyed) return;
      const card = (label, value, sub = '', cls = '') =>
        `<div class="card kpi ${cls}"><div class="card-h"><h2>${label}</h2></div><div class="card-b"><div class="kpi-value">${value}</div><div class="kpi-sub muted">${sub}</div></div></div>`;
      $('kpis').innerHTML =
        card('Energia prodotta', kwh(r.energy_kwh * 1000), `attesa ${kwh(r.expected_kwh * 1000)}`) +
        card('Rendimento', pct(r.performance), `${formatNumber(r.specific_kwh_kwp)} kWh/kWp`) +
        card('Valore energia', eur(r.revenue_eur), `a ${formatNumber(r.price, 3)} €/kWh`) +
        card('Perdite stimate', eur(r.lost_eur), `${kwh(r.lost_kwh * 1000)} non prodotti`, 'loss');
      barChart($('chart'), r.daily, [{ key: 'energy_wh', cls: 'real' }, { key: 'expected_wh', cls: 'exp' }]);
      $('inverters').innerHTML = r.inverters.map(i => `<tr class="dt-row">
        <td><strong>${esc(i.name)}</strong></td><td class="num">${formatNumber(i.kwp)}</td><td class="num">${kwh(i.energy_wh)}</td>
        <td class="num">${formatNumber(i.specific_kwh_kwp)}</td>
        <td class="num">${i.performance != null && i.performance < 0.9 ? `<span class="badge warn">${pct(i.performance)}</span>` : pct(i.performance)}</td>
        <td class="num">${kwh(i.lost_wh)}<div class="muted small">${eur(i.lost_wh / 1000 * r.price)}</div></td>
        <td class="num">${i.alarms}</td></tr>`).join('') || '<tr><td colspan="7" class="dt-empty">Nessun inverter configurato.</td></tr>';
    } catch (err) {
      if (!destroyed) $('kpis').innerHTML = `<p class="dt-empty err">Impossibile caricare il report: ${esc(err.message)}</p>`;
    }
  }

  load();
  return () => { destroyed = true; };
}
