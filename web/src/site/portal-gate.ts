import { canUsePortalApi, isPortalCommonApi, isPortalMachinePath, portalApps, portalPageApp } from './portal-policy';
import { legacySiteCookie } from './portal-api';
import { assertPortalOrigin, PortalError, portalCookieValue, portalSetCookie, readPortalSession, type PortalEnv } from './portal-session';

function denied(request: Request, api: boolean, status: number): Response {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (api) return new Response(JSON.stringify({ error: status === 401 ? 'Logga in först.' : 'Du har inte tillgång till den här appen.' }), { status, headers });
  const target = new URL('/', request.url);
  const requested = new URL(request.url);
  target.searchParams.set('next', requested.pathname + requested.search);
  return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
}

/** Returns a refusal or null. Downstream APIs still verify their own capability. */
export async function checkPortalGate(request: Request, env: PortalEnv, path: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const api = path.startsWith('/api/');
  // Private companion assets are gated before the public static extension rule.
  if (path === '/admin' || path === '/admin.html' || path.startsWith('/admin/')) {
    const owner = await readPortalSession(request, env);
    if (!owner) return denied(request, false, 401);
    if (owner.role !== 'admin') return denied(request, false, 403);
    return null;
  }
  // A preflight reveals no models and cannot invoke a provider. The handler
  // repeats role validation before metadata, parsing, quota or provider access.
  if (path === '/api/assistant' || path.startsWith('/api/assistant/')) {
    if (method === 'OPTIONS') return null;
    const session = await readPortalSession(request, env);
    if (!session) return denied(request, true, 401);
    if (!['admin','clique'].includes(session.role)) return denied(request, true, 403);
    return null;
  }
  if (isPortalMachinePath(path, method)) return null;
  if (path === '/casino/login' || path.startsWith('/casino/login/')) {
    return new Response(null, { status: 302, headers: { Location: new URL('/casino/', request.url).toString(), 'Cache-Control': 'no-store' } });
  }
  if (path.startsWith('/api/portal/')) return null; // Each portal handler checks its own role and origin.
  if (path === '/api/workspaces' || path.startsWith('/api/workspaces/')) return null; // Workspace handler requires session and resource membership.
  if (!api && ['GET','HEAD'].includes(method) && ['/workspaces','/workspaces/','/workspaces/index.html'].includes(path)) return null;
  // This browser-only workshop and reviewed companion contain no account data.
  // Connector APIs keep their own authentication and app-permission checks.
  if (!api && ['GET','HEAD'].includes(method) && ['/gadgets','/gadgets/','/gadgets/index.html','/assets/setup/sp1e-local-agents.zip'].includes(path)) return null;
  if (['/api/connectors/catalog','/api/connectors/connect','/api/connectors/call'].includes(path)) return null; // Connector handler re-checks session, app permission and action scope.
  // The consent page contains no account data; its catalog and calls enforce session permissions.
  if (!api && ['GET','HEAD'].includes(method) && ['/connectors','/connectors/','/connectors/index.html'].includes(path)) return null;
  if (isPortalCommonApi(path, method)) return null;
  if (method === 'GET' && (path === '/api/sudoku/session' || path.startsWith('/api/tar/'))) return null;
  if (!api && /\.(css|js|mjs|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|wasm)$/i.test(path)) return null;
  const app = portalPageApp(path);
  // Published guest pages really are public, including a direct casino link.
  // Their data APIs still require an opaque guest profile or an app credential.
  if (!api && app && portalApps('guest').includes(app)) return null;
  if (!api && !app && (path === '/' || path === '/index.html' || /\.(mp4|webm|mp3|wav|ogg|flac)$/i.test(path))) return null;

  const session = await readPortalSession(request, env);
  if (!session) return denied(request, api, 401);
  if (api && /^\/api\/(auth|game|calendar|sudoku|fredagsfett)\/(?:admin\/)?(?:admin-)?logout$/.test(path) && method === 'POST') {
    try { assertPortalOrigin(request); return null; }
    catch { return denied(request, true, 403); }
  }
  if (api ? !canUsePortalApi(session.role, path, method, session.grants)
    : session.role !== 'admin' && (!app || !portalApps(session.role, session.grants).includes(app))) {
    return denied(request, api, 403);
  }
  if (api && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    try { assertPortalOrigin(request); }
    catch (error) { if (error instanceof PortalError) return denied(request, true, error.status); throw error; }
  }
  return null;
}

/** Renew on real requests, so regular use has no seven-day re-login. */
export async function renewPortalResponse(request: Request, env: PortalEnv, response: Response): Promise<Response> {
  const session = await readPortalSession(request, env);
  const token = portalCookieValue(request);
  if (!session || !token) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', portalSetCookie(token));
  if (session.legacyToken) headers.append('Set-Cookie', legacySiteCookie(session.legacyToken));
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
