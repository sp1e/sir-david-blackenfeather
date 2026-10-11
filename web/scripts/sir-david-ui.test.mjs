import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const html = fs.readFileSync('admin/index.html', 'utf8');
const script = fs.readFileSync('admin/sir-david.js', 'utf8');
const plannerScript = fs.readFileSync('admin/sir-david-planner.js', 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

async function audioFixture(t, options = {}) {
  const dom=new JSDOM(html,{url:'https://www.sp1e.se/admin/?panel=sir-david',runScripts:'outside-only'});
  t.after(async()=>{dom.window.dispatchEvent(new dom.window.Event('pagehide'));await settle();dom.window.close();});
  const w=dom.window, calls=[], played=[], pauses=[];
  let nativeMessages;
  if(options.native){nativeMessages=new w.EventTarget();nativeMessages.postMessage=()=>{};Object.defineProperty(w,'chrome',{value:{webview:nativeMessages}});}
  let preferences={autoSpeak:options.autoSpeak??true,version:0}, pendingSpeech, pendingChat, poll;
  if(options.capturePoll){w.setInterval=callback=>{poll=callback;return 1;};w.clearInterval=()=>{};}
  const conversation={version:0,messages:[{role:'assistant',content:'Old reply, do not replay.'}]};
  w.confirm=()=>true;
  w.Audio=class extends w.EventTarget {
    constructor(){super();this.src='';}
    pause(){pauses.push(this.src);}
    async play(){
      if(!this.src.startsWith('blob:'))return;
      if(options.blockAudio)throw Object.assign(Error('blocked'),{name:'NotAllowedError'});
      played.push(this.src);if(!options.holdAudio)setTimeout(()=>this.dispatchEvent(new w.Event('ended')),0);
    }
  };
  let nextUrl=0;w.URL.createObjectURL=()=> 'blob:voice-'+(++nextUrl);w.URL.revokeObjectURL=()=>{};
  w.fetch=async(url,init={})=>{
    calls.push([url,init]);let data;
    if(url.endsWith('/profile'))data={profile:{displayName:'Sir David'},preferences,models:['gemma4:31b'],chatConnected:true,speechConnected:true};
    else if(url.endsWith('/preferences')) {
      if(init.method==='PUT') {
        if(options.failSave)return{ok:false,status:503,json:async()=>({error:'Save failed'})};
        const body=JSON.parse(init.body); assert.equal(body.version,preferences.version);
        preferences={autoSpeak:body.autoSpeak,version:preferences.version+1};
      }
      data={preferences};
    } else if(url.endsWith('/memories'))data={memories:[]};
    else if(url.endsWith('/conversation'))data={conversation};
    else if(url.endsWith('/chat')) {
      const finish=()=>({ok:true,json:async()=>({conversation:{version:++conversation.version,messages:[{role:'user',content:JSON.parse(init.body).text},{role:'assistant',content:options.reply??'New reply.'}]}})});
      if(options.delayChat)return new Promise(resolve=>{pendingChat=()=>resolve(finish());});
      return finish();
    } else if(url.endsWith('/speech')) {
      const response={ok:true,blob:async()=>new w.Blob(['synthetic audio'])};
      if(options.delaySpeech)return new Promise(resolve=>{pendingSpeech=()=>resolve(response);});
      return response;
    } else if(options.withPlanner&&url.endsWith('/planner'))data={planner:{version:0,document:{projects:[],events:[],settings:{reminders:false,desktopNotifications:false,speakWhenOpen:true,timezone:'Europe/Stockholm',quietStart:22,quietEnd:8}},focus:[],reminders:[],outlookEvents:[],serverTime:new Date().toISOString(),quiet:false}};
    else if(options.withPlanner&&url.endsWith('/outlook/status'))data={outlook:{configured:false,connected:false}};
    else throw Error('Unexpected endpoint');
    return{ok:true,json:async()=>data};
  };
  if(options.withPlanner)w.eval(plannerScript);w.eval(script);await settle();
  return{w,calls,played,pauses,preferences:()=>preferences,poll:()=>poll(),releaseSpeech:()=>pendingSpeech(),releaseChat:()=>pendingChat(),nativeVisible(value){nativeMessages.dispatchEvent(new w.MessageEvent('message',{data:{type:'sir-david-native-tick',visible:value}}));},async submit(){w.document.getElementById('prompt').value='Hello';w.document.getElementById('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();}};
}

test('full Admin initializes the shared planner after authentication and keeps the normal voice path',async t=>{const f=await audioFixture(t,{withPlanner:true});assert.equal(f.w.document.getElementById('planner-panel').hidden,false);assert.ok(f.calls.some(([url])=>url.endsWith('/planner')));assert.equal(f.played.length,0);await f.submit();assert.equal(f.played.length,1);});
test('native hidden-window signal stops speech and prevents speaking a new chat answer until reopened',async t=>{const f=await audioFixture(t,{native:true,withPlanner:true});f.nativeVisible(false);await f.submit();assert.equal(f.calls.some(([url])=>url.endsWith('/speech')),false);f.nativeVisible(true);await f.submit();assert.equal(f.played.length,1);});
test('new replies speak automatically in bounded chunks, restored history stays silent',async t=>{
  const f=await audioFixture(t,{reply:'A'.repeat(1200)+'B'.repeat(80)});
  assert.equal(f.played.length,0);assert.equal(f.calls.filter(([url])=>url.endsWith('/speech')).length,0);
  await f.submit();await settle();
  const chunks=f.calls.filter(([url])=>url.endsWith('/speech')).map(([,init])=>JSON.parse(init.body).text);
  assert.deepEqual(chunks,['A'.repeat(1200),'B'.repeat(80)]);assert.equal(f.played.length,2);
  assert.equal(f.w.document.getElementById('stop-speech').hidden,true);
});
test('saved audio off is restored on startup and prevents automatic and manual speech',async t=>{
  const f=await audioFixture(t,{autoSpeak:false});
  assert.equal(f.w.document.getElementById('sound-toggle').textContent,'Ljud av');
  await f.submit();assert.equal(f.calls.some(([url])=>url.endsWith('/speech')),false);
  assert.equal(f.w.document.querySelector('#messages .listen-button').disabled,true);
});
test('mute cancels pending speech, persists the choice, and late audio never plays',async t=>{
  const f=await audioFixture(t,{delaySpeech:true});await f.submit();
  const speech=f.calls.find(([url])=>url.endsWith('/speech'));
  f.w.document.getElementById('sound-toggle').click();await settle();
  assert.equal(speech[1].signal.aborted,true);assert.equal(f.preferences().autoSpeak,false);
  f.releaseSpeech();await settle();assert.equal(f.played.length,0);
  assert.equal(f.w.document.getElementById('stop-speech').hidden,true);
});
test('Stop preserves saved audio on and the next new reply speaks again',async t=>{
  const f=await audioFixture(t,{delaySpeech:true});await f.submit();
  f.w.document.getElementById('stop-speech').click();
  assert.equal(f.w.document.querySelector('#messages .listen-button').disabled,false);
  f.releaseSpeech();await settle();
  assert.equal(f.preferences().autoSpeak,true);assert.equal(f.calls.some(([url,init])=>url.endsWith('/preferences')&&init.method==='PUT'),false);
  await f.submit();f.releaseSpeech();await settle();assert.equal(f.played.length,1);
});
test('a mute change while chat is pending prevents automatic speech of the arriving reply',async t=>{
  const f=await audioFixture(t,{delayChat:true});await f.submit();
  f.w.document.getElementById('sound-toggle').click();await settle();f.releaseChat();await settle();
  assert.equal(f.calls.some(([url])=>url.endsWith('/speech')),false);assert.equal(f.played.length,0);
});
test('a blocked browser playback exposes manual retry and does not claim successful speech',async t=>{
  const f=await audioFixture(t,{blockAudio:true});await f.submit();await settle();
  assert.match(f.w.document.getElementById('status').textContent,/Webbläsaren blockerade automatljud/);
  assert.equal(f.w.document.querySelector('#messages .listen-button').disabled,false);
  assert.equal(f.w.document.getElementById('stop-speech').hidden,true);assert.equal(f.played.length,0);
});
test('failed mute save keeps this client silent for the next reply',async t=>{
  const f=await audioFixture(t,{failSave:true});f.w.document.getElementById('sound-toggle').click();await settle();
  await f.submit();assert.equal(f.calls.some(([url])=>url.endsWith('/speech')),false);
});
test('a mute saved by the other client stops current playback on the next preference poll',async t=>{
  const f=await audioFixture(t,{capturePoll:true,holdAudio:true});await f.submit();
  assert.equal(f.played.length,1);assert.equal(f.w.document.getElementById('stop-speech').hidden,false);
  await f.w.fetch('/api/sir-david/preferences',{method:'PUT',body:JSON.stringify({autoSpeak:false,version:0})});
  let visibility='hidden';Object.defineProperty(f.w.document,'visibilityState',{get:()=>visibility});
  f.poll();await settle();
  assert.equal(f.w.document.getElementById('sound-toggle').textContent,'Ljud av');
  assert.equal(f.w.document.getElementById('stop-speech').hidden,true);
  assert.equal(f.pauses.some(src=>src.startsWith('blob:')),true);
  assert.equal(f.w.document.getElementById('status').textContent,'Ljudet är avstängt i din andra vy.');
});

test('hidden idle clients do not poll; returning to the page refreshes saved audio',async t=>{
  const f=await audioFixture(t,{capturePoll:true});
  let visibility='hidden';Object.defineProperty(f.w.document,'visibilityState',{get:()=>visibility});
  const before=f.calls.length;f.poll();await settle();assert.equal(f.calls.length,before);
  visibility='visible';f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));await settle();
  assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1)[0],'/api/sir-david/preferences');
});
test('private companion restores server conversation, uses text rendering and never browser storage', async () => {
  const dom = new JSDOM(html, { url: 'https://www.sp1e.se/admin/?panel=sir-david', runScripts: 'outside-only' });
  const w = dom.window, calls = [];
  Object.defineProperty(w, 'localStorage', { get() { throw Error('No local history'); } });
  Object.defineProperty(w, 'sessionStorage', { get() { throw Error('No local history'); } });
  w.confirm = () => true;
  let conversation = { version: 3, messages: [{ role: 'assistant', content: '<img src=x onerror=alert(1)>' }] };
  w.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    let data;
    if (url.endsWith('/profile')) data = { profile: { displayName: 'Sir David Blackenfeather' }, preferences:{autoSpeak:true,version:0}, models: ['gemma4:31b'], chatConnected: true, speechConnected: false };
    else if (url.endsWith('/preferences')) data = {preferences:{autoSpeak:true,version:0}};
    else if (url.endsWith('/memories')) data = { memories: [{ id: 'note', content: '<script>bad()</script>' }] };
    else if (url.endsWith('/conversation')) { if (options.method === 'DELETE') conversation = { version: 5, messages: [] }; data = { conversation }; }
    else if (url.endsWith('/chat')) {
      assert.deepEqual(JSON.parse(options.body), { model: 'gemma4:31b', text: 'Hello', version: 3 });
      conversation = { version: 4, messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Good evening.' }] }; data = { text: 'Good evening.', conversation };
    } else throw Error('Unexpected provider request');
    return { ok: true, json: async () => data };
  };
  w.eval(script); await settle();
  assert.equal(w.document.querySelector('#messages img'), null);
  assert.match(w.document.getElementById('messages').textContent, /<img/);
  assert.equal(w.document.querySelector('#memories script'), null);
  assert.equal(calls.some(([url]) => /chat|speech/.test(url)), false);
  w.document.getElementById('prompt').value = 'Hello';
  w.document.getElementById('chat-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.equal(w.document.getElementById('send').disabled, true);
  await settle(); assert.match(w.document.getElementById('messages').textContent, /Good evening/);
  w.document.getElementById('new-chat').click(); await settle();
  assert.equal(w.document.getElementById('messages').children.length, 0);
  assert.equal(JSON.parse(calls.find(([url, options]) => url.endsWith('/conversation') && options.method === 'DELETE')[1].body).version, 4);
  assert.equal(calls.every(([url]) => url.startsWith('/api/sir-david/')), true);
  dom.window.close();
});
test('unavailable server keeps send and memory disabled without contacting providers', async () => {
  const dom = new JSDOM(html, { url: 'https://www.sp1e.se/admin/?panel=sir-david', runScripts: 'outside-only' });
  const calls = [];
  dom.window.fetch = async url => { calls.push(url); return { ok: false, status: 401, json: async () => ({ error: 'Logga in först.' }) }; };
  dom.window.eval(script); await settle();
  assert.equal(dom.window.document.getElementById('send').disabled, true);
  assert.equal(dom.window.document.getElementById('save-memory').disabled, true);
  assert.deepEqual(calls, ['/api/sir-david/profile']);
  assert.match(dom.window.document.getElementById('connection').textContent, /Logga in/);
  dom.window.close();
});

for (const action of ['stop', 'pagehide', 'clear', 'lost-auth', 'close']) test('late speech cannot play after ' + action, async () => {
  const dom = new JSDOM(html, { url: 'https://www.sp1e.se/admin/?panel=sir-david', runScripts: 'outside-only' });
  const w = dom.window; let release, signal, created = 0, denied = false;
  w.confirm = () => true;
  w.Audio = function () { return { src:'', pause() {}, async play() { if (this.src.startsWith('blob:')) created++; }, addEventListener() {}, removeEventListener() {} }; };
  w.URL.createObjectURL = () => 'blob:fixture'; w.URL.revokeObjectURL = () => {};
  w.fetch = async (url, options = {}) => {
    if (url.endsWith('/speech')) { signal = options.signal; return new Promise(resolve => { release = resolve; }); }
    if (denied) return { ok:false,status:401,json:async()=>({error:'Logga in först.'}) };
    const data = url.endsWith('/profile') ? {profile:{displayName:'Sir David'},preferences:{autoSpeak:true,version:0},models:['gemma4:31b'],chatConnected:true,speechConnected:true}
      : url.endsWith('/preferences') ? {preferences:{autoSpeak:true,version:0}}
      : url.endsWith('/conversation') ? {conversation:{version:0,messages:options.method==='DELETE'?[]:[{role:'assistant',content:'Good evening.'}]}} : {memories:[]};
    return { ok:true,json:async()=>data };
  };
  w.eval(script); await settle();
  w.document.querySelector('#messages button').click(); await settle();
  assert.equal(w.document.getElementById('stop-speech').hidden,false);
  if (action === 'stop') w.document.getElementById('stop-speech').click();
  else if (action === 'pagehide') w.dispatchEvent(new w.Event('pagehide'));
  else if (action === 'clear') w.document.getElementById('new-chat').click();
  else if (action === 'close') w.document.getElementById('close-sir-david').click();
  else { denied = true; w.document.getElementById('reload-chat').click(); }
  await settle(); assert.equal(signal.aborted,true);
  release({ok:true,blob:async()=>({})}); await settle();
  assert.equal(created,0); assert.equal(w.document.getElementById('stop-speech').hidden,true);
  dom.window.close();
});

function readyServer(w, calls) {
  w.fetch = async (url,options={}) => {
    calls.push([url,options]);
    const data=url.endsWith('/profile') ? {profile:{displayName:'Sir David'},preferences:{autoSpeak:true,version:0},models:['gemma4:31b'],chatConnected:true,speechConnected:false}
      : url.endsWith('/preferences') ? {preferences:{autoSpeak:true,version:0}}
      : url.endsWith('/conversation') ? {conversation:{version:0,messages:[]}} : {memories:[]};
    return {ok:true,json:async()=>data};
  };
}

test('default launcher makes zero API calls until clicked and preserves unrelated URL state on close',async()=>{
  const dom=new JSDOM(html,{url:'https://www.sp1e.se/admin/?theme=quiet#memory',runScripts:'outside-only'});
  const w=dom.window,calls=[];readyServer(w,calls);w.eval(script);await settle();
  const $=id=>w.document.getElementById(id);
  assert.deepEqual(calls,[]);assert.equal($('sir-david-panel').hidden,true);assert.equal($('admin-launcher').hidden,false);
  assert.equal($('open-sir-david').getAttribute('aria-expanded'),'false');
  $('open-sir-david').click();await settle();
  assert.equal($('sir-david-panel').hidden,false);assert.equal($('admin-launcher').hidden,true);
  assert.equal($('open-sir-david').getAttribute('aria-expanded'),'true');assert.equal(w.document.activeElement,$('close-sir-david'));
  assert.deepEqual(calls.map(([url])=>url),['/api/sir-david/profile','/api/sir-david/memories','/api/sir-david/conversation']);
  assert.equal(new w.URL(w.location.href).searchParams.get('panel'),'sir-david');
  $('close-sir-david').click();
  assert.equal($('sir-david-panel').hidden,true);assert.equal($('admin-launcher').hidden,false);
  assert.equal($('open-sir-david').getAttribute('aria-expanded'),'false');assert.equal(w.document.activeElement,$('open-sir-david'));
  assert.equal(w.location.search,'?theme=quiet');assert.equal(w.location.hash,'#memory');
  $('open-sir-david').click();await settle();assert.equal(calls.length,3,'Successful initialisation is not repeated');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal($('sir-david-panel').hidden,true);assert.equal(w.document.activeElement,$('open-sir-david'));
  dom.window.close();
});

test('only an exact panel=sir-david query opens the companion',async()=>{
  for(const query of ['?sir-david','?panel=other','?panel=sir-david-extra','?panel=Sir-David','?text=panel%3Dsir-david']) {
    const dom=new JSDOM(html,{url:'https://www.sp1e.se/admin/'+query,runScripts:'outside-only'}),calls=[];
    readyServer(dom.window,calls);dom.window.eval(script);await settle();
    assert.equal(dom.window.document.getElementById('sir-david-panel').hidden,true,query);assert.equal(calls.length,0,query);
    dom.window.close();
  }
});

test('close aborts pending chat and rejects a late answer while retaining the prompt draft',async()=>{
  const dom=new JSDOM(html,{url:'https://www.sp1e.se/admin/?panel=sir-david&theme=quiet',runScripts:'outside-only'}),w=dom.window,calls=[];
  readyServer(w,calls);const read=w.fetch;let release,signal;
  w.fetch=async(url,options={})=>{
    if(url.endsWith('/chat')) {signal=options.signal;return new Promise(resolve=>{release=resolve;});}
    return read(url,options);
  };
  w.eval(script);await settle();
  const $=id=>w.document.getElementById(id);$('prompt').value='Keep this draft';
  $('chat-form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
  assert.equal($('send').disabled,true);$('close-sir-david').click();assert.equal(signal.aborted,true);
  release({ok:true,json:async()=>({text:'Late private answer',conversation:{version:1,messages:[{role:'assistant',content:'Late private answer'}]}})});
  await settle();assert.equal($('messages').children.length,0);assert.equal($('prompt').value,'Keep this draft');
  assert.equal($('sir-david-panel').hidden,true);assert.equal(w.document.activeElement,$('open-sir-david'));
  dom.window.close();
});

test('reopening after a temporary profile failure retries initialisation successfully',async()=>{
  const dom=new JSDOM(html,{url:'https://www.sp1e.se/admin/',runScripts:'outside-only'}),w=dom.window,calls=[];
  readyServer(w,calls);const available=w.fetch;let attempts=0;
  w.fetch=async(url,options={})=>{
    if(url.endsWith('/profile') && ++attempts===1) {
      calls.push([url,options]);return {ok:false,status:503,json:async()=>({error:'Tillfälligt otillgänglig.'})};
    }
    return available(url,options);
  };
  w.eval(script);const $=id=>w.document.getElementById(id);
  $('open-sir-david').click();await settle();
  assert.equal($('send').disabled,true);assert.match($('connection').textContent,/Tillfälligt/);
  $('close-sir-david').click();$('open-sir-david').click();await settle();
  assert.equal(attempts,2);assert.equal($('send').disabled,false);assert.equal($('save-memory').disabled,false);
  assert.equal($('model').options.length,1);assert.match($('connection').textContent,/anslutet/);
  assert.deepEqual(calls.map(([url])=>url),['/api/sir-david/profile','/api/sir-david/profile','/api/sir-david/memories','/api/sir-david/conversation']);
  dom.window.close();
});
