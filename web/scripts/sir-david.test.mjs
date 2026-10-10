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
test.after(() => fs.rmSync(temp, { recursive:true, force:true }));

const origin = 'https://sp1e.test';
const tokens = { admin:'a'.repeat(64), other:'b'.repeat(64), guest:'c'.repeat(64), clique:'d'.repeat(64) };
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, extra = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of ['schema.sql','site-migration-002-auth-throttle.sql','site-migration-003-portal.sql','site-migration-005-sir-david.sql']) sql.exec(fs.readFileSync(new URL(file, root),'utf8'));
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
