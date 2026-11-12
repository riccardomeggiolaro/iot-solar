// Pagina di accesso: ottiene il token dal server e lo salva per l'interfaccia (come in KINETRA Pesatura).

const THEME_KEY = 'ui-v2.theme';
try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch (_) {}

// Dopo l'accesso torna alla pagina richiesta (solo percorsi di questo server), altrimenti alla home.
function nextUrl() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function getToken() {
  try { return localStorage.getItem('token'); } catch (_) { return null; }
}

// Se c'è già un token valido, entra direttamente.
const existing = getToken();
if (existing) {
  fetch('/api/auth/me', { headers: { Authorization: `Bearer ${existing}` } })
    .then(r => r.ok ? r.json() : null)
    .then(user => {
      if (user && user.username) location.replace(nextUrl());
      else try { localStorage.removeItem('token'); } catch (_) {}
    })
    .catch(() => {});
}

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) { showError('Inserisci nome utente e password.'); return; }

  showError('');
  submit.disabled = true;
  submit.textContent = 'Accesso in corso…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      showError(res.status === 401 ? 'Nome utente o password non corretti.' : 'Accesso non riuscito, riprova.');
      form.password.select();
      return;
    }
    try { localStorage.setItem('token', data.access_token); } catch (_) {}
    location.replace(nextUrl());
  } catch (_) {
    showError('Server non raggiungibile. Controlla la connessione e riprova.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Accedi';
  }
});
