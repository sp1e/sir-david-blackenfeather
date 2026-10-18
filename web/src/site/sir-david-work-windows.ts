import { PortalError, portalDigest, requirePortalAdmin, type PortalEnv, type PortalSession } from './portal-session';
import { ACTIVE_ADMIN_SQL, loadPlanner, outlookEvents, type PlannerDocument } from './sir-david-planner';

type Dispatch = (request:Request)=>Promise<Response>;
interface Settings { durationMinutes:number; windowStart:string; windowEnd:string; bufferMinutes:number }
interface AgendaEvent { id:string; date:string; all_day:boolean; start_time:string|null; end_time:string|null }
interface Slot { start:string; end:string }
interface Decision { action_hash:string; decision_key:string; state:string; event_id:string|null; event_date:string; start_time:string; end_time:string }
const defaults:Settings={durationMinutes:45,windowStart:'09:00',windowEnd:'17:00',bufferMinutes:10};
const clock=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const minute=(v:unknown)=>typeof v==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(v)?Number(v.slice(0,2))*60+Number(v.slice(3)):-1;
const validDate=(v:unknown):v is string=>typeof v==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
function validateSettings(value:unknown):Settings {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new PortalError(400,'Välj arbetstid, längd och buffert.');
  const v=value as Settings;
  if(Object.keys(v).sort().join(',')!=='bufferMinutes,durationMinutes,windowEnd,windowStart'||!Number.isInteger(v.durationMinutes)||v.durationMinutes<5||v.durationMinutes>240||!Number.isInteger(v.bufferMinutes)||v.bufferMinutes<0||v.bufferMinutes>60||minute(v.windowStart)<0||minute(v.windowEnd)<=minute(v.windowStart)||minute(v.windowEnd)-minute(v.windowStart)<v.durationMinutes)throw new PortalError(400,'Välj 5–240 minuter inom arbetsfönstret och högst 60 minuters buffert.');
  return {...v};
}
function localParts(time:number){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(time));const get=(type:string)=>parts.find(p=>p.type===type)!.value;return {date:get('year')+'-'+get('month')+'-'+get('day'),minute:Number(get('hour'))*60+Number(get('minute'))};}
export function workWindowTimeValid(date:string,start:string,end:string){
  // Avoid nonexistent or repeated local clock times around DST transitions.
  const instant=(clock:string)=>{const wall=Date.parse(date+'T'+clock+':00Z');return [wall-3600000,wall-7200000].filter(at=>{const p=localParts(at);return p.date===date&&p.minute===minute(clock);});};
  const a=instant(start),b=instant(end);return a.length===1&&b.length===1&&(b[0]!-a[0]!)/60000===minute(end)-minute(start);
}
/** Calendar wall clock is Europe/Stockholm. Missing times block the whole day. */
export function workWindowSlots(events:AgendaEvent[],date:string,settings:Settings,now=Date.now()):Slot[]{
  const today=localParts(now);if(date<today.date)return [];
  const start=Math.max(minute(settings.windowStart),date===today.date?Math.ceil((today.minute+1)/5)*5:0),end=minute(settings.windowEnd);
  const busy=events.filter(e=>e.date===date).map(e=>{
    const a=minute(e.start_time),b=minute(e.end_time);
    return e.all_day||a<0||b<=a?[0,1440]:[Math.max(0,a-settings.bufferMinutes),Math.min(1440,b+settings.bufferMinutes)];
  }).sort((a,b)=>a[0]!-b[0]!);
  let cursor=start;const slots:Slot[]=[];
  const gap=(a:number,b:number)=>{if(b-a>=settings.durationMinutes)slots.push({start:clock(a),end:clock(b)});};
  for(const [a,b] of busy){gap(cursor,Math.min(a!,end));cursor=Math.max(cursor,b!);if(cursor>=end)break;}gap(cursor,end);return slots;
}
const privateSnapshotSql=`SELECT COALESCE(json_group_array(json_object('id',id,'title',title,'date',event_date,'all_day',all_day,'start_time',start_time,'end_time',end_time,'location',location,'notes',notes,'color',color,'updated_at',updated_at)),'[]') AS value FROM (SELECT * FROM private_calendar_events WHERE event_date=? ORDER BY id)`;
async function fresh(request:Request,env:PortalEnv){request.signal.throwIfAborted();const session=await requirePortalAdmin(new Request(request.url,{headers:request.headers,signal:request.signal}),env);request.signal.throwIfAborted();return session;}
async function settingsFor(env:PortalEnv,owner:string){const row=await env.DB.prepare('SELECT settings_json FROM site_companion_work_window_settings WHERE owner_id=?').bind(owner).first<{settings_json:string}>();try{return row?validateSettings(JSON.parse(row.settings_json)):defaults;}catch{return defaults;}}
async function agenda(request:Request,dispatch:Dispatch|undefined,date:string):Promise<AgendaEvent[]>{
  if(!dispatch)throw new PortalError(503,'Kalenderkopplingen saknas.');
  const url=new URL('/api/calendar/events',request.url);url.searchParams.set('from',date);url.searchParams.set('to',date);
  const headers=new Headers(request.headers);headers.delete('Content-Length');headers.delete('Content-Type');
  const response=await dispatch(new Request(url,{headers,signal:request.signal}));request.signal.throwIfAborted();
  if(!response.ok)throw new PortalError(response.status,'Kalendern kunde inte läsas. Lås upp den och försök igen.');
  const reader=response.body?.getReader();if(!reader)throw new PortalError(502,'Kalenderns svar saknas.');
  let text='',bytes=0;const decoder=new TextDecoder();
  const abort=()=>{void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});
  try{while(true){request.signal.throwIfAborted();const {done,value}=await reader.read();request.signal.throwIfAborted();if(done)break;bytes+=value.byteLength;if(bytes>1000000){await reader.cancel();throw new PortalError(413,'För mycket kalenderdata.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{request.signal.removeEventListener('abort',abort);reader.releaseLock();}
  let data:any;try{data=JSON.parse(text);}catch{throw new PortalError(502,'Kalendern gav ett ogiltigt svar.');}
  if(!Array.isArray(data.events)||data.events.length>5000||data.events.some((e:any)=>!e||typeof e.id!=='string'||!validDate(e.date)))throw new PortalError(502,'Kalendern gav ett ogiltigt svar.');
  return data.events;
}
function plannerAgenda(doc:PlannerDocument,external:Awaited<ReturnType<typeof outlookEvents>>,date:string):AgendaEvent[]{
  const rows:AgendaEvent[]=[];for(const e of [...doc.events,...external]){
    const start=localParts(Date.parse(e.start)),end=localParts(Date.parse(e.end));
    if(start.date>date||end.date<date)continue;
    rows.push({id:'planner:'+e.id,date,all_day:e.allDay||start.date!==end.date,start_time:clock(start.minute),end_time:clock(end.minute)});
  }return rows;
}
async function context(request:Request,env:PortalEnv,session:PortalSession,input:Record<string,unknown>,dispatch:Dispatch|undefined){
  if(!validDate(input.date)||typeof input.projectId!=='string')throw new PortalError(400,'Välj projekt och datum.');
  const today=localParts(Date.now()).date;if(input.date<today||Date.parse(input.date)-Date.parse(today)>31*86400000)throw new PortalError(400,'Välj ett datum under de närmaste 31 dagarna.');
  const planner=await loadPlanner(env,session.profileId),project=planner.document.projects.find(p=>p.id===input.projectId);
  if(!project||!['active','planned'].includes(project.status)||!project.nextAction.trim())throw new PortalError(409,'Projektet behöver ett aktivt nästa steg.');
  const settings=validateSettings(input.settings),actionHash=await portalDigest(project.id+'\n'+project.nextAction);
  // Capture private rows before reading the complete agenda. A concurrent edit
  // invalidates acceptance in the same D1 transaction as event creation.
  const privateRows=await env.DB.prepare(privateSnapshotSql).bind(input.date).first<{value:string}>();
  const external=await outlookEvents(env,session.profileId),events=[...await agenda(request,dispatch,input.date),...plannerAgenda(planner.document,external,input.date)];
  const decisions=(await env.DB.prepare('SELECT action_hash,decision_key,state,event_id,event_date,start_time,end_time FROM site_companion_work_windows WHERE owner_id=? AND action_hash=? ORDER BY decision_key').bind(session.profileId,actionHash).all<Decision>()).results;
  const basis=await portalDigest(JSON.stringify({version:planner.version,actionHash,date:input.date,settings,events:events.sort((a,b)=>a.id.localeCompare(b.id)),decisions,privateRows:privateRows?.value??'[]'}));
  await fresh(request,env);
  return {planner,project,settings,actionHash,date:input.date,events,decisions,basis,privateRows:privateRows?.value??'[]'};
}
function candidateRanges(c:Awaited<ReturnType<typeof context>>){
  const settings={...c.settings};
  if(c.project.deadline){const deadline=localParts(Date.parse(c.project.deadline));if(deadline.date<c.date)return [];if(deadline.date===c.date)settings.windowEnd=clock(Math.min(minute(settings.windowEnd),deadline.minute));}
  const rejected=c.decisions.filter(row=>row.state==='rejected').map(row=>({id:'rejected:'+row.decision_key,date:row.event_date,all_day:false,start_time:row.start_time,end_time:row.end_time}));
  // A rejected interval remains unavailable when duration/preferences change.
  return workWindowSlots([...c.events,...rejected],c.date,settings);
}
export async function workWindowSettings(env:PortalEnv,session:PortalSession){return {settings:await settingsFor(env,session.profileId),timeZone:'Europe/Stockholm'};}
export async function proposeWorkWindows(request:Request,env:PortalEnv,session:PortalSession,input:Record<string,unknown>,dispatch?:Dispatch){
  const c=await context(request,env,session,input,dispatch);
  const accepted=c.decisions.find(row=>row.state==='accepted');
  if(accepted){const current=await env.DB.prepare('SELECT id,title,event_date,start_time,end_time FROM private_calendar_events WHERE id=?').bind(accepted.event_id).first();await fresh(request,env);return {existing:{event:current,deleted:!current},slots:[],basis:c.basis,project:{id:c.project.id,title:c.project.title,nextAction:c.project.nextAction},message:'Nästa steg har redan ett accepterat arbetsblock. Dina kalenderändringar bevaras.'};}
  const slots:Slot[]=[];
  for(const range of candidateRanges(c)){
    for(let at=minute(range.start);at+c.settings.durationMinutes<=minute(range.end)&&slots.length<3;at+=Math.max(15,c.settings.durationMinutes)){
      const slot={start:clock(at),end:clock(at+c.settings.durationMinutes)};
      if(workWindowTimeValid(c.date,slot.start,slot.end))slots.push(slot);
    }if(slots.length>=3)break;
  }
  await env.DB.prepare(`INSERT INTO site_companion_work_window_settings(owner_id,settings_json,updated_at) SELECT ?,?,? WHERE ${ACTIVE_ADMIN_SQL}
    ON CONFLICT(owner_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`).bind(session.profileId,JSON.stringify(c.settings),new Date().toISOString(),session.tokenHash,session.profileId).run();
  await fresh(request,env);return {slots,basis:c.basis,date:c.date,timeZone:'Europe/Stockholm',project:{id:c.project.id,title:c.project.title,nextAction:c.project.nextAction},tentative:true,message:'Luckor i läsbar agenda är förslag. Importerade källor kan vara ofullständiga. Ingenting bokas förrän du väljer Spara arbetsblock.'};
}
export async function decideWorkWindow(request:Request,env:PortalEnv,session:PortalSession,input:Record<string,unknown>,dispatch?:Dispatch){
  if(!['accept','reject'].includes(String(input.decision))||typeof input.basis!=='string'||!/^[a-f0-9]{64}$/.test(input.basis)||minute(input.start)<0||minute(input.end)<=minute(input.start))throw new PortalError(400,'Välj ett giltigt arbetsblock.');
  const c=await context(request,env,session,input,dispatch),start=String(input.start),end=String(input.end);
  const prior=c.decisions.find(row=>row.state==='accepted');if(prior)return {saved:true,existing:true,eventId:prior.event_id,message:'Arbetsblocket finns redan eller har ändrats i kalendern. Det skrivs inte över.'};
  if(c.basis!==input.basis)throw new PortalError(409,'Projektet eller agendan ändrades. Hämta nya förslag; dina val finns kvar.');
  if(minute(end)-minute(start)!==c.settings.durationMinutes||!workWindowTimeValid(c.date,start,end)||!candidateRanges(c).some(slot=>minute(start)>=minute(slot.start)&&minute(end)<=minute(slot.end)))throw new PortalError(409,'Tiden ryms inte längre före deadline i arbetsfönstret eller är tvetydig vid tidsomställningen.');
  const decisionKey=await portalDigest(c.actionHash+'\n'+c.date+'\n'+start+'\n'+end),eventId=crypto.randomUUID(),accept=input.decision==='accept';
  const now=new Date().toISOString();
  const write=env.DB.prepare(`INSERT INTO site_companion_work_windows(owner_id,action_hash,decision_key,project_id,state,event_id,event_date,start_time,end_time,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${ACTIVE_ADMIN_SQL}
    AND COALESCE((SELECT version FROM site_companion_planners WHERE owner_id=?),0)=?
    AND (${privateSnapshotSql})=?
    AND NOT EXISTS(SELECT 1 FROM site_companion_work_windows WHERE owner_id=? AND action_hash=? AND state='accepted')
    ON CONFLICT DO NOTHING`).bind(session.profileId,c.actionHash,decisionKey,c.project.id,accept?'accepted':'rejected',accept?eventId:null,c.date,start,end,now,session.tokenHash,session.profileId,session.profileId,c.planner.version,c.date,c.privateRows,session.profileId,c.actionHash);
  const statements=[write];
  if(accept)statements.push(env.DB.prepare(`INSERT INTO private_calendar_events(id,title,event_date,all_day,start_time,end_time,location,notes,color)
    SELECT ?,?,?,0,?,?,'',?,'gold' WHERE EXISTS(SELECT 1 FROM site_companion_work_windows WHERE owner_id=? AND decision_key=? AND event_id=? AND state='accepted')`)
    .bind(eventId,(c.project.title+' · '+c.project.nextAction).slice(0,120),c.date,start,end,'Arbetsblock · '+c.project.title+'\nNästa steg: '+c.project.nextAction,session.profileId,decisionKey,eventId));
  request.signal.throwIfAborted();const result=await env.DB.batch(statements);
  await fresh(request,env);
  if(!result[0]?.meta.changes){
    const saved=await env.DB.prepare("SELECT event_id FROM site_companion_work_windows WHERE owner_id=? AND action_hash=? AND state='accepted'").bind(session.profileId,c.actionHash).first<{event_id:string}>();
    if(saved)return {saved:true,existing:true,eventId:saved.event_id,message:'Arbetsblocket har redan sparats. Det skrivs inte över.'};
    throw new PortalError(409,'Planeringen, kalendern eller behörigheten ändrades. Läs in igen.');
  }
  return {saved:accept,rejected:!accept,...(accept?{eventId}:{}),message:accept?'Arbetsblocket sparades i din privata kalender. Flytta det där när du behöver; nya förslag skriver aldrig över din tid.':'Tiden avvisades och föreslås inte igen för samma nästa steg.'};
}
