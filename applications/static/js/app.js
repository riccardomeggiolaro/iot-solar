// Avvio dell'applicazione: menu e navigazione, barra di stato, tema (come KINETRA Pesatura).

import { getToken, getMe, logout } from './api.js';
import { plant, deviceState } from './plant.js';
import { esc, kw, toast } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderAllarmi } from './views/allarmi.js';
import { renderReport } from './views/report.js';
import { renderImpostazioni } from './views/impostazioni.js';
import { forcePasswordChange } from './views/impostazioni-utenti.js';

if (!getToken()) logout();

const ROUTES = {
  dashboard:    { title: 'Dashboard',    render: renderDashboard },
  allarmi:      { title: 'Allarmi',      render: renderAllarmi },
  report:       { title: 'Report',       render: renderReport },
  impostazioni: { title: 'Impostazioni', render: renderImpostazioni },
};

const view = document.getElementById('view');
const title = document.getElementById('page-title');
let cleanup = null;

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  return ROUTES[name] ? name : 'dashboard';
}

function navigate() {
  const name = currentRoute();
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  view.innerHTML = '';
  document.querySelectorAll('.nav-item').forEach(a => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  title.textContent = ROUTES[name].title;
  document.title = `${ROUTES[name].title} · KINETRA Energia`;
  cleanup = ROUTES[name].render(view);
}

// ── Barra di stato dell'impianto ─────────────────────────────
const strip = document.getElementById('status-strip');
function renderStatus(p, err) {
  if (err && !p) { strip.innerHTML = '<span class="chip err"><span class="dot"></span>Server non raggiungibile</span>'; return; }
  if (!p) return;
  const chips = [];
  const active = p.active_alarms.length;
  chips.push(`<a class="chip ${active ? 'err' : 'ok'}" href="#/allarmi"><span class="dot"></span>${active ? `${active} allarm${active === 1 ? 'e' : 'i'}` : 'Nessun allarme'}</a>`);
  chips.push(`<span class="chip ${p.power_w > 0 ? 'ok' : ''}" title="Potenza dell'impianto"><span class="dot"></span>Impianto · ${esc(kw(p.power_w))}</span>`);
  for (const d of p.devices.filter(x => x.type === 'inverter')) {
    const st = deviceState(d);
    const value = d.online ? kw(d.values?.ac_power_w) : st.label;
    chips.push(`<span class="chip ${st.kind}" title="${esc(d.name)}: ${esc(st.label)}"><span class="dot"></span>${esc(d.name)} · ${esc(value)}</span>`);
  }
  if (p.simulator) chips.push('<span class="chip warn" title="I dati sono generati dal simulatore"><span class="dot"></span>Simulatore</span>');
  strip.innerHTML = chips.join('');
}
plant.on(renderStatus);

// ── Tema ─────────────────────────────────────────────────────
const THEME_KEY = 'ui-v2.theme';
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (_) {}
document.getElementById('theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
});
document.getElementById('logout').addEventListener('click', logout);

// ── Avvio ────────────────────────────────────────────────────
// Con una password provvisoria il server rifiuta tutte le altre richieste: prima va cambiata.
getMe()
  .then(async me => {
    if (me.must_change_password) await forcePasswordChange();
    window.addEventListener('hashchange', navigate);
    plant.start();
    navigate();
  })
  .catch(err => {
    view.innerHTML = `<div class="placeholder"><div class="big">⚠️</div><h2>Impossibile avviare l'applicazione</h2><p class="muted">${esc(err.message)}</p></div>`;
    toast('Impossibile avviare l\'applicazione: ' + err.message, 'err');
  });
