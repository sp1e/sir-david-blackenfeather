const APPS = {
  mosquito: ['/mosquito', 'mosquito-btn'], hub: ['/hub', 'hub-btn'], casino: ['/casino/', 'casino-btn'],
  sudoku: ['/sudoku/', 'sudoku-btn'], arcade: ['/arcade/', 'arcade-btn'], sp1epacker: ['/sp1epacker/', 'sp1epacker-btn'],
  'sp-litt': ['/sp-litt/', 'vaice-btn'], calendar: ['/kalender/', 'kalender-btn'],
  styles: ['/styles/', 'styles-btn'], uppdatering: ['/uppdatering/', 'uppdatering-btn'], twi: ['/twi/', null],
};

export function allowedNext(raw, apps, origin, role = null) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    const path = decodeURIComponent(url.pathname).replace(/\/+/g, '/');
    if (path === '/') return '/';
    if (role === 'admin' && ['/admin','/admin/','/admin.html','/admin/index.html'].includes(path)) return url.pathname + url.search;
    for (const app of apps) {
      const base = APPS[app]?.[0].replace(/\/$/, '');
      if (base && (path === base || path === `${base}.html` || path.startsWith(`${base}/`))) return url.pathname + url.search;
    }
  } catch { /* An invalid target cannot become a navigation. */ }
  return null;
}

export async function portalJson(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Tjänsten är inte tillgänglig just nu.');
  return body;
}

const post = (path, body = {}) => portalJson(path, { method: 'POST', body: JSON.stringify(body) });

export async function ensurePublicPortalSession() {
  const session = await portalJson('/api/portal/session');
  return session.authenticated ? session : post('/api/portal/guest');
}

export async function initPortal() {
  const gate = document.getElementById('portal-gate');
  if (!gate) return;
  const card = gate.querySelector('.portal-card');
  const error = document.getElementById('portal-error');
  const password = document.getElementById('portal-password');
  const form = document.getElementById('portal-login-form');
  const roles = [...gate.querySelectorAll('[data-role]')];
  const tools = document.getElementById('portal-tools');
  const admin = document.getElementById('portal-admin');
  let active = null;
  let role = 'clique';
  let busy = false;
  let epoch = 0;
  let inputVersion = 0;
  let observedPassword = password.value;
  let composing = false;
  let loginTimer = null;
  let lastAttempt = null;
  const covered = new Set();
  let target = new URLSearchParams(location.search).get('next');
  const started = performance.now();
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (inviteToken) history.replaceState({}, '', location.pathname + location.search);

  function coverPage() {
    for (const element of document.body.children) {
      if (element === gate || ['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName) || element.hasAttribute('inert')) continue;
      element.setAttribute('inert', '');
      covered.add(element);
    }
  }
  coverPage();

  function cancelLogin() {
    clearTimeout(loginTimer);
    loginTimer = null;
  }

  function scheduleLogin() {
    cancelLogin();
    if (busy || composing || gate.hidden || !password.value) return;
    if (lastAttempt?.role === role && lastAttempt.value === password.value) return;
    loginTimer = setTimeout(attemptLogin, 1000);
  }

  function showGate(message = '') {
    coverPage();
    document.documentElement.classList.add('portal-pending', 'portal-revealed');
    gate.hidden = false;
    gate.classList.add('is-visible');
    card.classList.add('is-visible');
    error.textContent = message;
    password.focus();
    scheduleLogin();
  }

  function apply(session) {
    cancelLogin();
    lastAttempt = null;
    password.removeAttribute('aria-invalid');
    epoch++;
    active = session;
    window.Sp1ePortalSession = { authenticated: session.authenticated, role: session.role };
    document.dispatchEvent(new CustomEvent('portal:session', { detail: window.Sp1ePortalSession }));
    for (const [id, [, button]] of Object.entries(APPS)) {
      if (button) document.getElementById(button).hidden = !session.apps.includes(id);
    }
    const designLink = document.getElementById('design-mirror-btn');
    if (designLink) designLink.hidden = session.role !== 'admin';
    if (admin.open) admin.close();
    document.getElementById('portal-clique-secret').textContent = '';
    document.body.toggleAttribute('data-world-admin', session.role === 'admin');
    document.dispatchEvent(new CustomEvent('landing-world:admin', { detail: { active: session.role === 'admin' } }));
    // Keep the already revealed world visible when the site controls become available.
    document.documentElement.classList.remove('portal-pending');
    for (const element of covered) element.removeAttribute('inert');
    covered.clear();
    gate.hidden = true;
    tools.hidden = false;
    const label = session.role === 'admin' ? 'Admin' : session.role === 'clique' ? `Clique${session.vip ? ' · VIP' : ''}` : 'Guest';
    document.getElementById('portal-profile').textContent = label;
    document.getElementById('portal-profile').setAttribute('aria-label', `${label} · Byt profil`);
    tools.querySelector('[data-admin-note]').hidden = session.role !== 'admin';
    password.value = '';
    observedPassword = '';
    const next = allowedNext(target, session.apps, location.origin, session.role);
    target = null;
    if (next && next !== '/') location.assign(next);
    else if (location.search.includes('next=')) history.replaceState({}, '', '/');
  }

  async function enter(action, attempt = null) {
    if (busy) return;
    cancelLogin();
    busy = true;
    const ownEpoch = epoch;
    gate.setAttribute('aria-busy', 'true');
    error.textContent = '';
    gate.querySelectorAll('button,input').forEach(element => { element.disabled = !attempt || element !== password; });
    const isCurrent = () => ownEpoch === epoch && (!attempt || attempt.version === inputVersion);
    try { const session = await action(); if (isCurrent()) apply(session); }
    catch (problem) {
      if (isCurrent()) {
        error.textContent = problem.message || 'Nätverksfel. Försök igen.';
        if (attempt) password.setAttribute('aria-invalid', 'true');
      }
    }
    finally {
      busy = false;
      gate.removeAttribute('aria-busy');
      gate.querySelectorAll('button,input').forEach(element => { element.disabled = false; });
      if (!gate.hidden) password.focus();
      if (attempt && attempt.version !== inputVersion) scheduleLogin();
    }
  }

  function attemptLogin() {
    cancelLogin();
    if (busy || composing || gate.hidden || !password.value) return;
    const attempt = { role, value: password.value, version: inputVersion };
    lastAttempt = attempt;
    enter(() => post('/api/portal/login', { role: attempt.role, password: attempt.value }), attempt);
  }

  function changedPassword() {
    // Autofill and blur can dispatch change after input without changing the value.
    if (password.value === observedPassword) { scheduleLogin(); return; }
    observedPassword = password.value;
    inputVersion++;
    error.textContent = '';
    password.removeAttribute('aria-invalid');
    scheduleLogin();
  }
  password.addEventListener('input', changedPassword);
  password.addEventListener('change', changedPassword);
  password.addEventListener('compositionstart', () => { composing = true; cancelLogin(); });
  password.addEventListener('compositionend', () => { composing = false; changedPassword(); });

  roles.forEach(button => button.addEventListener('click', () => {
    cancelLogin();
    inputVersion++;
    lastAttempt = null;
    role = button.dataset.role;
    roles.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    form.querySelector('[name="username"]').value = role === 'admin' ? 'Admin' : 'Clique';
    password.value = '';
    observedPassword = '';
    error.textContent = '';
    password.removeAttribute('aria-invalid');
    password.focus();
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!password.value) { error.textContent = 'Ange lösenordet.'; password.focus(); return; }
    attemptLogin();
  });
  document.getElementById('portal-guest').addEventListener('click', () => enter(() => post('/api/portal/guest')));
  document.getElementById('portal-profile').addEventListener('click', () => showGate());
  document.getElementById('portal-logout').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      await post('/api/portal/logout');
      window.Sp1ePortalSession = { authenticated: false, role: null };
      document.dispatchEvent(new CustomEvent('portal:session', { detail: window.Sp1ePortalSession }));
      location.assign('/');
    }
    catch (problem) { busy = false; showGate(problem.message); }
  });
  document.addEventListener('portal:open', event => {
    const next = active && allowedNext(event.detail?.target, active.apps, location.origin, active.role);
    if (next) location.assign(next);
    else { target = event.detail?.target || null; showGate(); }
  });
  gate.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !busy) { apply(active); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...gate.querySelectorAll('button:not(:disabled),input:not(:disabled):not([type="hidden"])')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  const status = document.getElementById('portal-admin-status');
  const secret = document.getElementById('portal-clique-secret');
  const inviteUrl = document.getElementById('portal-invite-url');
  const inviteList = document.getElementById('portal-invites-list');

  async function loadInvites() {
    const ownEpoch = epoch;
    const data = await portalJson('/api/portal/admin/invites');
    if (ownEpoch !== epoch || active?.role !== 'admin' || !admin.open) return;
    inviteList.replaceChildren();
    for (const invite of data.invites) {
      const item = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = invite.label;
      const note = document.createElement('small');
      note.textContent = invite.revoked_at ? 'Återkallad' : invite.claimed_at ? 'Aktiv VIP' : Date.parse(invite.expires_at) <= Date.now() ? 'Utgången' : 'Väntar på första besöket';
      info.append(note);
      item.append(info);
      if (!invite.revoked_at) {
        const revoke = document.createElement('button');
        revoke.type = 'button'; revoke.textContent = 'Återkalla';
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await portalJson(`/api/portal/admin/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE', body: '{}' }); await loadInvites(); }
          catch (problem) { if (ownEpoch === epoch) status.textContent = problem.message; revoke.disabled = false; }
        });
        item.append(revoke);
      }
      inviteList.append(item);
    }
  }

  tools.querySelector('[data-admin-note]').addEventListener('click', async () => {
    if (active?.role !== 'admin') return;
    admin.showModal(); status.textContent = '';
    try { await loadInvites(); } catch (problem) { status.textContent = problem.message; }
  });
  admin.querySelector('[data-close]').addEventListener('click', () => admin.close());
  admin.addEventListener('close', () => { secret.textContent = ''; inviteUrl.textContent = ''; document.getElementById('portal-copy-invite').hidden = true; });
  document.getElementById('portal-reveal-password').addEventListener('click', async event => {
    if (secret.textContent) { secret.textContent = ''; event.currentTarget.textContent = 'Visa Clique-lösenord'; return; }
    const ownEpoch = epoch;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const data = await portalJson('/api/portal/admin/clique-password');
      if (ownEpoch === epoch && active?.role === 'admin' && admin.open) { secret.textContent = data.password; button.textContent = 'Dölj Clique-lösenord'; }
    } catch (problem) { if (ownEpoch === epoch) status.textContent = problem.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('portal-invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const ownEpoch = epoch;
    const button = event.currentTarget.querySelector('button');
    button.disabled = true; status.textContent = '';
    try {
      const data = await post('/api/portal/admin/invites', { label: document.getElementById('portal-invite-label').value, days: 7, grants: [] });
      if (ownEpoch !== epoch || active?.role !== 'admin' || !admin.open) return;
      inviteUrl.textContent = data.url;
      document.getElementById('portal-copy-invite').hidden = false;
      await loadInvites();
    } catch (problem) { if (ownEpoch === epoch) status.textContent = problem.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('portal-copy-invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteUrl.textContent); status.textContent = 'Länken är kopierad.'; }
    catch { status.textContent = 'Markera länken och kopiera den.'; }
  });

  const bootEpoch = epoch;
  try {
    let session = await portalJson('/api/portal/session');
    if (bootEpoch !== epoch) return;
    if (inviteToken && session.role !== 'admin') session = await post('/api/portal/invites/redeem', { token: inviteToken });
    if (bootEpoch !== epoch) return;
    if (session.authenticated) { apply(session); return; }
    const remaining = 1000 - (performance.now() - started);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (bootEpoch === epoch) showGate();
  } catch (problem) {
    const remaining = 1000 - (performance.now() - started);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    if (bootEpoch === epoch) showGate(problem.message || 'Nätverksfel. Försök igen.');
  }
}

if (typeof document !== 'undefined' && document.getElementById('portal-gate')) initPortal();
