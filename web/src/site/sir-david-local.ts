import { PortalError, type PortalEnv, type PortalSession } from './portal-session';

interface LocalTurn {
  id: string;
  expected_version: number;
  expires_at: number;
  messages_json: string;
}
interface Message { role: string; content: string }
// Recheck identity inside each D1 transaction, even if revocation follows the HTTP guard.
const SESSION_VALID = `EXISTS (
  SELECT 1 FROM site_portal_sessions s JOIN site_portal_profiles p ON p.id=s.profile_id
  LEFT JOIN site_portal_invites i ON i.id=s.invite_id
  WHERE s.token_hash=? AND s.profile_id=? AND s.revoked_at IS NULL
    AND p.revoked_at IS NULL AND p.role='admin'
    AND (s.invite_id IS NULL OR (i.revoked_at IS NULL AND i.claimed_by=p.id))
)`;
const CONFLICT = 'Samtalet har ändrats eller anslutningen har gått ut. Läs in det igen.';
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) {
    throw new PortalError(400, 'Samtalets anrop saknas.');
  }
  return value;
}
export async function prepareLocalTurn(
  env: PortalEnv, session: PortalSession, expected: number, content: string,
  persona: string, notes: string[],
) {
  const owner = session.profileId, now = Date.now(), turnId = crypto.randomUUID(), expiresAt = now + 180_000;
  await env.DB.prepare("INSERT OR IGNORE INTO site_companion_conversations(owner_id,version,messages_json) VALUES (?,0,'[]')").bind(owner).run();
  const prior = await env.DB.prepare('SELECT version,messages_json FROM site_companion_conversations WHERE owner_id=?')
    .bind(owner).first<{ version: number; messages_json: string }>();
  if (!prior || prior.version !== expected) throw new PortalError(409, CONFLICT);
  const messages: Message[] = [...JSON.parse(prior.messages_json), { role: 'user', content }].slice(-15);
  while (messages.length > 1 && messages.reduce((sum, item) => sum + item.content.length, 0) > 16_000) messages.shift();
  const savedNotes: string[] = [];
  for (const note of notes.slice(0, 100)) {
    if (typeof note !== 'string' || note.length > 1000) throw new PortalError(503, 'Minnet behöver uppdateras.');
    if (JSON.stringify([...savedNotes, note]).length > 20_000) break;
    savedNotes.push(note);
  }
  // Cleanup and reservation are one serialized transaction. Only this owner's stale turns are removed.
  const stale = `SELECT id FROM site_companion_local_turns WHERE owner_id=?
    AND (expires_at<=? OR expected_version<>(SELECT version FROM site_companion_conversations WHERE owner_id=?))`;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM site_companion_leases WHERE owner_id=? AND kind='chat'
      AND (expires_at<=? OR token IN (${stale}))`).bind(owner, now, owner, now, owner),
    env.DB.prepare(`DELETE FROM site_companion_local_turns WHERE id IN (${stale})`).bind(owner, now, owner),
    env.DB.prepare(`INSERT OR IGNORE INTO site_companion_local_turns(id,owner_id,session_hash,expected_version,expires_at,messages_json)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM site_companion_conversations WHERE owner_id=? AND version=?)
      AND NOT EXISTS(SELECT 1 FROM site_companion_leases WHERE owner_id=? AND kind='chat')
      AND ${SESSION_VALID}`).bind(turnId, owner, session.tokenHash, expected, expiresAt, JSON.stringify(messages), owner, expected, owner, session.tokenHash, owner),
    env.DB.prepare(`INSERT INTO site_companion_leases(owner_id,kind,token,expires_at)
      SELECT owner_id,'chat',id,expires_at FROM site_companion_local_turns WHERE id=?`).bind(turnId),
  ]);
  if (results[2]?.meta.changes !== 1) throw new PortalError(409, 'Ett anrop pågår redan eller samtalet har ändrats.');
  return { turn: { id: turnId, version: expected, expiresAt }, context: {
    persona, text: content, messages: messages.slice(0, -1), memories: savedNotes,
  } };
}
export async function cancelLocalTurn(env: PortalEnv, session: PortalSession, value: unknown) {
  const turnId = id(value), owner = session.profileId;
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM site_companion_leases WHERE owner_id=? AND kind='chat' AND token=?
      AND EXISTS(SELECT 1 FROM site_companion_local_turns WHERE id=? AND owner_id=? AND session_hash=?)`)
      .bind(owner, turnId, turnId, owner, session.tokenHash),
    env.DB.prepare('DELETE FROM site_companion_local_turns WHERE id=? AND owner_id=? AND session_hash=?')
      .bind(turnId, owner, session.tokenHash),
  ]);
  return { cancelled: results[1]?.meta.changes === 1 };
}
export async function commitLocalTurn(
  env: PortalEnv, session: PortalSession, value: unknown, expected: number, answer: string,
) {
  const turnId = id(value), owner = session.profileId;
  const turn = await env.DB.prepare(`SELECT id,expected_version,expires_at,messages_json FROM site_companion_local_turns
    WHERE id=? AND owner_id=? AND session_hash=?`).bind(turnId, owner, session.tokenHash).first<LocalTurn>();
  if (!turn || turn.expected_version !== expected) throw new PortalError(409, CONFLICT);
  const next: Message[] = [...JSON.parse(turn.messages_json), { role: 'assistant', content: answer }];
  // The locally produced answer is untrusted text. It never grants tools or writes memory.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE site_companion_conversations SET messages_json=?,version=version+1 WHERE owner_id=? AND version=?
      AND EXISTS(SELECT 1 FROM site_companion_local_turns t JOIN site_companion_leases l ON l.owner_id=t.owner_id
        AND l.kind='chat' AND l.token=t.id WHERE t.id=? AND t.owner_id=? AND t.session_hash=?
        AND t.expected_version=? AND t.expires_at>? AND l.expires_at>?)
      AND ${SESSION_VALID}`).bind(JSON.stringify(next), owner, expected, turnId, owner, session.tokenHash,
        expected, Date.now(), Date.now(), session.tokenHash, owner),
    env.DB.prepare(`DELETE FROM site_companion_leases WHERE owner_id=? AND kind='chat' AND token=?
      AND EXISTS(SELECT 1 FROM site_companion_local_turns WHERE id=? AND owner_id=? AND session_hash=?)`)
      .bind(owner, turnId, turnId, owner, session.tokenHash),
    env.DB.prepare('DELETE FROM site_companion_local_turns WHERE id=? AND owner_id=? AND session_hash=?')
      .bind(turnId, owner, session.tokenHash),
  ]);
  if (results[0]?.meta.changes !== 1) throw new PortalError(409, CONFLICT);
  return { text: answer, conversation: { version: expected + 1, messages: next } };
}
