import { portalApps, type PortalRole } from './portal-policy.ts';

export interface PortalEnv {
  DB: D1Database;
  PORTAL_ADMIN_PASSWORD_HASH?: string;
  PORTAL_CLIQUE_PASSWORD_HASH?: string;
  PORTAL_CLIQUE_PASSWORD?: string;
  AUTH_THROTTLE_SALT?: string;
}

export interface PortalSession {
  tokenHash: string;
  profileId: string;
  role: PortalRole;
  inviteId: string | null;
  legacyToken: string | null;
  grants: string[];
}

export const PORTAL_COOKIE = '__Host-sp1e_session';
export const PORTAL_DEVICE_COOKIE = '__Host-sp1e_device';
export const PORTAL_COOKIE_SECONDS = 400 * 24 * 60 * 60;
const encoder = new TextEncoder();
const sessionReads = new WeakMap<Request, Promise<PortalSession | null>>();

export function portalCookieValue(request: Request, name = PORTAL_COOKIE): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim());
  const matches = values.filter(part => part.startsWith(`${name}=`));
  // Ambiguous cookies are not accepted; avoid cookie tossing precedence bugs.
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function hasPortalCookie(request: Request): boolean {
  return (request.headers.get('cookie') ?? '').split(';').some(part => part.trim().startsWith(`${PORTAL_COOKIE}=`));
}

export function portalRandomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function portalDigest(value: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function portalSetCookie(token: string, name = PORTAL_COOKIE, clear = false): string {
  return `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : PORTAL_COOKIE_SECONDS}`;
}

export function readPortalSession(request: Request, env: Pick<PortalEnv, 'DB'>): Promise<PortalSession | null> {
  const prior = sessionReads.get(request);
  if (prior) return prior;
  const pending = loadPortalSession(request, env);
  sessionReads.set(request, pending);
  return pending;
}

async function loadPortalSession(request: Request, env: Pick<PortalEnv, 'DB'>): Promise<PortalSession | null> {
  const token = portalCookieValue(request);
  if (!token) return null;
  const tokenHash = await portalDigest(token);
  const row = await env.DB.prepare(`SELECT s.token_hash, s.profile_id, s.invite_id, s.legacy_token, p.role, i.grants_json
    FROM site_portal_sessions s JOIN site_portal_profiles p ON p.id = s.profile_id
    LEFT JOIN site_portal_invites i ON i.id = s.invite_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND p.revoked_at IS NULL
      AND (s.invite_id IS NULL OR (i.revoked_at IS NULL AND i.claimed_by = p.id))`)
    .bind(tokenHash).first<{ token_hash: string; profile_id: string; invite_id: string | null; legacy_token: string | null; role: string; grants_json: string | null }>();
  if (!row || !['admin', 'clique', 'guest'].includes(row.role)) return null;
  let grants: string[] = [];
  try {
    const value: unknown = JSON.parse(row.grants_json ?? '[]');
    if (Array.isArray(value)) grants = value.filter((id): id is string => typeof id === 'string');
  } catch { /* Invalid grants confer no additional access. */ }
  return { tokenHash, profileId: row.profile_id, role: row.role as PortalRole, inviteId: row.invite_id, legacyToken: row.legacy_token, grants };
}

export function portalSessionDto(session: PortalSession | null) {
  return session ? { authenticated: true, role: session.role, apps: portalApps(session.role, session.grants), vip: Boolean(session.inviteId) }
    : { authenticated: false, role: null, apps: [], vip: false };
}

export class PortalError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function requirePortalAdmin(request: Request, env: Pick<PortalEnv, 'DB'>): Promise<PortalSession> {
  const session = await readPortalSession(request, env);
  if (!session) throw new PortalError(401, 'Logga in först.');
  if (session.role !== 'admin') throw new PortalError(403, 'Endast Admin har tillgång.');
  return session;
}

export function assertPortalOrigin(request: Request): void {
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new PortalError(403, 'Anropet måste komma från den här sidan.');
  }
}
