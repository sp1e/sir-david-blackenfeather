import { PortalError, portalDigest, portalRandomToken, type PortalEnv, type PortalSession } from './portal-session';
import { iso, ACTIVE_ADMIN_SQL, type CalendarEvent } from './sir-david-planner';

export interface OutlookEnv extends PortalEnv {
  SIR_DAVID_OUTLOOK_CLIENT_ID?: string;
  SIR_DAVID_OUTLOOK_CLIENT_SECRET?: string;
  SIR_DAVID_OUTLOOK_TOKEN_KEY?: string; // 64 hexadecimal characters, AES-256-GCM; server secret only.
  SIR_DAVID_OUTLOOK_TENANT?: string; // organizations or a tenant UUID; never consumers/common.
}
const scopes='https://graph.microsoft.com/Calendars.ReadBasic offline_access';
const encoder=new TextEncoder();
const bytes=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function unbase(value:string):Uint8Array { return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)); }
function configuration(env:OutlookEnv) {
  const client=env.SIR_DAVID_OUTLOOK_CLIENT_ID?.trim(), secret=env.SIR_DAVID_OUTLOOK_CLIENT_SECRET?.trim(), key=env.SIR_DAVID_OUTLOOK_TOKEN_KEY?.trim(), tenant=env.SIR_DAVID_OUTLOOK_TENANT?.trim()||'organizations';
  if (!client || !/^[a-f0-9-]{36}$/i.test(client) || !secret || !/^[a-f0-9]{64}$/i.test(key??'') || !(tenant==='organizations'||/^[a-f0-9-]{36}$/i.test(tenant))) throw new PortalError(503,'Outlook behöver först en Microsoft-appregistrering och serverinställningar.');
  return {client,secret,key:key!,endpoint:`https://login.microsoftonline.com/${tenant}/oauth2/v2.0`};
}
export async function encrypt(env:OutlookEnv, owner:string, value:unknown):Promise<string> {
  const raw=configuration(env).key, key=await crypto.subtle.importKey('raw',Uint8Array.from(raw.match(/../g)!,v=>parseInt(v,16)),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('sir-david-outlook:'+owner)},key,encoder.encode(JSON.stringify(value)));
  return bytes(iv)+'.'+bytes(new Uint8Array(cipher));
}
export async function decrypt(env:OutlookEnv, owner:string, value:string):Promise<unknown> {
  const raw=configuration(env).key, key=await crypto.subtle.importKey('raw',Uint8Array.from(raw.match(/../g)!,v=>parseInt(v,16)),{name:'AES-GCM'},false,['decrypt']);
  const parts=value.split('.');
  if(parts.length!==2) throw new Error('Invalid encrypted record');
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase(parts[0]!),additionalData:encoder.encode('sir-david-outlook:'+owner)},key,unbase(parts[1]!));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function boundedJson(response:Response, limit=500000):Promise<Record<string,unknown>> {
  const reader=response.body?.getReader(); if(!reader) throw new Error('Missing response');
  const chunks:Uint8Array[]= []; let size=0;
  try { while(true) { const part=await reader.read(); if(part.done)break; size+=part.value.byteLength; if(size>limit)throw new Error('Oversized response'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  const data=new Uint8Array(size); let offset=0; for(const part of chunks){data.set(part,offset);offset+=part.length;}
  const value:unknown=JSON.parse(new TextDecoder().decode(data));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid response');
  return value as Record<string,unknown>;
}
interface Tokens { access:string; refresh:string; expires:number }
async function exchange(env:OutlookEnv, fields:Record<string,string>, signal:AbortSignal):Promise<Tokens> {
  const config=configuration(env);
  const response=await fetch(config.endpoint+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.client,client_secret:config.secret,scope:scopes,...fields}),signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),redirect:'error'});
  if(!response.ok) throw new PortalError(409,'Microsoft-anslutningen behöver godkännas igen.');
  const data=await boundedJson(response,100000);
  if(typeof data.access_token!=='string'||data.access_token.length>20000||typeof data.refresh_token!=='string'||data.refresh_token.length>20000||typeof data.expires_in!=='number'||data.expires_in<=0||data.expires_in>86400) throw new Error('Invalid token response');
  return {access:data.access_token,refresh:data.refresh_token,expires:Date.now()+data.expires_in*1000};
}
export async function outlookStatus(env:OutlookEnv, owner:string) {
  let configured=true; try{configuration(env);}catch{configured=false;}
  const row=await env.DB.prepare('SELECT last_sync,status FROM site_companion_outlook WHERE owner_id=?').bind(owner).first<{last_sync:number|null;status:string}>();
  return {configured,connected:Boolean(row),status:row?.status??'disconnected',lastSync:row?.last_sync ? new Date(row.last_sync).toISOString():null,scope:'Calendars.ReadBasic',rangeDays:30};
}
export async function outlookConnect(request:Request, env:OutlookEnv, session:PortalSession) {
  const config=configuration(env), origin=new URL(request.url).origin;
  if(!['https://sp1e.se','https://www.sp1e.se'].includes(origin))throw new PortalError(403,'Outlook ansluts från sp1e.se.');
  const redirect=origin+'/api/sir-david/outlook/callback', state=portalRandomToken(), verifier=portalRandomToken();
  const challenge=bytes(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));
  const saved=await env.DB.batch([
    env.DB.prepare(`DELETE FROM site_companion_outlook_states WHERE owner_id=? AND ${ACTIVE_ADMIN_SQL}`).bind(session.profileId,session.tokenHash,session.profileId),
    env.DB.prepare(`INSERT INTO site_companion_outlook_states(state_hash,owner_id,session_hash,verifier_cipher,redirect_uri,expires_at) SELECT ?,?,?,?,?,? WHERE ${ACTIVE_ADMIN_SQL}`)
      .bind(await portalDigest(state),session.profileId,session.tokenHash,await encrypt(env,session.profileId,{verifier}),redirect,Date.now()+10*60000,session.tokenHash,session.profileId)
  ]);
  if(!saved[1]?.meta.changes)throw new PortalError(409,'Admin-anslutningen har gått ut.');
  const url=new URL(config.endpoint+'/authorize');
  url.search=new URLSearchParams({client_id:config.client,response_type:'code',redirect_uri:redirect,response_mode:'query',scope:scopes,state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
  return {url:url.href};
}
export async function outlookCallback(request:Request, env:OutlookEnv, session:PortalSession):Promise<Response> {
  const url=new URL(request.url), state=url.searchParams.get('state'), code=url.searchParams.get('code');
  if(!state||!/^[a-f0-9]{64}$/.test(state)||url.searchParams.getAll('state').length!==1||url.searchParams.getAll('code').length>1)throw new PortalError(400,'Outlook-anslutningen är ogiltig. Börja om från Admin.');
  const stateHash=await portalDigest(state);
  const row=await env.DB.prepare(`UPDATE site_companion_outlook_states SET expires_at=0 WHERE state_hash=? AND owner_id=? AND session_hash=? AND expires_at>? AND redirect_uri=? AND ${ACTIVE_ADMIN_SQL} RETURNING verifier_cipher,redirect_uri`)
    .bind(stateHash,session.profileId,session.tokenHash,Date.now(),url.origin+'/api/sir-david/outlook/callback',session.tokenHash,session.profileId).first<{verifier_cipher:string;redirect_uri:string}>();
  if(!row)throw new PortalError(409,'Outlook-anslutningen har gått ut. Börja om från Admin.');
  const target=new URL('/admin/?panel=sir-david',url.origin);
  if(url.searchParams.has('error')) {target.searchParams.set('calendar','cancelled');return new Response(null,{status:303,headers:{Location:target.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
  if(!code||code.length>10000)throw new PortalError(400,'Microsoft skickade inget giltigt godkännande.');
  const decrypted=await decrypt(env,session.profileId,row.verifier_cipher) as {verifier:string};
  const tokens=await exchange(env,{grant_type:'authorization_code',code,redirect_uri:row.redirect_uri,code_verifier:decrypted.verifier},request.signal);
  const saved=await env.DB.batch([env.DB.prepare(`INSERT INTO site_companion_outlook(owner_id,tokens_cipher) SELECT ?,? WHERE ${ACTIVE_ADMIN_SQL}
    AND EXISTS(SELECT 1 FROM site_companion_outlook_states WHERE state_hash=? AND owner_id=? AND session_hash=? AND expires_at=0)
    ON CONFLICT(owner_id) DO UPDATE SET tokens_cipher=excluded.tokens_cipher,events_json='[]',last_sync=NULL,last_attempt=NULL,sync_id=NULL,sync_until=0,status='connected'`)
    .bind(session.profileId,await encrypt(env,session.profileId,tokens),session.tokenHash,session.profileId,stateHash,session.profileId,session.tokenHash),
    env.DB.prepare('DELETE FROM site_companion_outlook_states WHERE state_hash=? AND owner_id=?').bind(stateHash,session.profileId)]);
  if(!saved[0]?.meta.changes)throw new PortalError(409,'Admin- eller Outlook-anslutningen har ändrats. Börja om från Admin.');
  target.searchParams.set('calendar','connected');
  return new Response(null,{status:303,headers:{Location:target.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export async function outlookDisconnect(env:OutlookEnv, session:PortalSession) {
  const owner=session.profileId;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM site_companion_outlook WHERE owner_id=? AND ${ACTIVE_ADMIN_SQL}`).bind(owner,session.tokenHash,owner),
    env.DB.prepare(`DELETE FROM site_companion_outlook_states WHERE owner_id=? AND ${ACTIVE_ADMIN_SQL}`).bind(owner,session.tokenHash,owner)
  ]);
  if(!await env.DB.prepare(`SELECT 1 AS active WHERE ${ACTIVE_ADMIN_SQL}`).bind(session.tokenHash,owner).first())throw new PortalError(409,'Admin-anslutningen har gått ut.');
  return {disconnected:true};
}
export function normalizeGraphEvent(value:unknown):CalendarEvent|null {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid event');
  const e=value as Record<string,unknown>;
  if(e.isCancelled===true)return null;
  if(typeof e.id!=='string'||e.id.length>512||typeof e.subject!=='string'||e.subject.length>1000||typeof e.isAllDay!=='boolean')throw new Error('Invalid event');
  const date=(value:unknown)=>{const d=value as {dateTime?:unknown;timeZone?:unknown}; if(!d||typeof d.dateTime!=='string'||d.timeZone!=='UTC'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z?$/.test(d.dateTime))throw new Error('Invalid event date'); return iso(new Date(d.dateTime.replace(/Z?$/,'Z')).toISOString());};
  const start=date(e.start), end=date(e.end); if(end<=start)throw new Error('Invalid event range');
  return {id:e.id,title:e.sensitivity==='private'||e.sensitivity==='confidential' ? 'Privat kalenderhändelse' : e.subject.trim().slice(0,120)||'Kalenderhändelse',start,end,allDay:e.isAllDay,source:'outlook'};
}
export function graphPage(value:string):string {
  const url=new URL(value);
  if(url.origin!=='https://graph.microsoft.com'||url.pathname!=='/v1.0/me/calendarView'||url.username||url.password||url.hash)throw new Error('Invalid Graph continuation');
  return url.href;
}
export async function outlookSync(request:Request, env:OutlookEnv, session:PortalSession) {
  const owner=session.profileId;
  configuration(env); const now=Date.now(), syncId=crypto.randomUUID();
  const row=await env.DB.prepare(`UPDATE site_companion_outlook SET sync_id=?,sync_until=?,last_attempt=?
    WHERE owner_id=? AND sync_until<=? AND (last_attempt IS NULL OR last_attempt<=?) AND ${ACTIVE_ADMIN_SQL} RETURNING tokens_cipher`)
    .bind(syncId,now+90000,now,owner,now,now-5*60000,session.tokenHash,owner).first<{tokens_cipher:string}>();
  if(!row)return {outlook:await outlookStatus(env,owner),cached:true};
  try {
    let tokens=await decrypt(env,owner,row.tokens_cipher) as Tokens;
    if(!tokens||typeof tokens.access!=='string'||typeof tokens.refresh!=='string'||typeof tokens.expires!=='number')throw new Error('Invalid stored token');
    if(tokens.expires<=now+120000) {
      tokens=await exchange(env,{grant_type:'refresh_token',refresh_token:tokens.refresh},request.signal);
      // Persist refresh rotation before Graph; a disconnected/reconnected account cannot be resurrected by an old sync.
      const updated=await env.DB.prepare(`UPDATE site_companion_outlook SET tokens_cipher=? WHERE owner_id=? AND sync_id=? AND ${ACTIVE_ADMIN_SQL} RETURNING owner_id`).bind(await encrypt(env,owner,tokens),owner,syncId,session.tokenHash,owner).first();
      if(!updated)throw new PortalError(409,'Outlook-anslutningen har ändrats.');
    }
    const url=new URL('https://graph.microsoft.com/v1.0/me/calendarView');
    url.search=new URLSearchParams({startDateTime:new Date(now-3*86400000).toISOString(),endDateTime:new Date(now+30*86400000).toISOString(),'$top':'100','$select':'id,subject,start,end,isAllDay,isCancelled,sensitivity','$orderby':'start/dateTime'}).toString();
    let next:string|null=url.href, events:CalendarEvent[]=[], pages=0;
    while(next) {
      if(++pages>4)throw new PortalError(409,'Kalendern är för stor för den här synkningen. Tidigare schema behålls.');
      const response=await fetch(graphPage(next),{headers:{Authorization:'Bearer '+tokens.access,Prefer:'outlook.timezone="UTC"'},signal:AbortSignal.any([request.signal,AbortSignal.timeout(20000)]),redirect:'error'});
      if(!response.ok)throw new PortalError(response.status===401||response.status===403 ? 409 : 503,'Outlook kunde inte läsas. Kontrollera anslutningen och Microsofts behörigheter.');
      const data=await boundedJson(response);
      if(!Array.isArray(data.value))throw new Error('Invalid calendar response');
      for(const value of data.value){const event=normalizeGraphEvent(value);if(event)events.push(event);}
      if(events.length>400)throw new PortalError(409,'Kalendern är för stor för den här synkningen. Tidigare schema behålls.');
      if(data['@odata.nextLink']!==undefined&&typeof data['@odata.nextLink']!=='string')throw new Error('Invalid Graph continuation');
      next=data['@odata.nextLink'] as string??null;
    }
    if(new Set(events.map(e=>e.id)).size!==events.length)throw new Error('Duplicate calendar events');
    const updated=await env.DB.prepare(`UPDATE site_companion_outlook SET events_json=?,last_sync=?,status='connected',sync_id=NULL,sync_until=0 WHERE owner_id=? AND sync_id=? AND ${ACTIVE_ADMIN_SQL} RETURNING owner_id`).bind(JSON.stringify(events),Date.now(),owner,syncId,session.tokenHash,owner).first();
    if(!updated)throw new PortalError(409,'Outlook-anslutningen har ändrats.');
    return {outlook:await outlookStatus(env,owner),count:events.length,cached:false};
  } catch(error) {
    await env.DB.prepare(`UPDATE site_companion_outlook SET status='needs-attention',sync_id=NULL,sync_until=0 WHERE owner_id=? AND sync_id=? AND ${ACTIVE_ADMIN_SQL}`).bind(owner,syncId,session.tokenHash,owner).run();
    throw error;
  }
}
