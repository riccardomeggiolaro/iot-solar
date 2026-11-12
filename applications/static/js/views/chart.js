// Grafici SVG senza librerie (funzionano anche senza internet presso il cliente).

import { esc, formatNumber } from '../ui.js';

// Il disegno usa la larghezza reale del contenitore: niente deformazioni del testo.
const svgOpen = (w, h) => `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">`;
const widthOf = el => Math.max(300, Math.floor(el.clientWidth || el.parentElement?.clientWidth || 1000));

/** Linee nel tempo: rows [{ts, ...}], series [{key, cls}] con valori in W. */
export function lineChart(el, rows, series, { height = 260 } = {}) {
  const W = widthOf(el), H = height, pad = { l: 52, r: 12, t: 10, b: 26 };
  if (rows.length < 2) { el.innerHTML = '<p class="empty">Dati insufficienti: lo storico si riempie con le prossime letture.</p>'; return; }
  const t0 = rows[0].ts, t1 = rows[rows.length - 1].ts;
  const ymax = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key] || 0))) * 1.1;
  const x = t => pad.l + (t - t0) / Math.max(t1 - t0, 1) * (W - pad.l - pad.r);
  const y = v => H - pad.b - (v / ymax) * (H - pad.t - pad.b);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = ymax / 4 * i;
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${formatNumber(v / 1000, ymax < 10000 ? 1 : 0)} kW</text>`;
    const t = t0 + (t1 - t0) / 4 * i;
    const label = new Date(t * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    g += `<text x="${x(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${esc(label)}</text>`;
  }
  for (const s of series) {
    const d = rows.filter(r => r[s.key] != null).map((r, i) => `${i ? 'L' : 'M'}${x(r.ts).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join('');
    g += `<path class="line ${s.cls}" d="${d}" vector-effect="non-scaling-stroke"/>`;
  }
  el.innerHTML = svgOpen(W, H) + g + '</svg>';
  el.style.height = `${H}px`;
}

/** Barre affiancate per giorno: rows [{day, ...}], series [{key, cls}] con valori in Wh. */
export function barChart(el, rows, series, { height = 230 } = {}) {
  const W = widthOf(el), H = height, pad = { l: 46, r: 12, t: 10, b: 24 };
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => r[s.key] || 0))) * 1.1;
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = v => H - pad.b - v / max * (H - pad.t - pad.b);
  const inner = bw * 0.76 / series.length;
  const digits = max < 10000 ? 1 : 0;  // con pochi kWh servono i decimali sull'asse
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = max / 4 * i;
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${formatNumber(v / 1000, digits)}</text>`;
  }
  const every = bw < 18 ? 3 : bw < 26 ? 2 : 1;  // etichette dei giorni diradate su schermi stretti
  rows.forEach((r, i) => {
    const x0 = pad.l + i * bw + bw * 0.12;
    series.forEach((s, j) => {
      const v = r[s.key] || 0;
      g += `<rect class="bar ${s.cls}" x="${x0 + j * inner}" width="${inner}" y="${y(v)}" height="${H - pad.b - y(v)}"/>`;
    });
    if ((r.day - 1) % every === 0) g += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${r.day}</text>`;
  });
  el.innerHTML = svgOpen(W, H) + g + '</svg>';
  el.style.height = `${H}px`;
}
