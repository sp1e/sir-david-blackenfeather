import { PORTAL_APPS, type PortalRole } from './portal-policy.ts';
import {
  assertPortalOrigin, PORTAL_COOKIE, PORTAL_DEVICE_COOKIE, PORTAL_COOKIE_SECONDS,
  PortalError, portalCookieValue, portalDigest, portalRandomToken, portalSessionDto,
  portalSetCookie, readPortalSession, requirePortalAdmin, type PortalEnv,
} from './portal-session.ts';

const encoder = new TextEncoder();
const MAX_BODY_BYTES = 4096;
const WINDOW_MS = 15 * 60 * 1000;

function json(value: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

async function bodyOf(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  assertPortalOrigin(request);
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PortalError(415, 'Skicka JSON.');
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new PortalError(413, 'Anropet är för stort.'); }
      chunks.push(value);
    }
  }
  if (!size && allowEmpty) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new PortalError(400, 'Ogiltigt anrop.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PortalError(400, 'Ogiltigt anrop.');
  return body as Record<string, unknown>;
}

async function entryBudget(request: Request, env: PortalEnv, kind: string, limit: number): Promise<void> {
  // Durable, atomic and checked before PBKDF2. Concurrent guesses consume the same budget.
  const salt = env.AUTH_THROTTLE_SALT || env.PORTAL_ADMIN_PASSWORD_HASH || 'portal-public-entry-v1';
  const ipHash = await portalDigest(`${salt}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
  const windowStart = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS).toISOString();
  const row = await env.DB.prepare(`INSERT INTO auth_attempts(scope,ip_hash,window_start,attempts,last_attempt_at)
    VALUES (?,?,?,1,?) ON CONFLICT(scope,ip_hash,window_start) DO UPDATE SET attempts=attempts+1,
    last_attempt_at=excluded.last_attempt_at WHERE attempts < ? RETURNING attempts`)
    .bind(`portal-${kind}`, ipHash, windowStart, new Date().toISOString(), limit).first();
  if (!row) throw new PortalError(429, 'För många försök. Vänta en stund.');
  await env.DB.prepare(`DELETE FROM auth_attempts WHERE rowid IN
    (SELECT rowid FROM auth_attempts WHERE scope LIKE 'portal-%' AND last_attempt_at < datetime('now','-1 day') LIMIT 50)`).run();
}

function hashParts(stored: string | undefined): { iterations: number; salt: Uint8Array; digest: string } | null {
  const match = /^pbkdf2:(100000):([a-f0-9]{32,128}):([a-f0-9]{64})$/.exec(stored ?? '');
  if (!match || match[2]!.length % 2) return null;
  return { iterations: Number(match[1]), salt: Uint8Array.from(match[2]!.match(/../g)!, pair => parseInt(pair, 16)), digest: match[3]! };
}

async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const parsed = hashParts(stored);
  if (!parsed) throw new PortalError(503, 'Inloggningen är inte tillgänglig just nu.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: parsed.salt, iterations: parsed.iterations }, key, 256);
  const actual = Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ parsed.digest.charCodeAt(index);
  return difference === 0;
}

async function profileFor(request: Request, env: PortalEnv, role: PortalRole): Promise<{ id: string; device: string }> {
  const device = portalCookieValue(request, PORTAL_DEVICE_COOKIE) || portalRandomToken();
  const deviceHash = await portalDigest(device);
  const id = role === 'admin' ? 'admin' : `${role}-${deviceHash}`;
  await env.DB.prepare(`INSERT INTO site_portal_profiles(id,role,device_hash,created_at)
    VALUES (?,?,?,?) ON CONFLICT DO NOTHING`).bind(id, role, deviceHash, new Date().toISOString()).run();
  const profile = await env.DB.prepare('SELECT id FROM site_portal_profiles WHERE id=? AND role=? AND revoked_at IS NULL')
    .bind(id, role).first<{ id: string }>();
  if (!profile) throw new PortalError(403, 'Den här profilen är återkallad.');
  return { id: profile.id, device };
}

async function createSession(request: Request, env: PortalEnv, role: PortalRole, profile: { id: string; device: string }, inviteId: string | null = null, claimInvite = false): Promise<Response> {
  const old = await readPortalSession(request, env);
  const token = portalRandomToken();
  const tokenHash = await portalDigest(token);
  const legacy = role === 'admin' ? portalRandomToken() : null;
  const now = new Date().toISOString();
  const statements = [];
  if (claimInvite && inviteId) {
    // Claim and session creation share one transaction. A losing redemption
    // cannot revoke an existing login or leave a consumed, unusable invite.
    statements.push(env.DB.prepare(`UPDATE site_portal_invites SET claimed_at=?,claimed_by=?,claimed_session_hash=?
      WHERE id=? AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at>?`)
      .bind(now, profile.id, tokenHash, inviteId, now));
    statements.push(env.DB.prepare(`INSERT INTO site_portal_sessions(token_hash,profile_id,invite_id,legacy_token,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM site_portal_invites WHERE id=? AND claimed_session_hash=?)`)
      .bind(tokenHash, profile.id, inviteId, legacy, now, inviteId, tokenHash));
  } else {
    statements.push(env.DB.prepare(`INSERT INTO site_portal_sessions(token_hash,profile_id,invite_id,legacy_token,created_at)
      VALUES (?,?,?,?,?)`).bind(tokenHash, profile.id, inviteId, legacy, now));
  }
  if (legacy) statements.push(env.DB.prepare('INSERT INTO sessions(token,expires_at) VALUES (?,?)').bind(legacy, '9999-12-31T23:59:59.000Z'));
  if (old) statements.push(env.DB.prepare(`UPDATE site_portal_sessions SET revoked_at=? WHERE token_hash=?
    AND EXISTS(SELECT 1 FROM site_portal_sessions WHERE token_hash=?)`).bind(now, old.tokenHash, tokenHash));
  if (old?.legacyToken) statements.push(env.DB.prepare(`DELETE FROM sessions WHERE token=?
    AND EXISTS(SELECT 1 FROM site_portal_sessions WHERE token_hash=?)`).bind(old.legacyToken, tokenHash));
  const results = await env.DB.batch(statements);
  if (claimInvite && !results[0]!.meta.changes) throw new PortalError(401, 'Inviten är ogiltig eller har redan använts.');
  const grants = inviteId ? (await env.DB.prepare('SELECT grants_json FROM site_portal_invites WHERE id=?').bind(inviteId).first<{ grants_json: string }>())?.grants_json : '[]';
  const cookies = [portalSetCookie(token), portalSetCookie(profile.device, PORTAL_DEVICE_COOKIE),
    legacy ? legacySiteCookie(legacy) : 'session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'];
  if (old && old.role !== role) {
    for (const name of ['calendar_session', 'ff_session', 'ff_admin_session', 'game_session', 'game_admin_session']) {
      cookies.push(`${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    }
    cookies.push('sudoku_session=; Path=/api/sudoku; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  }
  return json(portalSessionDto({ tokenHash, profileId: profile.id, role, inviteId, legacyToken: legacy, grants: JSON.parse(grants ?? '[]') }), 200, cookies);
}

export function legacySiteCookie(token: string): string {
  return `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${PORTAL_COOKIE_SECONDS}`;
}

async function login(request: Request, env: PortalEnv): Promise<Response> {
  const body = await bodyOf(request);
  if ((body.role !== 'admin' && body.role !== 'clique') || typeof body.password !== 'string' || !body.password || body.password.length > 128) {
    throw new PortalError(400, 'Välj Admin eller Clique och ange lösenordet.');
  }
  await entryBudget(request, env, 'login', 12);
  const stored = body.role === 'admin' ? env.PORTAL_ADMIN_PASSWORD_HASH : env.PORTAL_CLIQUE_PASSWORD_HASH;
  if (!await verifyPassword(body.password, stored)) throw new PortalError(401, 'Fel lösenord.');
  const profile = await profileFor(request, env, body.role);
  const invite = body.role === 'clique' ? await env.DB.prepare(`SELECT id FROM site_portal_invites
    WHERE claimed_by=? AND revoked_at IS NULL ORDER BY claimed_at DESC LIMIT 1`).bind(profile.id).first<{ id: string }>() : null;
  return createSession(request, env, body.role, profile, invite?.id ?? null);
}

async function logout(request: Request, env: PortalEnv): Promise<Response> {
  await bodyOf(request, true);
  const session = await readPortalSession(request, env);
  if (session) {
    const statements = [env.DB.prepare('UPDATE site_portal_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(new Date().toISOString(), session.tokenHash)];
    if (session.legacyToken) statements.push(env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(session.legacyToken));
    await env.DB.batch(statements);
  }
  const cookies = [portalSetCookie('', PORTAL_COOKIE, true),
    ...['session', 'calendar_session', 'ff_session', 'ff_admin_session', 'game_session', 'game_admin_session'].map(name => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`),
    'sudoku_session=; Path=/api/sudoku; HttpOnly; Secure; SameSite=Lax; Max-Age=0'];
  // The device cookie is a data-profile hint, not authorization. Keep it so a
  // later successful login restores this visitor's own saves and casino chips.
  return json({ success: true }, 200, cookies);
}

async function redeem(request: Request, env: PortalEnv): Promise<Response> {
  const body = await bodyOf(request);
  await entryBudget(request, env, 'invite', 30);
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new PortalError(401, 'Inviten är ogiltig eller har redan använts.');
  const now = new Date().toISOString();
  const hash = await portalDigest(body.token);
  const invite = await env.DB.prepare(`SELECT id FROM site_portal_invites
    WHERE token_hash=? AND revoked_at IS NULL AND claimed_at IS NULL AND expires_at>?`).bind(hash, now).first<{ id: string }>();
  if (!invite) throw new PortalError(401, 'Inviten är ogiltig eller har redan använts.');
  const profile = await profileFor(request, env, 'clique');
  return createSession(request, env, 'clique', profile, invite.id, true);
}

async function adminInvites(request: Request, env: PortalEnv): Promise<Response> {
  await requirePortalAdmin(request, env);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT id,label,grants_json,created_at,expires_at,claimed_at,revoked_at
      FROM site_portal_invites ORDER BY created_at DESC LIMIT 100`).all();
    return json({ invites: results ?? [], apps: PORTAL_APPS.map(({ id, label, inviteReady }) => ({ id, label, inviteReady })) });
  }
  const body = await bodyOf(request);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 80) throw new PortalError(400, 'Ge inviten ett namn på högst 80 tecken.');
  const grants = Array.isArray(body.grants) ? [...new Set(body.grants)] : [];
  if (grants.some(id => typeof id !== 'string' || !PORTAL_APPS.some(app => app.id === id && app.inviteReady))) {
    throw new PortalError(400, 'Programmet är inte klart för inbjudningar.');
  }
  const days = body.days === undefined ? 7 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new PortalError(400, 'Välj 1–30 dagar.');
  const id = crypto.randomUUID();
  const token = portalRandomToken();
  await env.DB.prepare(`INSERT INTO site_portal_invites(id,token_hash,label,grants_json,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`).bind(id, await portalDigest(token), label, JSON.stringify(grants), new Date().toISOString(), new Date(Date.now() + days * 86400000).toISOString()).run();
  // The one-time credential only occurs in the fragment. It is never sent in a
  // navigation request, Referer header, server access log or subsequent listing.
  const url = new URL('/', request.url);
  url.hash = `invite=${token}`;
  return json({ id, url: url.toString() }, 201);
}

export async function handlePortalRequest(request: Request, env: PortalEnv, route?: string): Promise<Response> {
  const path = route ?? new URL(request.url).pathname.replace(/^\/api\/portal\/?/, '');
  try {
    if (request.method === 'GET' && path === 'session') {
      const session = await readPortalSession(request, env);
      const token = portalCookieValue(request);
      const cookies = session && token ? [portalSetCookie(token), ...(session.legacyToken ? [legacySiteCookie(session.legacyToken)] : [])] : [];
      return json(portalSessionDto(session), 200, cookies);
    }
    if (request.method === 'POST' && path === 'login') return await login(request, env);
    if (request.method === 'POST' && path === 'guest') {
      await bodyOf(request);
      await entryBudget(request, env, 'guest', 60);
      return await createSession(request, env, 'guest', await profileFor(request, env, 'guest'));
    }
    if (request.method === 'POST' && path === 'logout') return await logout(request, env);
    if (request.method === 'POST' && path === 'invites/redeem') return await redeem(request, env);
    if (['GET', 'POST'].includes(request.method) && path === 'admin/invites') return await adminInvites(request, env);
    const revoke = /^admin\/invites\/([a-zA-Z0-9-]+)$/.exec(path);
    if (request.method === 'DELETE' && revoke) {
      await requirePortalAdmin(request, env);
      await bodyOf(request);
      await env.DB.prepare('UPDATE site_portal_invites SET revoked_at=? WHERE id=?').bind(new Date().toISOString(), revoke[1]!).run();
      return json({ success: true });
    }
    if (request.method === 'GET' && path === 'admin/clique-password') {
      await requirePortalAdmin(request, env);
      if (!env.PORTAL_CLIQUE_PASSWORD) throw new PortalError(503, 'Lösenordet är inte tillgängligt just nu.');
      return json({ password: env.PORTAL_CLIQUE_PASSWORD });
    }
    return json({ error: 'Sidan finns inte.' }, 404);
  } catch (error) {
    if (error instanceof PortalError) return json({ error: error.message }, error.status);
    // No raw DB errors, tokens, password configuration or request bodies in logs.
    console.error('portal request failed');
    return json({ error: 'Tjänsten är inte tillgänglig just nu.' }, 500);
  }
}
