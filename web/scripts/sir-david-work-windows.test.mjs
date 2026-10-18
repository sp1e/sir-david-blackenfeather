import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const output=fs.mkdtempSync(path.join(os.tmpdir(),'sir-david-work-windows-'));
const outfile=path.join(output,'work-windows-api.mjs');
await build({stdin:{contents:"export {handleSirDavidRequest} from './src/site/sir-david-api.ts'; export {workWindowTimeValid} from './src/site/sir-david-work-windows.ts';",resolveDir:process.cwd()},outfile,bundle:true,format:'esm',platform:'neutral',logLevel:'silent'});
const {handleSirDavidRequest:handle,workWindowTimeValid}=await import(pathToFileURL(outfile));
const origin='https://sp1e.test',token='a'.repeat(64),hash=createHash('sha256').update(token).digest('hex');
const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
const settings={durationMinutes:45,windowStart:'09:00',windowEnd:'17:00',bufferMinutes:10};
function fixture(t){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of ['schema.sql','site-migration-002-auth-throttle.sql','site-migration-003-portal.sql','site-migration-005-sir-david.sql','site-migration-006-sir-david-audio.sql','site-migration-007-sir-david-local-claude.sql','site-migration-010-sir-david-planner.sql','kalender-migration-001-private-calendar.sql','site-migration-012-sir-david-work-windows.sql'])sql.exec(fs.readFileSync(file,'utf8'));
 sql.prepare("INSERT INTO site_portal_profiles(id,role,device_hash,created_at) VALUES('owner','admin','fixture',?)").run(new Date().toISOString());
 sql.prepare("INSERT INTO site_portal_sessions(token_hash,profile_id,created_at) VALUES(?,'owner',?)").run(hash,new Date().toISOString());
 const project={id:randomUUID(),title:'Proof',nextAction:'Write the draft',notes:'',deadline:null,priority:'high',status:'active'};
 const document={projects:[project],events:[],settings:{reminders:false,desktopNotifications:false,speakWhenOpen:false,timezone:'Europe/Stockholm',quietStart:22,quietEnd:8}};
 sql.prepare("INSERT INTO site_companion_planners(owner_id,document_json,version,updated_at) VALUES('owner',?,1,?)").run(JSON.stringify(document),new Date().toISOString());
 let hook=null,extra=[],dispatchCount=0,readStatus=200;
 function statement(query,values=[]){
  const run=kind=>{hook?.(query);const s=sql.prepare(query);if(kind==='first')return s.get(...values)??null;if(kind==='all')return {results:s.all(...values)};return {meta:{changes:Number(s.run(...values).changes)}};};
  return {bind:(...v)=>statement(query,v),first:async()=>run('first'),all:async()=>run('all'),run:async()=>run('run'),execute:()=>run('run')};
 }
 const env={DB:{prepare:statement,batch:async stmts=>{sql.exec('BEGIN');try{const result=stmts.map(s=>s.execute());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}}};
 const dispatch=async request=>{dispatchCount++;assert.equal(request.method,'GET');assert.equal(new URL(request.url).pathname,'/api/calendar/events');return Response.json({events:[...sql.prepare('SELECT id,event_date AS date,all_day,start_time,end_time FROM private_calendar_events WHERE event_date=?').all(date),...extra]},{status:readStatus});};
 const call=(route,payload,options={})=>handle(new Request(origin+'/api/sir-david/'+route,{method:payload?'POST':'GET',headers:{cookie:'__Host-sp1e_session='+token,...(payload?{'Content-Type':'application/json',Origin:origin}:{}),...options.headers},...(payload?{body:JSON.stringify(payload)}:{})}),env,route,dispatch);
 const input=()=>({projectId:project.id,date,settings:{...settings}});
 const propose=async()=>{const r=await call('planner/work-windows',input());assert.equal(r.status,200,await r.clone().text());return r.json();};
 const decision=(proposal,kind='accept',slot=proposal.slots[0])=>call('planner/work-windows/decision',{...input(),basis:proposal.basis,start:slot.start,end:slot.end,decision:kind});
 const insert=(start,end,title='Manual')=>{const id=randomUUID();sql.prepare("INSERT INTO private_calendar_events(id,title,event_date,start_time,end_time) VALUES(?,?,?,?,?)").run(id,title,date,start,end);return id;};
 t.after(()=>sql.close());t.mock.method(globalThis,'fetch',()=>{throw Error('No external network/model calls permitted in these tests');});
 return {sql,env,project,document,input,call,propose,decision,insert,hook:fn=>{hook=fn;},extra:rows=>{extra=rows;},failCalendar:()=>{readStatus=401;},dispatchCount:()=>dispatchCount};
}
test('proposal accounts for private/imported agenda and buffers without creating bookings',async t=>{
 const f=fixture(t);f.insert('09:00','10:00');f.extra([{id:'outlook:1',date,all_day:false,start_time:'11:00',end_time:'12:00'}]);
 const p=await f.propose();assert.equal(p.tentative,true);assert.equal(p.slots[0].start,'12:10');assert.equal(p.project.nextAction,'Write the draft');
 assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,1);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM site_companion_work_windows').get().n,0);
});
test('explicit acceptance creates one private event and retries preserve later manual moves and deletion',async t=>{
 const f=fixture(t),p=await f.propose(),accepted=await f.decision(p);assert.equal(accepted.status,200,await accepted.clone().text());const result=await accepted.json();
 assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,1);
 f.sql.prepare("UPDATE private_calendar_events SET start_time='14:00',end_time='14:45',title='My edited block' WHERE id=?").run(result.eventId);
 const again=await f.decision(p);assert.equal(again.status,200);assert.equal((await again.json()).existing,true);
 assert.equal(f.sql.prepare('SELECT title FROM private_calendar_events').get().title,'My edited block');
 const newProposal=await f.propose();assert.equal(newProposal.existing.event.start_time,'14:00');assert.equal(newProposal.slots.length,0);
 f.sql.prepare('DELETE FROM private_calendar_events WHERE id=?').run(result.eventId);
 assert.equal((await f.propose()).existing.deleted,true);await f.decision(p);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,0);
});
test('rejected time is retained per next action and not repeated',async t=>{
 const f=fixture(t),p=await f.propose(),first=p.slots[0];assert.equal((await f.decision(p,'reject')).status,200);
 const next=await f.propose();assert.ok(next.slots.every(s=>s.start!==first.start));assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,0);
});
test('changing duration cannot resurrect an interval that was rejected for the same next action',async t=>{
 const f=fixture(t),p=await f.propose(),first=p.slots[0];await f.decision(p,'reject');
 const response=await f.call('planner/work-windows',{...f.input(),settings:{...settings,durationMinutes:60}});
 assert.equal(response.status,200);const next=await response.json();
 assert.ok(next.slots.length);assert.ok(next.slots.every(slot=>slot.end<=first.start||slot.start>=first.end));
 assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,0);
});
test('manual choice is accepted within a real gap; conflicts and stale project revisions are rejected',async t=>{
 const f=fixture(t),p=await f.propose();assert.equal((await f.decision(p,'accept',{start:'10:05',end:'10:50'})).status,200);
 const g=fixture(t),q=await g.propose();g.insert('09:00','10:00');assert.equal((await g.decision(q)).status,409);
 const h=fixture(t),r=await h.propose();h.sql.prepare("UPDATE site_companion_planners SET version=version+1 WHERE owner_id='owner'").run();assert.equal((await h.decision(r)).status,409);
});
test('write-time session revocation or same-timestamp calendar edit prevents both event and ledger row',async t=>{
 for(const mutation of ['revoke','calendar']){
  const f=fixture(t),p=await f.propose();let once=false;
  f.hook(query=>{if(!once&&query.startsWith('INSERT INTO site_companion_work_windows')){once=true;if(mutation==='revoke')f.sql.prepare("UPDATE site_portal_sessions SET revoked_at='now'").run();else f.insert('09:00','11:00');}});
  const r=await f.decision(p);assert.ok([401,409].includes(r.status),await r.text());assert.equal(once,true);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM site_companion_work_windows').get().n,0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM private_calendar_events').get().n,mutation==='calendar'?1:0);
 }
});
test('unauthorized roles, origins, unavailable calendars and malformed arguments never create work blocks',async t=>{
 const f=fixture(t);
 assert.equal((await f.call('planner/work-windows',f.input(),{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal((await f.call('planner/work-windows',{...f.input(),settings:{...settings,durationMinutes:241}})).status,400);
 f.failCalendar();assert.equal((await f.call('planner/work-windows',f.input())).status,401);
 f.sql.prepare("UPDATE site_portal_profiles SET role='guest' WHERE id='owner'").run();assert.equal((await f.call('planner/work-windows',f.input())).status,403);
 assert.equal(f.sql.prepare('SELECT count(*) n FROM site_companion_work_windows').get().n,0);
});
test('all-day imported events prevent suggestions for that date',async t=>{
 const f=fixture(t);f.extra([{id:'proton:all-day',date,all_day:true,start_time:null,end_time:null}]);assert.deepEqual((await f.propose()).slots,[]);
});
test('DST repeated or nonexistent local times are never booked as an ordinary duration',()=>{
 assert.equal(workWindowTimeValid('2026-10-25','02:00','02:45'),false);
 assert.equal(workWindowTimeValid('2026-03-29','02:00','02:45'),false);
 assert.equal(workWindowTimeValid('2026-10-25','01:00','03:00'),false);
 assert.equal(workWindowTimeValid('2026-10-25','09:00','09:45'),true);
});
test('suggestions end before the project deadline',async t=>{
 const f=fixture(t);f.document.projects[0].deadline=date+'T06:00:00.000Z';
 f.sql.prepare("UPDATE site_companion_planners SET document_json=? WHERE owner_id='owner'").run(JSON.stringify(f.document));
 assert.deepEqual((await f.propose()).slots,[]);
});
