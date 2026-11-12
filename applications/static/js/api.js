// Accesso alle API del server con il token del login (come in KINETRA Pesatura).

export function getToken() {
  try { return localStorage.getItem('token'); } catch (_) { return null; }
}

export function logout() {
  try { localStorage.removeItem('token'); } catch (_) {}
  window.location.href = '/login';
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Chiamata alle API. Restituisce il JSON della risposta.
 * In caso di 401 riporta al login; in caso di errore lancia ApiError con il messaggio del server.
 */
export async function api(path, { method = 'GET', body, query } = {}) {
  const token = getToken();
  if (!token) { logout(); throw new ApiError('Non autenticato', 401); }

  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, v);
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Authorization': `Bearer ${token}` };
  // FormData (es. upload di file): il browser imposta da solo il Content-Type multipart
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  if (res.status === 401) { logout(); throw new ApiError('Sessione scaduta', 401); }

  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const detail = data?.detail;
    const msg = typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail) : `Errore ${res.status}`);
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/** Scarica un file protetto (es. PDF) e lo apre in una nuova scheda. */
export async function openProtectedFile(path) {
  const win = window.open('', '_blank');
  try {
    const res = await fetch(path, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Errore ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (win) win.close();
    throw err;
  }
}

/** Scarica un file protetto (es. export xlsx/pdf) con il nome indicato dal server o quello passato. */
export async function downloadProtectedFile(path, fallbackName) {
  const res = await fetch(path, { headers: { 'Authorization': `Bearer ${getToken()}` } });
  if (res.status === 401) { logout(); throw new ApiError('Sessione scaduta', 401); }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(typeof data?.detail === 'string' ? data.detail : `Errore ${res.status}`, res.status, data);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Utente collegato (livello: 1 sola lettura, 2 utente, 3 amministratore, 4 super admin). */
let mePromise = null;
export function getMe() {
  if (!mePromise) mePromise = api('/api/auth/me').catch(err => { mePromise = null; throw err; });
  return mePromise;
}
