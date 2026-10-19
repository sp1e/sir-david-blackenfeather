import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
// Export-only: the host answers /api/calendar/events from its full router. These
// tests cover the export dispatcher alone and wired into the work-window API.
const output=fs.mkdtempSync(path.join(os.tmpdir(),'sir-david-calendar-dispatch-'));
const outfile=path.join(output,'dispatch.mjs');
await build({stdin:{contents:"export {handleSirDavidRequest} from './src/site/sir-david-api.ts'; export {dispatchCalendar} from './src/site/sir-david-calendar-dispatch.js';",resolveDir:process.cwd()},outfile,bundle:true,format:'esm',platform:'neutral',logLevel:'silent'});
const {handleSirDavidRequest:handle,dispatchCalendar}=await import(pathToFileURL(outfile));
const origin='https://sp1e.test',token='b'.repeat(64),hash=createHash('sha256').update(token).digest('hex');
const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
function fixture(t){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const file of ['schema.sql','site-migration-002-auth-throttle.sql','site-migration-003-portal.sql','site-migration-005-sir-david.sql','site-migration-006-sir-david-audio.sql','site-migration-007-sir-david-local-claude.sql','site-migration-010-sir-david-planner.sql','kalender-migration-001-private-calendar.sql','site-migration-012-sir-david-work-windows.sql'])sql.exec(fs.readFileSync(file,'utf8'));
 sql.prepare("INSERT INTO site_portal_profiles(id,role,device_hash,created_at) VALUES('owner','admin','fixture',?)").run(new Date().toISOString());
 sql.prepare("INSERT INTO site_portal_sessions(token_hash,profile_id,created_at) VALUES(?,'owner',?)").run(hash,new Date().toISOString());
 const project={id:randomUUID(),title:'Proof',nextAction:'Write the draft',notes:'',deadline:null,priority:'high',status:'active'};
 const document={projects:[project],events:[],settings:{reminders:false,desktopNotifications:false,speakWhenOpen:false,timezone:'Europe/Stockholm',quietStart:22,quietEnd:8}};
 sql.prepare("INSERT INTO site_companion_planners(owner_id,document_json,version,updated_at) VALUES('owner',?,1,?)").run(JSON.stringify(document),new Date().toISOString());
 function statement(query,values=[]){
  const run=kind=>{const s=sql.prepare(query);if(kind==='first')return s.get(...values)??null;if(kind==='all')return {results:s.all(...values)};return {meta:{changes:Number(s.run(...values).changes)}};};
  return {bind:(...v)=>statement(query,v),first:async()=>run('first'),all:async()=>run('all'),run:async()=>run('run'),execute:()=>run('run')};
 }
 const env={DB:{prepare:statement,batch:async stmts=>{sql.exec('BEGIN');try{const result=stmts.map(s=>s.execute());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}}};
 const cookie='__Host-sp1e_session='+token;
 const get=(pathname,headers={cookie},method='GET')=>dispatchCalendar({env},new Request(origin+pathname,{method,headers}));
 const insert=(start,end,allDay=0)=>sql.prepare("INSERT INTO private_calendar_events(id,title,event_date,all_day,start_time,end_time) VALUES(?,?,?,?,?,?)").run(randomUUID(),'Manual',date,allDay,start,end);
 const propose=()=>handle(new Request(origin+'/api/sir-david/planner/work-windows',{method:'POST',headers:{cookie,'Content-Type':'application/json',Origin:origin},body:JSON.stringify({projectId:project.id,date,settings:{durationMinutes:45,windowStart:'09:00',windowEnd:'17:00',bufferMinutes:10}})}),env,'planner/work-windows',request=>dispatchCalendar({env},request));
 t.after(()=>sql.close());t.mock.method(globalThis,'fetch',()=>{throw Error('No external network/model calls permitted in these tests');});
 return {sql,get,insert,propose};
}
test('dispatcher returns private events for an admin in the agenda shape',async t=>{
 const f=fixture(t);f.insert('09:00','10:00');f.insert(null,null,1);
 const r=await f.get('/api/calendar/events?from='+date+'&to='+date);assert.equal(r.status,200);
 const {events}=await r.json();assert.equal(events.length,2);
 assert.deepEqual(events.map(e=>[e.date,e.all_day,e.start_time,e.end_time]),[[date,false,'09:00','10:00'],[date,true,null,null]]);
});
test('dispatcher refuses other paths, methods, missing sessions and bad dates',async t=>{
 const f=fixture(t);
 assert.equal((await f.get('/api/calendar/events/x?from='+date+'&to='+date)).status,403);
 assert.equal((await f.get('/api/calendar/events?from='+date+'&to='+date,{cookie:'__Host-sp1e_session='+token},'POST')).status,403);
 assert.equal((await f.get('/api/calendar/events?from='+date+'&to='+date,{})).status,401);
 assert.equal((await f.get('/api/calendar/events?from=x&to='+date)).status,400);
 f.sql.prepare("UPDATE site_portal_profiles SET role='guest' WHERE id='owner'").run();
 assert.equal((await f.get('/api/calendar/events?from='+date+'&to='+date)).status,403);
});
test('work-window proposals avoid private events read through the export dispatcher',async t=>{
 const f=fixture(t);f.insert('09:00','12:00');
 const r=await f.propose();assert.equal(r.status,200,await r.clone().text());
 const {slots}=await r.json();assert.equal(slots[0].start,'12:10');
 const g=fixture(t);g.insert(null,null,1);assert.deepEqual((await (await g.propose()).json()).slots,[]);
});
