import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
const code=fs.readFileSync(new URL('../admin/sir-david.js',import.meta.url),'utf8');
const bundle=fs.readFileSync(new URL('../admin/claude-adapter.js',import.meta.url),'utf8');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const turnId='11111111-1111-4111-8111-111111111111';
async function until(predicate){for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(predicate(),'Expected state did not arrive');}
async function fixture(t,options={}){
  const dom=new JSDOM(html,{url:options.url??'https://www.sp1e.se/admin/?panel=sir-david',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  w.AbortController=AbortController;w.AbortSignal=AbortSignal;
  const site=[],local=[],plays=[],popup={closed:false,close(){this.closed=true;}};
  let conversation={version:2,messages:[{role:'user',content:'Old question'},{role:'assistant',content:'Old answer'}]},prepared;
  const models=[{id:'sonnet',name:'Sonnet',efforts:['low','high']},{id:'haiku',name:'Haiku',efforts:[]},{id:'fable',name:'Fable',efforts:['low','high']}];
  w.open=()=>popup;w.confirm=()=>true;
  w.URL.createObjectURL=()=> 'blob:mock';w.URL.revokeObjectURL=()=>{};
  w.Audio=class extends w.EventTarget{pause(){} play(){if(this.src.startsWith('blob:')){plays.push(this.src);queueMicrotask(()=>this.dispatchEvent(new w.Event('ended')));}return Promise.resolve();}};
  w.fetch=async(url,init={})=>{
    if(String(url).startsWith('http://127.0.0.1:4318/')){
      const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):undefined;
      local.push({url:String(url),path,body,init});
      if(path.endsWith('/status'))return json({providers:[{id:'claude',installed:true,signedIn:true,billingMode:options.unverified?'unverified':'subscription',models,...(options.workspace?{workspace:{enabled:true,name:'Sir David-arbetsmapp'}}:{})}]});
      if(path==='/__agents/workspace')return json({enabled:true,name:'Sir David-arbetsmapp',activity:options.activity??[]});
      if(path==='/__agents/workspace/undo')return options.undo?options.undo():json({action:'undo',version:'b'.repeat(64)});
      if(path.endsWith('/jobs'))return json({id:'job_123456789',state:'running'},202);
      if(path.includes('/jobs/'))return options.poll?options.poll():json({state:'done',result:{text:'A distinguished reply.'}});
      if(path.endsWith('/cancel'))return json({cancelled:true});
      if(path.endsWith('/disconnect'))return json({disconnected:true});
      throw Error('Unexpected local route');
    }
    const path=String(url).replace('/api/sir-david/',''),body=init.body?JSON.parse(init.body):undefined;
    site.push({path,body,init});
    if(path==='profile')return json({profile:{displayName:'Sir David Blackenfeather'},models:['gemma4:31b'],chatConnected:true,speechConnected:true,preferences:{autoSpeak:options.sound!==false,version:0}});
    if(path==='preferences')return options.preferencesUnauthorized?json({error:'Logga in först'},401):json({preferences:{autoSpeak:options.sound!==false,version:0}});
    if(path==='chat')return json({conversation:{version:3,messages:[{role:'user',content:body.text},{role:'assistant',content:'Cloud preview reply.'}]}});
    if(path==='conversation')return json({conversation});
    if(path==='memories')return json({memories:[{id:turnId,content:'A saved note'}]});
    if(path==='local/prepare'){
      prepared={turn:{id:turnId,version:conversation.version,expiresAt:Date.now()+120000},context:{persona:'British gentleman with dry humour.',text:body.text,messages:conversation.messages,memories:['A saved note']}};
      return json(prepared);
    }
    if(path==='local/commit'){
      if(options.conflict)return json({error:'Samtalet har ändrats i en annan vy.'},409);
      conversation={version:3,messages:[...conversation.messages,{role:'user',content:prepared.context.text},{role:'assistant',content:body.text}]};
      return json({text:body.text,conversation});
    }
    if(path==='local/cancel')return options.cancelUnauthorized?json({error:'Logga in först.'},401):json({cancelled:true});
    if(path==='speech')return new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'audio/mpeg'}});
    throw Error('Unexpected site route: '+path);
  };
  w.eval(bundle);w.eval(code);
  const $=id=>w.document.getElementById(id);
  await until(()=>$('provider').disabled===false);
  function choose(){ $('provider').value='claude';$('provider').dispatchEvent(new w.Event('change')); }
  async function pair(){
    choose();$('connect-claude').click();
    const event=new w.Event('message');Object.assign(event,{origin:'http://127.0.0.1:4318',source:popup,data:{type:'sp1e-local-paired',token:'t'.repeat(43)}});w.dispatchEvent(event);
    await until(()=>$('provider').disabled===false);
  }
  function submit(text='Hello'){ $('prompt').value=text;$('chat-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); }
  return {w,$,site,local,plays,models,pair,choose,submit};
}
test('local Claude commits to shared history and uses the same automatic speech route',async t=>{
  const f=await fixture(t);assert.equal(f.plays.length,0);assert.equal(f.local.length,0);
  await f.pair();f.submit();await until(()=>f.plays.length===1);
  const job=f.local.find(item=>item.path.endsWith('/jobs')).body;
  assert.equal(job.provider,'claude');assert.equal(job.kind,'sir-david');assert.equal(job.persona,'British gentleman with dry humour.');
  assert.deepEqual(job.notes,['A saved note']);assert.equal(job.messages.at(-1).content,'Old answer');
  assert.ok(f.local.find(item=>item.path.endsWith('/status')).url.endsWith('?provider=claude&kind=sir-david'));
  assert.deepEqual(f.site.find(item=>item.path==='local/prepare').body,{text:'Hello',version:2,provider:'claude'});
  assert.deepEqual(f.site.find(item=>item.path==='local/commit').body,{turnId,version:2,text:'A distinguished reply.'});
  assert.equal(f.site.some(item=>item.path==='chat'),false);assert.ok(f.$('messages').textContent.includes('A distinguished reply.'));
});

test('workspace mode uses explicit scope and retains the shared commit and voice route',async t=>{
  const f=await fixture(t,{workspace:true});await f.pair();
  assert.equal(f.$('files-mode').disabled,false);assert.equal(f.$('file-panel').hidden,false);
  f.$('files-mode').checked=true;f.submit('Create a note');await until(()=>f.plays.length===1);
  assert.equal(f.local.find(item=>item.path.endsWith('/jobs')).body.workspace,true);
  assert.ok(f.site.some(item=>item.path==='local/commit'));assert.ok(f.site.some(item=>item.path==='speech'));
});
test('revoked workspace scope stops before prepare instead of falling back to chat',async t=>{
  const options={workspace:true},f=await fixture(t,options);await f.pair();f.$('files-mode').checked=true;
  options.workspace=false;f.submit('Edit the file');await until(()=>f.$('status').textContent.includes('Filåtkomsten'));
  assert.equal(f.site.some(item=>item.path==='local/prepare'),false);assert.equal(f.local.some(item=>item.path.endsWith('/jobs')),false);
  assert.equal(f.$('prompt').value,'Edit the file');
});
test('file history uses text rendering and revision-checked undo',async t=>{
  const id='1791673000000000000-'+'a'.repeat(32),version='a'.repeat(64);
  const f=await fixture(t,{workspace:true,activity:[{id,path:'<img src=x onerror=alert(1)>',afterVersion:version}]});await f.pair();
  await until(()=>f.$('file-activity').querySelector('button'));
  assert.equal(f.$('file-activity').querySelector('img'),null);
  assert.match(f.$('file-activity').textContent,/<img/);
  f.$('file-activity').querySelector('button').click();await until(()=>f.$('file-status').textContent.includes('återställd'));
  assert.deepEqual(f.local.find(item=>item.path.endsWith('/workspace/undo')).body,{changeId:id,expectedVersion:version});
});
test('lost Admin authentication clears local history and blocks undo',async t=>{
  const options={workspace:true,activity:[{id:'1791673000000000000-'+'a'.repeat(32),path:'private-note.txt',afterVersion:'a'.repeat(64)}]},f=await fixture(t,options);await f.pair();
  await until(()=>f.$('file-activity').querySelector('button'));options.preferencesUnauthorized=true;
  f.$('file-activity').querySelector('button').click();await until(()=>f.$('file-panel').hidden);
  assert.equal(f.$('file-activity').textContent,'');assert.equal(f.local.some(item=>item.path.endsWith('/workspace/undo')),false);
});
test('unverified subscription stops before prepare or model work and asks to update companion',async t=>{
  const f=await fixture(t,{unverified:true});await f.pair();
  assert.equal(f.$('send').disabled,true);assert.match(f.$('status').textContent,/Uppdatera och starta om/);
  assert.equal(f.site.some(item=>item.path==='local/prepare'),false);assert.equal(f.local.some(item=>item.path.endsWith('/jobs')),false);
});
test('cancelled local answer discards late output and cancels server with a fresh signal',async t=>{
  let release;const late=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{poll:()=>late});await f.pair();f.submit('Keep my draft');
  await until(()=>f.local.some(item=>item.path.includes('/jobs/')));f.$('stop-chat').click();release(json({state:'done',result:{text:'Late answer'}}));
  await until(()=>f.site.some(item=>item.path==='local/cancel'));
  assert.equal(f.site.some(item=>item.path==='local/commit'),false);assert.equal(f.$('messages').textContent.includes('Late answer'),false);
  assert.equal(f.$('prompt').value,'Keep my draft');assert.equal(f.plays.length,0);
  const cancelled=f.site.find(item=>item.path==='local/cancel');assert.equal(cancelled.init.signal.aborted,false);assert.equal(cancelled.init.keepalive,true);
  assert.ok(f.local.some(item=>item.path.endsWith('/cancel')));
});
test('commit conflict preserves draft, stays silent and cancels the server turn',async t=>{
  const f=await fixture(t,{conflict:true});await f.pair();f.submit('Draft');
  await until(()=>f.$('status').textContent.includes('ändrats'));
  assert.equal(f.$('prompt').value,'Draft');assert.equal(f.plays.length,0);assert.ok(f.site.some(item=>item.path==='local/cancel'));
});
test('auth lost during cleanup cannot render the returned private conversation',async t=>{
  const f=await fixture(t,{cancelUnauthorized:true});await f.pair();f.submit();
  await until(()=>f.site.some(item=>item.path==='local/cancel'));await until(()=>f.$('send').disabled===true&&f.$('stop-chat').hidden);
  assert.equal(f.$('messages').textContent,'');assert.equal(f.$('memories').textContent,'');assert.equal(f.plays.length,0);
});
test('Claude model effort choices follow metadata and Fable exposes extra-credit notice',async t=>{
  const f=await fixture(t,{sound:false});await f.pair();
  f.$('claude-model').value='fable';f.$('claude-model').dispatchEvent(new f.w.Event('change'));
  assert.match(f.$('claude-note').textContent,/extrakrediter/);f.$('claude-effort').value='high';f.submit();
  await until(()=>f.site.some(item=>item.path==='local/commit'));
  const job=f.local.find(item=>item.path.endsWith('/jobs')).body;assert.equal(job.model,'fable');assert.equal(job.effort,'high');assert.equal(f.plays.length,0);
});
test('a removed model choice stops before prepare instead of silently falling back',async t=>{
  const f=await fixture(t);await f.pair();f.$('claude-model').value='sonnet';f.$('claude-model').dispatchEvent(new f.w.Event('change'));
  f.models.splice(0,1);f.submit();await until(()=>f.$('status').textContent.includes('modellvalet'));
  assert.equal(f.site.some(item=>item.path==='local/prepare'),false);assert.equal(f.local.some(item=>item.path.endsWith('/jobs')),false);
});

test('unsupported local and Pages preview origins preserve cloud chat and refuse local pairing',async t=>{
  for(const url of ['http://127.0.0.1:4345/admin/?panel=sir-david','https://preview.sp1e-se.pages.dev/admin/?panel=sir-david']){
    const f=await fixture(t,{url,sound:false});
    assert.equal(f.$('send').disabled,false);f.submit('Cloud request');
    await until(()=>f.$('messages').textContent.includes('Cloud preview reply.'));
    await until(()=>f.$('provider').disabled===false);
    f.choose();f.$('connect-claude').click();
    assert.match(f.$('status').textContent,/Lokal Claude ansluts från sp1e.se/);
    assert.equal(f.local.length,0);
  }
});
