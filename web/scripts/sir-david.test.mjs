import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-david-tests-'));
const outfile = path.join(temp, 'api.mjs');
await build({ entryPoints:[fileURLToPath(new URL('src/site/sir-david-api.ts', root))], bundle:true, format:'esm', platform:'neutral', outfile, logLevel:'silent' });
const { handleSirDavidRequest } = await import(pathToFileURL(outfile).href);
const gateFile = path.join(temp, 'gate.mjs');
await build({ entryPoints:[fileURLToPath(new URL('src/site/portal-gate.ts', root))], bundle:true, format:'esm', platform:'neutral', outfile:gateFile, logLevel:'silent' });
const { checkPortalGate } = await import(pathToFileURL(gateFile).href);
const { allowedNext } = await import(new URL('portal/portal.js', root));
test.after(() => fs.rmSync(temp, { recursive:true, force:true }));

const origin = 'https://sp1e.test';
const tokens = { admin:'a'.repeat(64), other:'b'.repeat(64), guest:'c'.repeat(64), clique:'d'.repeat(64) };
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, extra = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of ['schema.sql','site-migration-002-auth-throttle.sql','site-migration-003-portal.sql','site-migration-005-sir-david.sql','site-migration-006-sir-david-audio.sql','site-migration-007-sir-david-local-claude.sql','site-migration-010-sir-david-planner.sql']) sql.exec(fs.readFileSync(new URL(file, root),'utf8'));
  for (const [id,token] of Object.entries(tokens)) {
    const role = id === 'other' ? 'admin' : id;
    sql.prepare('INSERT INTO site_portal_profiles(id,role,device_hash,created_at) VALUES (?,?,?,?)').run(id,role,'fixture-device-'+id,new Date().toISOString());
    sql.prepare('INSERT INTO site_portal_sessions(token_hash,profile_id,created_at) VALUES (?,?,?)').run(hash(token),id,new Date().toISOString());
  }
  function statement(query, values = []) {
    function execute(kind) {
      const prepared = sql.prepare(query);
      if (kind === 'first') return prepared.get(...values) ?? null;
      if (kind === 'all') return { results:prepared.all(...values), success:true };
      const result = prepared.run(...values);
      return { success:true, meta:{ changes:Number(result.changes) } };
    }
    return { bind:(...args) => statement(query,args), first:async()=>execute('first'), all:async()=>execute('all'), run:async()=>execute('run'), execute };
  }
  const DB = { prepare:statement, batch:async statements => {
    sql.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(item => item.execute('run')); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  t.after(() => sql.close());
  return { sql,DB,OLLAMA_API_KEY:'fixture-ollama-secret',SIR_DAVID_ELEVENLABS_API_KEY:'fixture-voice-secret',...extra };
}
function request(route, options = {}) {
  const { role='admin', method='GET', payload, raw, requestOrigin=origin, headers={} } = options;
  return new Request(origin+'/api/sir-david/'+route, {
    method, headers:{ ...(role ? {cookie:'__Host-sp1e_session='+tokens[role]} : {}), ...(method === 'GET' || method === 'HEAD' ? {} : {Origin:requestOrigin,'Content-Type':'application/json'}), ...headers },
    ...(['GET','HEAD'].includes(method) ? {} : {body:raw ?? JSON.stringify(payload ?? {})}),
  });
}
const call = (env,route,options) => handleSirDavidRequest(request(route,options),env,route);
function upstream(t, response = () => Response.json({message:{content:'Good evening, Simon.'},done:true})) {
  const calls = [];
  t.mock.method(globalThis,'fetch',async (...args) => { calls.push(args); return response(...args); });
  return calls;
}
const chat = (env, text='Hello', version=0, extra={}) => call(env,'chat',{method:'POST',payload:{text,model:'gemma4:31b',version,...extra}});
const memory = (env,content,role='admin') => call(env,'memories',{role,method:'POST',payload:{content}});
const conversation = async (env,role='admin') => (await (await call(env,'conversation',{role})).json()).conversation;
const leaseCount = env => env.sql.prepare('SELECT count(*) n FROM site_companion_leases').get().n;
const quotaCount = env => env.sql.prepare("SELECT coalesce(sum(attempts),0) n FROM auth_attempts WHERE scope LIKE 'sir-david-%'").get().n;

const plannerFile=path.join(temp,'planner.mjs'), outlookFile=path.join(temp,'outlook.mjs');
await build({entryPoints:[fileURLToPath(new URL('src/site/sir-david-planner.ts',root))],bundle:true,format:'esm',platform:'neutral',outfile:plannerFile,logLevel:'silent'});
await build({entryPoints:[fileURLToPath(new URL('src/site/sir-david-outlook.ts',root))],bundle:true,format:'esm',platform:'neutral',outfile:outlookFile,logLevel:'silent'});
const {defaultPlanner,dueReminders,inQuietHours,rankedProjects,planningContext}=await import(pathToFileURL(plannerFile).href);
const {encrypt,decrypt,normalizeGraphEvent,graphPage}=await import(pathToFileURL(outlookFile).href);
const planner=async(env,role='admin')=>(await(await call(env,'planner',{role})).json()).planner;
const savePlan=(env,document,version=0,role='admin')=>call(env,'planner',{method:'PUT',role,payload:{document,version}});
const project=(extra={})=>({id:crypto.randomUUID(),title:'Testprojekt',notes:'Privat anteckning',nextAction:'Skriv första utkastet',deadline:null,priority:'normal',status:'active',...extra});
const plan=()=>{const doc=defaultPlanner();doc.settings.quietStart=doc.settings.quietEnd=0;return doc;};
const outlookConfig={SIR_DAVID_OUTLOOK_CLIENT_ID:'11111111-1111-4111-8111-111111111111',SIR_DAVID_OUTLOOK_CLIENT_SECRET:'synthetic-secret',SIR_DAVID_OUTLOOK_TOKEN_KEY:'11'.repeat(32)};
function productionRequest(route,options={}) {const prior=request(route,options),headers=new Headers(prior.headers);if(prior.method==='POST')headers.set('Origin','https://sp1e.se');return new Request('https://sp1e.se/api/sir-david/'+route,{method:prior.method,headers,...(['GET','HEAD'].includes(prior.method)?{}:{body:JSON.stringify(options.payload??{})})});}
const productionCall=(env,route,options)=>handleSirDavidRequest(productionRequest(route,options),env,route);

test('planner routes reject visitors, cross-site traffic and revoked Admin without upstream use',async t=>{
  const env=fixture(t),calls=upstream(t);
  for(const role of [null,'guest','clique'])for(const [route,method,payload] of [['planner','GET'],['planner','PUT',{document:plan(),version:0}],['planner/claim','POST',{key:'a'.repeat(64),version:0}],['planner/ack','POST',{key:'a'.repeat(64),claimId:'x'}],['planner/snooze','POST',{key:'a'.repeat(64),minutes:60}],['outlook/status','GET'],['outlook/connect','POST',{}],['outlook/sync','POST',{}],['outlook/disconnect','POST',{}]])assert.equal((await call(env,route,{role,method,payload})).status,role?403:401);
  assert.equal((await call(env,'planner',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  env.sql.prepare("UPDATE site_portal_profiles SET revoked_at='now' WHERE id='admin'").run();assert.equal((await call(env,'planner')).status,401);assert.equal(calls.length,0);
});
test('planner is shared per owner, read-only polls do not write, stale CAS cannot overwrite',async t=>{
  const env=fixture(t),calls=upstream(t),document=plan();document.projects=[project()];
  const initial=await planner(env),writes=env.sql.prepare('SELECT total_changes() n').get().n;await planner(env);assert.equal(env.sql.prepare('SELECT total_changes() n').get().n,writes);
  assert.equal(initial.version,0);assert.equal((await savePlan(env,document)).status,200);assert.equal((await planner(env)).document.projects[0].title,'Testprojekt');assert.equal((await planner(env,'other')).document.projects.length,0);
  assert.equal((await savePlan(env,plan(),0)).status,409);assert.equal((await planner(env)).version,1);assert.equal(calls.length,0);assert.equal(quotaCount(env),0);
});
test('planner rejects invalid dates, duplicate ids, forged Outlook entries and oversized fields',async t=>{
  const env=fixture(t),cases=[];
  for(const p of [project({title:'x'.repeat(121)}),project({deadline:'2026-02-30T00:00:00.000Z'}),project({id:'other'}),project({status:'execute'}),project({notes:'x'.repeat(1001)})]){const d=plan();d.projects=[p];cases.push(d);}
  const duplicate=plan(),p=project();duplicate.projects=[p,p];cases.push(duplicate);
  const forged=plan();forged.events=[{id:crypto.randomUUID(),title:'Forged',start:'2026-10-11T12:00:00.000Z',end:'2026-10-11T13:00:00.000Z',allDay:false,source:'outlook'}];cases.push(forged);
  const badZone=plan();badZone.settings.timezone='America/Unknown';cases.push(badZone);const extra=plan();extra.command='shell';cases.push(extra);
  for(const d of cases)assert.equal((await savePlan(env,d)).status,400);assert.equal((await planner(env)).version,0);
});
test('deadline stages select one current stage, ignore paused/done and rank urgent work first',async()=>{
  const now=Date.parse('2026-10-11T12:00:00Z'),d=plan();d.projects=[project({title:'Later high',priority:'high',deadline:new Date(now+9*86400000).toISOString()}),project({title:'Urgent',deadline:new Date(now+3600000).toISOString()}),project({status:'paused',deadline:new Date(now).toISOString()}),project({status:'done',deadline:new Date(now).toISOString()})];
  assert.equal(rankedProjects(d.projects,now)[0].title,'Urgent');const due=await dueReminders(d,[],now);assert.equal(due.length,1);assert.match(due[0].message,/två timmar/);
  d.projects[1].deadline=new Date(now-86400000).toISOString();assert.match((await dueReminders(d,[],now))[0].message,/passerat/);
});
test('quiet hours follow Stockholm DST and a same-hour range disables quiet hours',()=>{
  const s=defaultPlanner().settings;assert.equal(inQuietHours(s,Date.parse('2026-03-29T05:59:00Z')),true);assert.equal(inQuietHours(s,Date.parse('2026-03-29T06:00:00Z')),false);assert.equal(inQuietHours(s,Date.parse('2026-10-25T06:59:00Z')),true);assert.equal(inQuietHours(s,Date.parse('2026-10-25T07:00:00Z')),false);assert.equal(inQuietHours({...s,quietStart:0,quietEnd:0},Date.parse('2026-10-11T00:00:00Z')),false);
});
test('event alarms exclude all-day and expired meetings',async()=>{
  const now=Date.parse('2026-10-11T12:00:00Z'),d=plan(),event={id:crypto.randomUUID(),title:'Meeting',start:new Date(now+20*60000).toISOString(),end:new Date(now+60*60000).toISOString(),allDay:false,source:'manual'};
  d.events=[event,{...event,id:crypto.randomUUID(),allDay:true},{...event,id:crypto.randomUUID(),start:new Date(now-10*60000).toISOString()}];assert.equal((await dueReminders(d,[],now)).length,1);
});
test('one reminder claim wins across clients, ack binds session, receipt prevents repeat',async t=>{
  const env=fixture(t),calls=upstream(t),d=plan();d.projects=[project({deadline:new Date(Date.now()+3600000).toISOString()})];await savePlan(env,d);const key=(await planner(env)).reminders[0].key;
  const first=await call(env,'planner/claim',{method:'POST',payload:{key,version:1}}),data=await first.json();assert.equal(first.status,200);assert.equal((await call(env,'planner/claim',{method:'POST',payload:{key,version:1}})).status,409);
  assert.equal((await call(env,'planner/ack',{method:'POST',role:'other',payload:{key,claimId:data.claimId}})).status,409);
  env.sql.prepare("INSERT INTO site_portal_sessions(token_hash,profile_id,created_at) VALUES(?,?,?)").run(hash('e'.repeat(64)),'admin','now');
  const wrong=request('planner/ack',{method:'POST',payload:{key,claimId:data.claimId}});wrong.headers.set('cookie','__Host-sp1e_session='+'e'.repeat(64));assert.equal((await handleSirDavidRequest(wrong,env,'planner/ack')).status,409);
  assert.equal((await call(env,'planner/ack',{method:'POST',payload:{key,claimId:data.claimId}})).status,200);assert.equal((await planner(env)).reminders.length,0);assert.equal(calls.length,0);
});
test('snooze covers deadline stage transitions and removed/done projects cannot be claimed',async t=>{
  const env=fixture(t),now=Date.parse('2026-10-11T12:00:00Z');t.mock.method(Date,'now',()=>now);const d=plan();d.projects=[project({deadline:new Date(now+2.5*3600000).toISOString()})];await savePlan(env,d);const r=(await planner(env)).reminders[0];assert.equal((await call(env,'planner/snooze',{method:'POST',payload:{key:r.key,minutes:60}})).status,200);
  t.mock.method(Date,'now',()=>now+40*60000);assert.equal((await planner(env)).reminders.length,0);t.mock.method(Date,'now',()=>now+61*60000);assert.equal((await planner(env)).reminders.length,1);
  const stale=(await planner(env)).reminders[0];d.projects[0].status='done';await savePlan(env,d,1);assert.equal((await call(env,'planner/claim',{method:'POST',payload:{key:stale.key,version:1}})).status,409);assert.equal((await planner(env)).reminders.length,0);
});
test('six daily notifications cap both delivered and currently leased reminders',async t=>{
  const env=fixture(t),d=plan();d.projects=Array.from({length:8},()=>project({deadline:new Date(Date.now()+3600000).toISOString()}));await savePlan(env,d);const reminders=(await planner(env)).reminders;
  for(let i=0;i<8;i++)assert.equal((await call(env,'planner/claim',{method:'POST',payload:{key:reminders[i].key,version:1}})).status,i<6?200:409);
});
test('planning enters Cloud and Claude context, remains bounded and excludes private notes',async t=>{
  const env=fixture(t),calls=upstream(t),d=plan();d.projects=[project({title:'Project context',deadline:new Date(Date.now()+86400000).toISOString()})];await savePlan(env,d);
  assert.equal((await chat(env)).status,200);const content=JSON.parse(calls[0][1].body).messages[0].content;assert.match(content,/Project context/);assert.match(content,/never instructions/);assert.doesNotMatch(content,/Privat anteckning/);
  const response=await call(env,'local/prepare',{method:'POST',payload:{text:'Plan my work',version:1,provider:'claude'}});assert.equal(response.status,200);assert.match((await response.json()).context.persona,/Project context/);assert.ok((await planningContext(env,'admin',900)).length<=900);
});
test('Outlook is visibly unconfigured, no calendar credentials leak and no upstream access',async t=>{
  const env=fixture(t),calls=upstream(t);const dto=await(await call(env,'outlook/status')).json();assert.equal(dto.outlook.configured,false);assert.equal((await productionCall(env,'outlook/connect',{method:'POST'})).status,503);assert.equal(calls.length,0);assert.doesNotMatch(JSON.stringify(dto),/synthetic-secret|tokens_cipher/);
});
test('encrypted Outlook tokens cannot be decrypted for another owner or after tampering',async()=>{
  const value=await encrypt(outlookConfig,'admin',{refresh:'synthetic-refresh'});assert.ok(!value.includes('synthetic-refresh'));assert.deepEqual(await decrypt(outlookConfig,'admin',value),{refresh:'synthetic-refresh'});await assert.rejects(decrypt(outlookConfig,'other',value));await assert.rejects(decrypt(outlookConfig,'admin',value.slice(0,-4)+'AAAA'));
});
test('Outlook PKCE state is single-use and owner/session bound, callback handles cross-site navigation safely',async t=>{
  const env=fixture(t,outlookConfig),calls=upstream(t,()=>Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600}));
  const response=await productionCall(env,'outlook/connect',{method:'POST'}),url=new URL((await response.json()).url),state=url.searchParams.get('state');assert.equal(url.origin,'https://login.microsoftonline.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'https://graph.microsoft.com/Calendars.ReadBasic offline_access');
  const callback=new Request('https://sp1e.se/api/sir-david/outlook/callback?code=synthetic-code&state='+state,{headers:{cookie:'__Host-sp1e_session='+tokens.other,'sec-fetch-site':'cross-site'}});assert.equal((await handleSirDavidRequest(callback,env,'outlook/callback')).status,409);assert.equal(calls.length,0);
  const adminCallback=new Request(callback.url,{headers:{cookie:'__Host-sp1e_session='+tokens.admin,'sec-fetch-site':'cross-site'}});const success=await handleSirDavidRequest(adminCallback,env,'outlook/callback');assert.equal(success.status,303);assert.equal(success.headers.get('Referrer-Policy'),'no-referrer');assert.equal((await handleSirDavidRequest(new Request(adminCallback),env,'outlook/callback')).status,409);assert.equal(calls.length,1);
  assert.ok(!env.sql.prepare('SELECT tokens_cipher FROM site_companion_outlook').get().tokens_cipher.includes('synthetic-refresh'));assert.doesNotMatch(await(await call(env,'outlook/status')).text(),/synthetic-access|synthetic-refresh/);
});
test('Graph continuation rejects foreign origin, credentials and wrong routes; private titles are masked',()=>{
  for(const url of ['https://evil.example/v1.0/me/calendarView','https://graph.microsoft.com/v1.0/me/messages','https://user@graph.microsoft.com/v1.0/me/calendarView','http://graph.microsoft.com/v1.0/me/calendarView'])assert.throws(()=>graphPage(url));assert.equal(graphPage('https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=test'),'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=test');
  const event={id:'graph-id',subject:'Confidential title',start:{dateTime:'2026-10-11T12:00:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-10-11T13:00:00.0000000',timeZone:'UTC'},isAllDay:false,sensitivity:'private'};assert.equal(normalizeGraphEvent(event).title,'Privat kalenderhändelse');assert.equal(normalizeGraphEvent({...event,isCancelled:true}),null);assert.throws(()=>normalizeGraphEvent({...event,start:{dateTime:'bad',timeZone:'UTC'}}));
});
test('Outlook sync rotates refresh token, caches only safe fields, does not overwrite project edits',async t=>{
  const env=fixture(t,outlookConfig),d=plan();d.projects=[project()];await savePlan(env,d);
  env.sql.prepare('INSERT INTO site_companion_outlook(owner_id,tokens_cipher) VALUES(?,?)').run('admin',await encrypt(env,'admin',{access:'old-access',refresh:'old-refresh',expires:0}));
  const calls=upstream(t,url=>url.endsWith('/token')?Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}):Response.json({value:[{id:'graph',subject:'Meeting',body:'Do not cache',attendees:['Do not cache'],start:{dateTime:'2026-10-11T12:00:00',timeZone:'UTC'},end:{dateTime:'2026-10-11T13:00:00',timeZone:'UTC'},isAllDay:false,sensitivity:'normal'}]}));
  assert.equal((await call(env,'outlook/sync',{method:'POST'})).status,200);assert.equal(calls.length,2);assert.equal((await planner(env)).document.projects.length,1);const row=env.sql.prepare('SELECT * FROM site_companion_outlook').get();assert.doesNotMatch(row.events_json,/Do not cache/);assert.equal((await decrypt(env,'admin',row.tokens_cipher)).refresh,'new-refresh');
  assert.equal((await call(env,'outlook/sync',{method:'POST'})).status,200);assert.equal(calls.length,2);assert.equal((await call(env,'outlook/disconnect',{method:'POST'})).status,200);assert.equal((await planner(env)).outlookEvents.length,0);
});
test('failed/incomplete calendar sync retains prior cache and disables stale event alarms',async t=>{
  const env=fixture(t,outlookConfig),old=[{id:'old',title:'Cached',start:new Date(Date.now()+600000).toISOString(),end:new Date(Date.now()+3600000).toISOString(),allDay:false,source:'outlook'}];
  env.sql.prepare('INSERT INTO site_companion_outlook(owner_id,tokens_cipher,events_json,last_sync) VALUES(?,?,?,?)').run('admin',await encrypt(env,'admin',{access:'synthetic-access',refresh:'synthetic-refresh',expires:Date.now()+3600000}),JSON.stringify(old),Date.now()-2*3600000);upstream(t,()=>Response.json({value:[], '@odata.nextLink':'https://evil.example/steal'}));assert.equal((await call(env,'outlook/sync',{method:'POST'})).status,503);const dto=await planner(env);assert.equal(dto.outlookEvents.length,1);assert.equal(dto.outlookFresh,false);assert.equal(dto.reminders.length,0);
});
test('revocation after the HTTP guard prevents planner mutations and reminder claims in the transaction',async t=>{
  for(const mode of ['save','claim']){
    const env=fixture(t),d=plan();d.projects=[project({deadline:new Date(Date.now()+3600000).toISOString()})];if(mode==='claim')await savePlan(env,d);
    const key=mode==='claim'?(await planner(env)).reminders[0].key:null,prepare=env.DB.prepare;
    t.mock.method(env.DB,'prepare',query=>{if(query.startsWith(mode==='save'?'INSERT INTO site_companion_planners':'INSERT INTO site_companion_reminders'))env.sql.prepare("UPDATE site_portal_sessions SET revoked_at='now' WHERE profile_id='admin'").run();return prepare(query);});
    const response=mode==='save'?await savePlan(env,d):await call(env,'planner/claim',{method:'POST',payload:{key,version:1}});assert.equal(response.status,409);assert.equal(env.sql.prepare('SELECT count(*) n FROM site_companion_reminders').get().n,0);if(mode==='save')assert.equal(env.sql.prepare('SELECT count(*) n FROM site_companion_planners').get().n,0);
  }
});
test('disconnect or session revocation during OAuth exchange cannot resurrect a calendar connection',async t=>{
  for(const mode of ['disconnect','revoke']){
    const env=fixture(t,outlookConfig);const response=await productionCall(env,'outlook/connect',{method:'POST'}),state=new URL((await response.json()).url).searchParams.get('state');
    t.mock.method(globalThis,'fetch',async()=>{if(mode==='disconnect')env.sql.prepare("DELETE FROM site_companion_outlook_states WHERE owner_id='admin'").run();else env.sql.prepare("UPDATE site_portal_sessions SET revoked_at='now' WHERE profile_id='admin'").run();return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});});
    const callback=new Request('https://sp1e.se/api/sir-david/outlook/callback?code=synthetic-code&state='+state,{headers:{cookie:'__Host-sp1e_session='+tokens.admin}});assert.equal((await handleSirDavidRequest(callback,env,'outlook/callback')).status,409);assert.equal(env.sql.prepare('SELECT count(*) n FROM site_companion_outlook').get().n,0);
  }
});
test('snooze and expired delivery leases cannot reset the six-attempt daily cap',async t=>{
  const env=fixture(t),start=Date.parse('2026-10-11T12:00:00Z');let now=start;t.mock.method(Date,'now',()=>now);const d=plan();d.projects=[project({deadline:new Date(now+24*3600000).toISOString()})];await savePlan(env,d);
  for(let i=0;i<6;i++){const r=(await planner(env)).reminders[0],response=await call(env,'planner/claim',{method:'POST',payload:{key:r.key,version:1}});assert.equal(response.status,200);assert.equal((await call(env,'planner/snooze',{method:'POST',payload:{key:r.key,minutes:15}})).status,200);now+=16*60000;}
  const r=(await planner(env)).reminders[0];assert.equal((await call(env,'planner/claim',{method:'POST',payload:{key:r.key,version:1}})).status,409);assert.equal(env.sql.prepare('SELECT claims FROM site_companion_reminder_days').get().claims,6);
});

test('saved audio defaults on, persists per owner and rejects stale clients without spending',async t=>{
  const env=fixture(t), calls=upstream(t);
  for (const role of [null,'guest','clique']) for (const method of ['GET','PUT']) {
    assert.equal((await call(env,'preferences',{role,method,payload:{autoSpeak:false,version:0}})).status,role?403:401);
  }
  assert.deepEqual((await (await call(env,'preferences')).json()).preferences,{autoSpeak:true,version:0});
  const writes=env.sql.prepare('SELECT total_changes() n').get().n;
  await call(env,'preferences');await call(env,'preferences');
  assert.equal(env.sql.prepare('SELECT total_changes() n').get().n,writes);
  assert.deepEqual((await (await call(env,'preferences',{method:'PUT',payload:{autoSpeak:false,version:0}})).json()).preferences,{autoSpeak:false,version:1});
  assert.deepEqual((await (await call(env,'profile')).json()).preferences,{autoSpeak:false,version:1});
  assert.deepEqual((await (await call(env,'preferences',{role:'other'})).json()).preferences,{autoSpeak:true,version:0});
  assert.equal((await call(env,'preferences',{method:'PUT',payload:{autoSpeak:true,version:0}})).status,409);
  for (const payload of [{autoSpeak:'true',version:1},{autoSpeak:true,version:-1},{autoSpeak:true,version:1,owner:'other'}]) {
    assert.equal((await call(env,'preferences',{method:'PUT',payload})).status,400);
  }
  assert.equal(calls.length,0); assert.equal(quotaCount(env),0);
});
test('mute rejects speech before provider access and another owner retains its own audio setting',async t=>{
  const env=fixture(t), calls=upstream(t,()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}}));
  await call(env,'preferences',{method:'PUT',payload:{autoSpeak:false,version:0}});
  assert.equal((await call(env,'speech',{method:'POST',payload:{text:'Hello'}})).status,409);
  assert.equal(calls.length,0); assert.equal(quotaCount(env),0); assert.equal(leaseCount(env),0);
  assert.equal((await call(env,'speech',{role:'other',method:'POST',payload:{text:'Hello'}})).status,200);
  assert.equal(calls.length,1);
});

test('real portal sessions restrict every companion route to Admin, including revoked identities',async t=>{
  const env=fixture(t),calls=upstream(t);
  for (const role of [null,'guest','clique']) for (const [route,method,payload] of [['profile','GET'],['memories','GET'],['memories','POST',{content:'secret'}],['conversation','GET'],['conversation','DELETE',{}],['chat','POST',{text:'hi',version:0}],['speech','POST',{text:'hi'}]]) {
    assert.equal((await call(env,route,{role,method,payload})).status,role?403:401,role+' '+route);
  }
  assert.equal((await call(env,'profile')).status,200);
  env.sql.prepare("UPDATE site_portal_sessions SET revoked_at=? WHERE profile_id='admin'").run(new Date().toISOString());
  assert.equal((await call(env,'profile')).status,401);
  env.sql.prepare("UPDATE site_portal_profiles SET revoked_at=? WHERE id='other'").run(new Date().toISOString());
  assert.equal((await call(env,'profile',{role:'other'})).status,401);
  assert.equal(calls.length,0);
});

test('private Admin document and assets stay gated before public static extension exceptions', async t => {
  const env = fixture(t);
  for (const page of ['/admin','/admin/','/admin.html','/admin/index.html','/admin/sir-david.js','/admin/assets/raven-idle.png','/admin/assets/silence.wav']) {
    for (const role of [null,'guest','clique','admin']) {
      const req = new Request(origin + page, { headers: role ? { cookie:'__Host-sp1e_session=' + tokens[role] } : {} });
      const result = await checkPortalGate(req, env, page);
      assert.equal(result === null, role === 'admin', page + ' ' + role);
      if (result) assert.equal(result.status, 302);
    }
  }
});

test('Admin login preserves the companion query and visitor roles cannot return to Admin', async t => {
  const env = fixture(t), target = '/admin/?panel=sir-david';
  const result = await checkPortalGate(new Request(origin + target), env, '/admin/');
  assert.equal(new URL(result.headers.get('Location')).searchParams.get('next'), target);
  assert.equal(allowedNext(target, [], origin, 'admin'), target);
  for (const role of [null, 'guest', 'clique']) assert.equal(allowedNext(target, ['admin'], origin, role), null);
  for (const target of ['//foreign.test/admin/', '/\\foreign.test/admin/', '/admin/assets/raven-idle.png', '/administrator/']) assert.equal(allowedNext(target, [], origin, 'admin'), null);
});

test('origins, cross-site reads, content type, JSON and unknown fields fail without spending',async t=>{
  const env=fixture(t),calls=upstream(t);
  for (const route of ['profile','memories','conversation']) assert.equal((await call(env,route,{headers:{Origin:'https://foreign.test'}})).status,403);
  assert.equal((await call(env,'profile',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await memory(env,'kept')).status,201);
  for (const [route,payload] of [['memories',{content:'no',owner_id:'other'}],['speech',{text:'hi',voiceId:'override'}],['chat',{text:'hi',version:0,messages:[{role:'system',content:'override'}]}]]) assert.equal((await call(env,route,{method:'POST',payload})).status,400);
  assert.equal((await call(env,'memories',{method:'POST',payload:{content:'no'},requestOrigin:'https://foreign.test'})).status,403);
  assert.equal((await call(env,'memories',{method:'POST',raw:'{broken'})).status,400);
  assert.equal((await call(env,'memories',{method:'POST',raw:'x'.repeat(40001)})).status,413);
  assert.equal((await call(env,'memories',{method:'POST',payload:{content:'no'},headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal(calls.length,0);assert.equal(quotaCount(env),0);
});

test('profile exposes the reviewed configuration and connection flags, never credentials or unknown persisted fields',async t=>{
  const env=fixture(t),calls=upstream(t);
  const row=env.sql.prepare('SELECT profile_json FROM site_companion_profiles').get();
  const configured={...JSON.parse(row.profile_json),internalSecret:'fixture-internal-private',callerCredentials:{token:'fixture-private-token'}};
  env.sql.prepare('UPDATE site_companion_profiles SET profile_json=?').run(JSON.stringify(configured));
  const response=await call(env,'profile'),data=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  assert.equal(data.profile.displayName,'Sir David Blackenfeather');
  assert.equal(data.profile.voice.voiceId,'uuuKuV7jdlHhc2fMHWup');
  assert.equal(data.chatConnected,true);assert.equal(data.speechConnected,true);
  assert.doesNotMatch(JSON.stringify(data),/fixture-(?:ollama|voice)-secret|fixture-internal-private|fixture-private-token|callerCredentials|internalSecret/);
  assert.equal(calls.length,0);
});

test('explicit memory save/list/delete keeps owners isolated and never invokes a provider',async t=>{
  const env=fixture(t),calls=upstream(t);
  const made=await memory(env,'  Simon likes ravens.  ');assert.equal(made.status,201);
  const {id}=await made.json();
  await memory(env,'Another owner note.','other');
  const data=await (await call(env,'memories')).json();
  assert.deepEqual(data.memories.map(item=>item.content),['Simon likes ravens.']);
  assert.equal(data.memories[0].id,id);assert.equal(data.memories[0].owner_id,undefined);
  assert.equal((await call(env,'memories/'+id,{role:'other',method:'DELETE'})).status,404);
  assert.equal((await call(env,'memories/'+id,{method:'DELETE'})).status,200);
  assert.deepEqual((await (await call(env,'memories')).json()).memories,[]);
  assert.equal((await call(env,'memories/'+id,{method:'DELETE'})).status,404);assert.equal(calls.length,0);
});

test('memory limits reject blank, oversized and full storage without altering existing notes',async t=>{
  const env=fixture(t);upstream(t);
  for(const content of ['', '   ', 'x'.repeat(1001),null]) assert.equal((await memory(env,content)).status,400);
  const insert=env.sql.prepare('INSERT INTO site_companion_memories(id,owner_id,content,created_at) VALUES (?,?,?,?)');
  for(let i=0;i<100;i++)insert.run(crypto.randomUUID(),'admin','note '+i,new Date().toISOString());
  assert.equal((await memory(env,'overflow')).status,409);
  assert.equal(env.sql.prepare("SELECT count(*) n FROM site_companion_memories WHERE owner_id='admin'").get().n,100);
});

test('missing provider secrets and disabled chat report unavailable before provider/quota/lease',async t=>{
  const calls=upstream(t);
  for(const extra of [{OLLAMA_API_KEY:''},{OLLAMA_API_KEY:'   '},{ASSISTANT_ENABLED:'false'}]) {
    const env=fixture(t,extra);assert.equal((await chat(env)).status,503);
    assert.equal((await (await call(env,'profile')).json()).chatConnected,false);assert.equal(quotaCount(env),0);assert.equal(leaseCount(env),0);
  }
  for(const key of ['', '   ']) {
    const env=fixture(t,{SIR_DAVID_ELEVENLABS_API_KEY:key});
    assert.equal((await call(env,'speech',{method:'POST',payload:{text:'Hello'}})).status,503);
    assert.equal((await (await call(env,'profile')).json()).speechConnected,false);assert.equal(quotaCount(env),0);
  }
  assert.equal(calls.length,0);
});

test('speech uses fixed server voice and bounded settings and returns only audio',async t=>{
  const env=fixture(t),calls=upstream(t,()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/mpeg'}}));
  const response=await call(env,'speech',{method:'POST',payload:{text:'  Hello Simon.  '}});
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'audio/mpeg');assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);assert.equal(calls.length,1);
  assert.equal(calls[0][0],'https://api.elevenlabs.io/v1/text-to-speech/uuuKuV7jdlHhc2fMHWup?output_format=mp3_44100_128');
  assert.equal(calls[0][1].headers['xi-api-key'],'fixture-voice-secret');
  assert.deepEqual(JSON.parse(calls[0][1].body),{text:'Hello Simon.',model_id:'eleven_multilingual_v2',voice_settings:{speed:0.9,stability:0.65,similarity_boost:0.8}});
  assert.equal(leaseCount(env),0);assert.equal(quotaCount(env),1);
});

test('speech rejects overlong text and unsupported client settings before provider access',async t=>{
  const env=fixture(t),calls=upstream(t);
  for(const payload of [{text:'x'.repeat(1201)},{text:'hello',model_id:'other'},{text:'hello',voice_settings:{speed:4}}]) assert.equal((await call(env,'speech',{method:'POST',payload})).status,400);
  assert.equal(calls.length,0);assert.equal(quotaCount(env),0);
});

test('provider errors and invalid audio are safe and release the durable lease',async t=>{
  const env=fixture(t);let response=()=>new Response('private-provider-detail',{status:500});const calls=upstream(t,()=>response());
  for(const [make,status] of [[()=>new Response('private-provider-detail',{status:429}),429],[()=>Response.json({error:'private-provider-detail'}),503],[()=>new Response('private-provider-detail',{status:500}),503]]) {
    response=make;const result=await call(env,'speech',{method:'POST',payload:{text:'hello'}});
    assert.equal(result.status,status);assert.doesNotMatch(await result.text(),/private-provider-detail|fixture-voice-secret/);assert.equal(leaseCount(env),0);
  }
  assert.equal(calls.length,3);
});

test('daily quota and another active lease block provider calls and retain the existing lease',async t=>{
  const env=fixture(t),calls=upstream(t),day=new Date().toISOString().slice(0,10);
  env.sql.prepare('INSERT INTO auth_attempts(scope,ip_hash,window_start,attempts,last_attempt_at) VALUES (?,?,?,?,?)').run('sir-david-speech','admin',day,30,new Date().toISOString());
  assert.equal((await call(env,'speech',{method:'POST',payload:{text:'hello'}})).status,429);assert.equal(leaseCount(env),0);
  env.sql.prepare('INSERT INTO site_companion_leases(owner_id,kind,token,expires_at) VALUES (?,?,?,?)').run('admin','chat','existing-fixture-lease',Date.now()+60000);
  assert.equal((await chat(env)).status,409);
  assert.equal(env.sql.prepare("SELECT token FROM site_companion_leases WHERE kind='chat'").get().token,'existing-fixture-lease');assert.equal(calls.length,0);
});

test('new chat persists server-owned history and only explicitly saved owner memories enter context',async t=>{
  const env=fixture(t),calls=upstream(t);
  await memory(env,'Approved owner note.');await memory(env,'PRIVATE other owner note.','other');
  assert.deepEqual(await conversation(env),{version:0,messages:[]});
  let response=await chat(env,'Hello',0);assert.equal(response.status,200);
  let data=await response.json();assert.equal(data.text,'Good evening, Simon.');assert.equal(data.conversation.version,1);
  assert.deepEqual(data.conversation.messages,[{role:'user',content:'Hello'},{role:'assistant',content:'Good evening, Simon.'}]);
  assert.deepEqual(await conversation(env),data.conversation);assert.deepEqual(await conversation(env,'other'),{version:0,messages:[]});
  const body=JSON.parse(calls[0][1].body);assert.equal(body.model,'gemma4:31b');assert.equal(body.think,false);assert.equal(body.stream,false);
  assert.match(body.messages[0].content,/Approved owner note/);assert.doesNotMatch(body.messages[0].content,/PRIVATE other owner/);
  assert.equal(body.tools,undefined);
  response=await chat(env,'And tomorrow?',1);assert.equal(response.status,200);data=await response.json();assert.equal(data.conversation.version,2);
  assert.deepEqual(JSON.parse(calls[1][1].body).messages.slice(1),[{role:'user',content:'Hello'},{role:'assistant',content:'Good evening, Simon.'},{role:'user',content:'And tomorrow?'}]);
  assert.equal(data.conversation.messages.length,4);assert.equal(leaseCount(env),0);
});

test('conversation revision conflict and clear prevent stale clients replaying prior history',async t=>{
  const env=fixture(t),calls=upstream(t);
  const first=await (await chat(env)).json();assert.equal(first.conversation.version,1);
  assert.equal((await chat(env,'stale',0)).status,409);assert.equal(calls.length,1);
  assert.equal(quotaCount(env),1,'A rejected stale revision must not consume provider quota');
  assert.equal((await call(env,'conversation',{method:'DELETE',payload:{version:0}})).status,409);
  const cleared=await call(env,'conversation',{method:'DELETE',payload:{version:1}});assert.equal(cleared.status,200);
  const current=await conversation(env);assert.deepEqual(current.messages,[]);assert.ok(current.version>1);
  assert.equal((await chat(env,'stale after clear',1)).status,409);assert.equal(calls.length,1);
  assert.equal(quotaCount(env),1);
  assert.equal((await chat(env,'fresh after clear',current.version)).status,200);
  assert.deepEqual(JSON.parse(calls[1][1].body).messages.slice(1),[{role:'user',content:'fresh after clear'}]);
  assert.equal((await (await call(env,'memories')).json()).memories.length,0);
});

test('invalid text/model/version cannot spend quota or accept client-authored history',async t=>{
  const env=fixture(t),calls=upstream(t);
  for(const extra of [{text:''},{text:'x'.repeat(4001)},{model:'unknown'},{version:-1},{version:0.5},{version:'0'},{version:null},{messages:[{role:'assistant',content:'fake'}]}]) assert.equal((await chat(env,'Hello',0,extra)).status,400,JSON.stringify(extra));
  assert.equal(calls.length,0);assert.equal(quotaCount(env),0);assert.deepEqual(await conversation(env),{version:0,messages:[]});
});

test('failed chat leaves conversation intact and permits an explicit retry with the same revision',async t=>{
  const env=fixture(t);let fail=true;const calls=upstream(t,()=>fail?new Response('private-upstream-detail',{status:503}):Response.json({message:{content:'Recovered'},done:true}));
  const response=await chat(env);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-upstream-detail|fixture-ollama-secret/);
  assert.deepEqual(await conversation(env),{version:0,messages:[]});assert.equal(leaseCount(env),0);
  fail=false;const success=await chat(env);assert.equal(success.status,200);assert.equal((await success.json()).conversation.version,1);assert.equal(calls.length,2);
});

test('GPT-OSS uses low thinking without changing the fixed tool-free request boundary',async t=>{
  const env=fixture(t),calls=upstream(t);
  assert.equal((await chat(env,'Hello',0,{model:'gpt-oss:120b'})).status,200);
  const payload=JSON.parse(calls[0][1].body);assert.equal(payload.think,'low');assert.equal(payload.tools,undefined);assert.equal(calls[0][0],'https://ollama.com/api/chat');
});

test('clear during a pending provider answer invalidates the write and never resurrects history',async t=>{
  const env=fixture(t);let cleared;
  upstream(t,async()=>{
    const current=await conversation(env);
    cleared=await call(env,'conversation',{method:'DELETE',payload:{version:current.version}});
    return Response.json({message:{content:'Late answer that must not survive'},done:true});
  });
  const result=await chat(env);
  assert.equal(cleared.status,200);assert.equal(result.status,409);
  const current=await conversation(env);assert.deepEqual(current.messages,[]);assert.ok(current.version>0);
  assert.equal(leaseCount(env),0);
});

test('an in-flight chat lease rejects a second request without double spending',async t=>{
  const env=fixture(t);let unblock,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{unblock=resolve;});
  const calls=upstream(t,async()=>{entered();await pending;return Response.json({message:{content:'One answer'},done:true});});
  const first=chat(env);await ready;
  try {
    assert.equal((await chat(env,'Second request')).status,409);
    assert.equal(calls.length,1);assert.equal(quotaCount(env),1);assert.equal(leaseCount(env),1);
  } finally { unblock(); }
  assert.equal((await first).status,200);assert.equal(leaseCount(env),0);
  assert.equal((await conversation(env)).messages.length,2);
});

test('latest server history is bounded before the next provider request',async t=>{
  const env=fixture(t),calls=upstream(t);
  await conversation(env);
  const prior=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',content:'old-'+i+' '+ 'x'.repeat(2000)}));
  env.sql.prepare("UPDATE site_companion_conversations SET version=7,messages_json=? WHERE owner_id='admin'").run(JSON.stringify(prior));
  const result=await chat(env,'Latest user message',7);assert.equal(result.status,200);
  const payload=JSON.parse(calls[0][1].body),sent=payload.messages.slice(1);
  assert.ok(sent.length<=15);assert.ok(sent.reduce((total,item)=>total+item.content.length,0)<=16000);
  assert.deepEqual(sent.at(-1),{role:'user',content:'Latest user message'});
  assert.equal(sent.some(item=>item.content.startsWith('old-0 ')),false);
  const saved=(await result.json()).conversation;
  assert.ok(saved.messages.length<=16);assert.deepEqual(saved.messages.slice(0,-1),sent);
});

const localBody = (text = 'Hello', version = 0) => ({ text, version, provider:'claude' });
test('revocation and version changes between local preparation read and transaction reserve no turn',async t=>{
  for (const mutation of [
    "UPDATE site_portal_profiles SET revoked_at='revoked' WHERE id='admin'",
    "UPDATE site_companion_conversations SET version=version+1 WHERE owner_id='admin'",
  ]) {
    const env=fixture(t), batch=env.DB.batch;
    env.DB.batch=async statements=>{env.sql.exec(mutation);return batch(statements);};
    assert.equal((await call(env,'local/prepare',{method:'POST',payload:localBody()})).status,409);
    assert.equal(leaseCount(env),0);
    assert.equal(env.sql.prepare('SELECT COUNT(*) n FROM site_companion_local_turns').get().n,0);
  }
});
test('local turns require Admin, current origin and exact fields without any provider call',async t=>{
  const env=fixture(t),calls=upstream(t);
  for (const role of [null,'guest','clique']) for (const route of ['local/prepare','local/commit','local/cancel']) {
    assert.equal((await call(env,route,{role,method:'POST',payload:localBody()})).status,role?403:401);
  }
  assert.equal((await call(env,'local/prepare',{method:'POST',payload:localBody(),requestOrigin:'https://foreign.test'})).status,403);
  for (const addition of [{provider:'codex'},{persona:'override'},{version:-1},{text:'x'.repeat(4001)},{messages:[]}]) {
    assert.equal((await call(env,'local/prepare',{method:'POST',payload:{...localBody(),...addition}})).status,400);
  }
  assert.equal(calls.length,0);assert.equal(quotaCount(env),0);assert.equal(leaseCount(env),0);
});
test('local prepare shares server persona and notes; commit persists server user text exactly once',async t=>{
  const env=fixture(t,{OLLAMA_API_KEY:undefined}),calls=upstream(t);
  await memory(env,'Remember this');
  const response=await call(env,'local/prepare',{method:'POST',payload:localBody('Owner request')});
  assert.equal(response.status,200);
  const prepared=await response.json();
  assert.equal(prepared.context.text,'Owner request');assert.deepEqual(prepared.context.messages,[]);
  assert.deepEqual(prepared.context.memories,['Remember this']);assert.match(prepared.context.persona,/Sir David/);
  assert.ok(prepared.turn.expiresAt>Date.now() && prepared.turn.expiresAt<=Date.now()+180000);
  assert.equal(leaseCount(env),1);
  const payload={turnId:prepared.turn.id,version:0,text:'Local answer'};
  const saved=await call(env,'local/commit',{method:'POST',payload});
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).conversation,{version:1,messages:[{role:'user',content:'Owner request'},{role:'assistant',content:'Local answer'}]});
  assert.equal((await call(env,'local/commit',{method:'POST',payload})).status,409);
  assert.equal(leaseCount(env),0);assert.equal(calls.length,0);assert.equal(quotaCount(env),0);
});
test('local reservations exclude concurrent preparations and Cloud jobs before provider usage',async t=>{
  const env=fixture(t),calls=upstream(t);
  const responses=await Promise.all([1,2].map(()=>call(env,'local/prepare',{method:'POST',payload:localBody()})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call(env,'chat',{method:'POST',payload:{text:'Cloud request',version:0}})).status,409);
  assert.equal(calls.length,0);assert.equal(quotaCount(env),0);
  const pending=await responses.find(r=>r.status===200).json();
  assert.equal((await call(env,'local/cancel',{method:'POST',payload:{turnId:pending.turn.id}})).status,200);
  env.sql.prepare("INSERT INTO site_companion_leases(owner_id,kind,token,expires_at) VALUES ('admin','chat','cloud',?)").run(Date.now()+120000);
  assert.equal((await call(env,'local/prepare',{method:'POST',payload:localBody()})).status,409);
  assert.equal(calls.length,0);
});
test('local commit and cancel bind both owner and session, with independent conversations',async t=>{
  const env=fixture(t),calls=upstream(t);
  const prepared=await (await call(env,'local/prepare',{method:'POST',payload:localBody()})).json();
  const payload={turnId:prepared.turn.id,version:0,text:'Answer'};
  assert.equal((await call(env,'local/commit',{role:'other',method:'POST',payload})).status,409);
  assert.deepEqual(await (await call(env,'local/cancel',{role:'other',method:'POST',payload:{turnId:prepared.turn.id}})).json(),{cancelled:false});
  const second='e'.repeat(64);
  env.sql.prepare('INSERT INTO site_portal_sessions(token_hash,profile_id,created_at) VALUES (?,?,?)').run(hash(second),'admin',new Date().toISOString());
  assert.equal((await call(env,'local/commit',{method:'POST',payload,headers:{cookie:'__Host-sp1e_session='+second}})).status,409);
  assert.equal((await call(env,'local/commit',{method:'POST',payload})).status,200);
  assert.equal(calls.length,0);
});
test('clear and expiry cannot resurrect local history, stale reservations permit a fresh turn',async t=>{
  const env=fixture(t),calls=upstream(t);
  const prepared=await (await call(env,'local/prepare',{method:'POST',payload:localBody()})).json();
  assert.equal((await call(env,'conversation',{method:'DELETE',payload:{version:0}})).status,200);
  assert.equal((await call(env,'local/commit',{method:'POST',payload:{turnId:prepared.turn.id,version:0,text:'Too late'}})).status,409);
  const next=await (await call(env,'local/prepare',{method:'POST',payload:localBody('Next',1)})).json();
  env.sql.prepare('UPDATE site_companion_local_turns SET expires_at=0').run();
  assert.equal((await call(env,'local/commit',{method:'POST',payload:{turnId:next.turn.id,version:1,text:'Expired'}})).status,409);
  assert.deepEqual((await (await call(env,'conversation')).json()).conversation,{version:1,messages:[]});
  assert.equal((await call(env,'local/prepare',{method:'POST',payload:localBody('Retry',1)})).status,200);
  assert.equal(calls.length,0);
});
test('cancel releases the exact local reservation and suppresses its late result',async t=>{
  const env=fixture(t);
  const prepared=await (await call(env,'local/prepare',{method:'POST',payload:localBody()})).json();
  const payload={turnId:prepared.turn.id};
  assert.deepEqual(await (await call(env,'local/cancel',{method:'POST',payload})).json(),{cancelled:true});
  assert.equal(leaseCount(env),0);
  assert.deepEqual(await (await call(env,'local/cancel',{method:'POST',payload})).json(),{cancelled:false});
  assert.equal((await call(env,'local/commit',{method:'POST',payload:{...payload,version:0,text:'Late'}})).status,409);
  assert.equal((await call(env,'local/prepare',{method:'POST',payload:localBody()})).status,200);
});
test('revocation after the request guard is rechecked inside the local commit transaction',async t=>{
  const env=fixture(t),calls=upstream(t);
  const prepared=await (await call(env,'local/prepare',{method:'POST',payload:localBody()})).json();
  const batch=env.DB.batch;
  env.DB.batch=async statements=>{
    env.sql.prepare("UPDATE site_portal_sessions SET revoked_at=? WHERE profile_id='admin'").run(new Date().toISOString());
    return batch(statements);
  };
  assert.equal((await call(env,'local/commit',{method:'POST',payload:{turnId:prepared.turn.id,version:0,text:'Revoked'}})).status,409);
  assert.equal(env.sql.prepare("SELECT version FROM site_companion_conversations WHERE owner_id='admin'").get().version,0);
  assert.equal(calls.length,0);
});
test('local history and notes stay bounded and client-supplied memory and oversized replies are rejected',async t=>{
  const env=fixture(t),calls=upstream(t);
  await call(env,'conversation');
  const history=Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',content:'x'.repeat(4000)}));
  env.sql.prepare("UPDATE site_companion_conversations SET messages_json=? WHERE owner_id='admin'").run(JSON.stringify(history));
  for(let i=0;i<30;i++) await memory(env,'x'.repeat(1000));
  const prepared=await (await call(env,'local/prepare',{method:'POST',payload:localBody()})).json();
  assert.ok(prepared.context.messages.length<=14);
  assert.ok(prepared.context.messages.reduce((sum,m)=>sum+m.content.length,prepared.context.text.length)<=16000);
  assert.ok(JSON.stringify(prepared.context.memories).length<=20000);
  for(const extra of [{text:'x'.repeat(12001)},{memories:['injected']}]) {
    assert.equal((await call(env,'local/commit',{method:'POST',payload:{turnId:prepared.turn.id,version:0,text:'Answer',...extra}})).status,400);
  }
  assert.equal(calls.length,0);
});
