// Stato dell'impianto condiviso da barra di stato e schermate: si aggiorna ogni 5 secondi
// da /api/plant e avvisa chi è in ascolto (evento "update").

import { api } from './api.js';

const listeners = new Set();
const INTERVAL_MS = 5000;

export const plant = {
  data: null,      // ultima risposta di /api/plant
  error: null,
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async refresh() {
    try {
      this.data = await api('/api/plant');
      this.error = null;
    } catch (err) {
      this.error = err;
    }
    listeners.forEach(fn => { try { fn(this.data, this.error); } catch (e) { console.error(e); } });
    return this.data;
  },
  start() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, INTERVAL_MS);
  },
};

/** Stato di un inverter per colori e testi: kind = ok | warn | err | '' (inattivo). */
export function deviceState(d) {
  if (!d.online) return { kind: 'err', label: 'Non comunica' };
  const st = d.values?.status_text;
  if (st === 'FAULT') return { kind: 'err', label: 'Guasto' };
  if (st === 'SLEEPING' || st === 'OFF' || st === 'STANDBY') return { kind: '', label: 'In attesa del sole' };
  if (d.expected_w && d.values?.ac_power_w != null) {
    const r = d.values.ac_power_w / d.expected_w;
    if (r < 0.8) return { kind: 'warn', label: 'Rende meno dell\'atteso' };
  }
  if (st === 'THROTTLED') return { kind: 'ok', label: 'Limitato dalla rete' };
  return { kind: 'ok', label: 'In produzione' };
}
