export type PortalRole = 'admin' | 'clique' | 'guest';

// This is the release allowlist, not a reflection of whichever directories exist.
// New apps stay owner-only until their sharing and cost boundaries are reviewed.
export const PORTAL_APPS = [
  { id: 'mosquito', label: 'Mosquito', href: '/mosquito', roles: ['admin'], inviteReady: false },
  { id: 'hub', label: 'S.P. hub', href: '/hub', roles: ['admin'], inviteReady: false },
  { id: 'casino', label: 'Casino', href: '/casino/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'sudoku', label: 'Sudoku', href: '/sudoku/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'arcade', label: 'Arkad', href: '/arcade/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'sp1epacker', label: 'Sp1ePacker', href: '/sp1epacker/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'sp-litt', label: 'Sp\\litt', href: '/sp-litt/', roles: ['admin', 'clique'], inviteReady: true },
  { id: 'calendar', label: 'Kalender', href: '/kalender/', roles: ['admin'], inviteReady: false },
  { id: 'styles', label: 'FormIndex', href: '/styles/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'uppdatering', label: 'Uppdatering', href: '/uppdatering/', roles: ['admin', 'clique', 'guest'], inviteReady: true },
  { id: 'twi', label: 'TWI', href: '/twi/', roles: ['admin'], inviteReady: false },
] as const;

export function portalApps(role: PortalRole, grants: readonly string[] = []): string[] {
  return PORTAL_APPS.filter(app => (app.roles as readonly string[]).includes(role)
    || (role === 'clique' && app.inviteReady && grants.includes(app.id))).map(app => app.id);
}

function at(path: string, prefix: string): boolean {
  return path === prefix || path === `${prefix}.html` || path.startsWith(`${prefix}/`);
}

/** Token-authenticated machine endpoints keep their existing narrow credential. */
export function isPortalMachinePath(path: string, method: string): boolean {
  return (method === 'POST' && path === '/api/calendar/import')
    || ((method === 'GET' || method === 'HEAD') && /^\/api\/calendar\/feed\/[^/]+$/.test(path))
    || ((method === 'GET' || method === 'POST') && /^\/api\/(sp-litt|vaice)\/internal\/(input\/[^/]+|callback)$/.test(path))
    || (method === 'GET' && path.startsWith('/api/fredagsfett/ical/'))
    || at(path, '/api/fredagsfett/rsvp-public') || at(path, '/fredagsfett/rsvp');
}

export function portalPageApp(path: string): string | null {
  if (at(path, '/kalender') || at(path, '/fredagsfett')) return 'calendar';
  if (at(path, '/hub')) return 'hub';
  if (at(path, '/mosquito')) return 'mosquito';
  if (at(path, '/vaice')) return 'sp-litt';
  return PORTAL_APPS.find(app => at(path, app.href.replace(/\/$/, '')))?.id ?? null;
}

export function isPortalCommonApi(path: string, method: string): boolean {
  if (method !== 'GET') return false;
  return ['/api/health', '/api/auth/check', '/api/art', '/api/news', '/api/spotify/now-playing', '/api/spotify/status'].includes(path)
    || path === '/api/artworks' || /^\/api\/artworks\/[^/]+$/.test(path) && !/\/(fetch-redon|import)$/.test(path);
}

/** Fail closed: the two visitor roles only get these named API families. */
export function portalApiApp(path: string): string {
  if (at(path, '/api/portal')) return 'portal';
  if (at(path, '/api/sudoku')) return 'sudoku';
  if (path === '/api/sync') return 'sudoku';
  if (at(path, '/api/tar')) return 'sp1epacker';
  if (at(path, '/api/fredagsfett/casino')) return 'casino';
  if (at(path, '/api/sp-litt') || at(path, '/api/vaice')) return 'sp-litt';
  if (at(path, '/api/calendar')) return 'calendar';
  if (at(path, '/api/twi')) return 'twi';
  // Old casino aliases do not open the rest of Mosquito to visitors.
  if (/^\/api\/game\/(casino\/(blackjack|roulette|holdem)\/state|action\/(blackjack|roulette|holdem)\/[^/]+)$/.test(path)) return 'casino';
  return 'owner';
}

export function canUsePortalApi(role: PortalRole, path: string, method: string, grants: readonly string[] = []): boolean {
  if (role === 'admin') return true;
  if (isPortalCommonApi(path, method)) return true;
  // Sudoku's moderation/recovery/account credentials are not portal credentials.
  if (at(path, '/api/sudoku/admin')) return false;
  const app = portalApiApp(path);
  return app !== 'owner' && app !== 'portal' && portalApps(role, grants).includes(app);
}
