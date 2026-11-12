// Impostazioni › Utenti: profilo dell'utente collegato e gestione degli utenti (amministratori).
// Livelli: 1 sola lettura, 2 utente, 3 amministratore, 4 super admin.
// Si gestiscono solo utenti di livello inferiore al proprio; il super admin gestisce tutti (regola del server).

import { api, logout } from '../api.js';
import { esc, toast, openDialog, confirmDialog, ICON } from '../ui.js';

const LEVELS = {
  1: { label: 'Sola lettura', help: 'Vede impianto, allarmi e report ma non può modificare nulla. Adatto al cliente.' },
  2: { label: 'Utente', help: 'Come sola lettura, in più prende in carico gli allarmi. Adatto ai tecnici.' },
  3: { label: 'Amministratore', help: 'Configura impianto, dispositivi e soglie; gestisce gli utenti di livello inferiore.' },
  4: { label: 'Super admin', help: 'Accesso completo, compresa la gestione degli amministratori.' },
};
const ADMIN = 3, SUPER_ADMIN = 4;

export function renderUtenti(el, { me }) {
  const level = me?.level ?? 0;
  const canManage = l => level === SUPER_ADMIN || l < level;
  el.innerHTML = `
    <section class="card settings-section">
      <header><h3>Il mio profilo</h3><p class="muted">Utente collegato.</p></header>
      <div class="settings-rows">
        <div class="settings-row"><span class="settings-text"><span class="settings-label">${esc(me?.username || '')}</span>
          <span class="settings-help">${esc(me?.description || '')}${me?.description ? ' · ' : ''}${esc(LEVELS[level]?.label || 'Livello ' + level)}</span></span>
          <span class="page-actions"><button type="button" class="btn" data-a="password">Cambia password</button></span>
        </div>
      </div>
    </section>
    ${level >= ADMIN ? `
    <section class="card settings-section">
      <header class="settings-head-actions"><div><h3>Utenti</h3><p class="muted">${level === SUPER_ADMIN ? 'Puoi gestire tutti gli utenti.' : 'Puoi gestire gli utenti con un livello inferiore al tuo.'}</p></div>
        <button type="button" class="btn primary" data-a="add">+ Nuovo utente</button></header>
      <div class="users-list"><p class="muted" style="padding:12px 18px">Caricamento…</p></div>
    </section>
    <section class="card settings-section"><header><h3>Livelli di accesso</h3></header><div class="settings-rows">
      ${Object.values(LEVELS).map(l => `<div class="settings-row"><span class="settings-text"><span class="settings-label">${esc(l.label)}</span><span class="settings-help">${esc(l.help)}</span></span></div>`).join('')}
    </div></section>` : ''}`;

  el.querySelector('[data-a="password"]').addEventListener('click', () => changePassword());
  if (level < ADMIN) return;

  const listEl = el.querySelector('.users-list');
  el.querySelector('[data-a="add"]').addEventListener('click', () => userForm(null));
  const assignable = () => Object.entries(LEVELS).filter(([n]) => canManage(Number(n)));

  async function load() {
    try {
      const { users } = await api('/api/users');
      listEl.innerHTML = `<table class="dt-table"><thead><tr class="dt-head"><th>Utente</th><th>Descrizione</th><th>Livello</th><th class="dt-actions-h"><span class="sr">Azioni</span></th></tr></thead>
        <tbody>${users.map(u => `<tr class="dt-row">
          <td><strong>${esc(u.username)}</strong>${u.id === me.id ? ' <span class="badge info">tu</span>' : ''}${u.must_change_password ? ' <span class="badge warn">password provvisoria</span>' : ''}</td>
          <td>${esc(u.description || '') || '<span class="muted">—</span>'}</td>
          <td><span class="badge">${esc(LEVELS[u.level]?.label || u.level)}</span></td>
          <td class="dt-actions">${u.id !== me.id && canManage(u.level) ? `
            <button type="button" class="dt-act" data-edit="${u.id}" title="Modifica" aria-label="Modifica ${esc(u.username)}">${ICON.edit}</button>
            <button type="button" class="dt-act" data-reset="${u.id}" title="Nuova password" aria-label="Nuova password per ${esc(u.username)}">${ICON.key}</button>
            <button type="button" class="dt-act danger" data-del="${u.id}" title="Elimina" aria-label="Elimina ${esc(u.username)}">${ICON.delete}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
      const byId = id => users.find(u => u.id === Number(id));
      listEl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => userForm(byId(b.dataset.edit))));
      listEl.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => resetPassword(byId(b.dataset.reset))));
      listEl.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
        const u = byId(b.dataset.del);
        const ok = await confirmDialog('Eliminare l\'utente?', `<p>L'utente <strong>${esc(u.username)}</strong> non potrà più accedere.</p>`,
          { label: 'Elimina', kind: 'danger', onConfirm: () => api(`/api/users/${u.id}`, { method: 'DELETE' }) });
        if (ok) { toast('Utente eliminato', 'ok'); load(); }
      }));
    } catch (err) {
      listEl.innerHTML = `<p class="dt-empty err">Impossibile caricare gli utenti: ${esc(err.message)}</p>`;
    }
  }

  function userForm(u) {
    const levelOptions = sel => assignable().map(([n, l]) => `<option value="${n}" ${Number(n) === sel ? 'selected' : ''}>${esc(l.label)}</option>`).join('');
    openDialog({
      title: u ? `Modifica ${u.username}` : 'Nuovo utente',
      body: `<div class="form-grid">
        ${u ? '' : '<label class="field">Nome utente<input class="input" name="username" required maxlength="40" autocomplete="off"></label>'}
        <label class="field">Descrizione <em>(es. nome e ruolo)</em><input class="input" name="description" value="${esc(u?.description || '')}"></label>
        <label class="field">Livello<select class="input" name="level">${levelOptions(u?.level ?? 1)}</select></label>
        ${u ? '' : '<label class="field">Password provvisoria <em>(almeno 6 caratteri)</em><input class="input" name="password" type="password" minlength="6" required autocomplete="new-password"></label>'}
      </div>${u ? '' : '<p class="muted">Al primo accesso il nuovo utente dovrà scegliere una sua password.</p>'}`,
      actions: [{ label: 'Annulla', value: null }, { label: u ? 'Salva' : 'Crea utente', kind: 'primary', submit: true }],
      onSubmit: async f => {
        const body = { description: f.description.value.trim(), level: Number(f.level.value) };
        if (u) await api(`/api/users/${u.id}`, { method: 'PUT', body });
        else await api('/api/users', { method: 'POST', body: { ...body, username: f.username.value.trim(), password: f.password.value } });
      },
    }).then(r => { if (r) { toast(u ? 'Utente aggiornato' : 'Utente creato', 'ok'); load(); } });
  }

  function resetPassword(u) {
    openDialog({
      title: `Nuova password per ${u.username}`,
      body: `<label class="field">Password provvisoria <em>(almeno 6 caratteri)</em><input class="input" name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <p class="muted">L'utente dovrà cambiarla al prossimo accesso.</p>`,
      actions: [{ label: 'Annulla', value: null }, { label: 'Imposta', kind: 'primary', submit: true }],
      onSubmit: f => api(`/api/users/${u.id}`, { method: 'PUT', body: { password: f.password.value } }),
    }).then(r => { if (r) { toast('Password reimpostata', 'ok'); load(); } });
  }

  load();
}

/** Cambio della propria password. forced: password provvisoria, non si può saltare. */
export function changePassword({ forced = false } = {}) {
  return openDialog({
    title: forced ? 'Scegli una nuova password' : 'Cambia password',
    body: `${forced ? '<p class="settings-notice">Stai usando una password provvisoria: per sicurezza scegline una nuova prima di continuare.</p>' : ''}
      <label class="field">Password attuale<input class="input" name="old" type="password" required autocomplete="current-password"></label>
      <label class="field">Nuova password <em>(almeno 6 caratteri)</em><input class="input" name="new" type="password" minlength="6" required autocomplete="new-password"></label>
      <label class="field">Ripeti la nuova password<input class="input" name="repeat" type="password" minlength="6" required autocomplete="new-password"></label>`,
    actions: [{ label: forced ? 'Esci' : 'Annulla', value: null }, { label: 'Salva password', kind: 'primary', submit: true }],
    onSubmit: async f => {
      if (f.new.value !== f.repeat.value) throw new Error('Le due password non coincidono.');
      await api('/api/auth/password', { method: 'POST', body: { old_password: f.old.value, new_password: f.new.value } });
      toast('Password aggiornata', 'ok');
    },
  });
}

/** Al primo accesso con password provvisoria: o la cambia o esce. */
export async function forcePasswordChange() {
  const ok = await changePassword({ forced: true });
  if (!ok) { logout(); throw new Error('Cambio password annullato'); }
}
