import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeAdapter,localRequest} from './claude-adapter.mjs';
const NOW=1_000_000;
const prepared=()=>({turn:{id:'11111111-1111-4111-8111-111111111111',version:2,expiresAt:NOW+120000},context:{persona:'British gentleman with dry humour.',text:'Hello',messages:[{role:'user',content:'Past question'},{role:'assistant',content:'Past answer'}],memories:['A saved note']}});
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture(route) {
  const events=new EventTarget(),calls=[],popup={closed:false,close(){this.closed=true;}};
  const adapter=new ClaudeAdapter({origin:'https://www.sp1e.se',events,now:()=>NOW,sleep:async()=>{},openPopup:(...args)=>{calls.push({popup:args});return popup;},
    fetchImpl:async(url,options)=>{calls.push({url,options});return route(url,options);}});
  function message(origin='http://127.0.0.1:4318',source=popup) { const event=new Event('message'); Object.assign(event,{origin,source,data:{type:'sp1e-local-paired',token:'t'.repeat(43)}}); events.dispatchEvent(event); }
  async function pair(){const pending=adapter.pair();message();await pending;}
  return {adapter,calls,popup,message,pair};
}
test('bounded input fixes Claude chat and preserves shared persona/history/notes',()=>{
  const request=localRequest(prepared(),NOW);
  assert.equal(request.provider,'claude');assert.equal(request.kind,'sir-david');
  assert.equal(request.persona,prepared().context.persona);assert.deepEqual(request.notes,prepared().context.memories);
  assert.deepEqual(request.messages,prepared().context.messages);assert.equal(request.current,undefined);
  for(const change of [p=>p.turn.expiresAt=NOW,p=>p.turn.version=-1,p=>p.context.messages[0].role='system',p=>p.context.text='x'.repeat(4001),p=>p.context.memories=['x'.repeat(1001)]]) {const p=prepared();change(p);assert.throws(()=>localRequest(p,NOW));}
});
test('pairing rejects other origins and popup sources; token remains private',async()=>{
  const f=fixture(()=>json({}));const pending=f.adapter.pair();
  f.message('https://evil.example');f.message('http://127.0.0.1:4318',{});assert.equal(f.adapter.connected,false);
  f.message();await pending;assert.equal(f.adapter.connected,true);assert.equal(f.popup.closed,true);
  assert.equal(f.calls[0].popup[0],'http://127.0.0.1:4318/__connect/?origin=https%3A%2F%2Fwww.sp1e.se');
  assert.equal(JSON.stringify(f.adapter).includes('t'.repeat(43)),false);
  assert.throws(()=>new ClaudeAdapter({origin:'https://evil.example'}));
});
test('unverified billing never starts a job or silently selects another provider',async()=>{
  const f=fixture(()=>json({providers:[{id:'claude',installed:true,signedIn:true}]}));await f.pair();
  await assert.rejects(f.adapter.answer(prepared()),/abonnemang/);
  assert.equal(f.calls.filter(c=>c.url?.endsWith('/jobs')).length,0);
});
test('successful local reply returns only commit DTO and uses no browser credentials',async()=>{
  const f=fixture(url=>url.includes('/status?') ? json({providers:[{id:'claude',installed:true,signedIn:true,billingMode:'subscription'}]}) : url.endsWith('/jobs') ? json({id:'job_123456789',state:'running'},202) : json({state:'done',result:{text:'A dry reply.'}}));await f.pair();
  assert.deepEqual(await f.adapter.answer(prepared()),{turnId:prepared().turn.id,version:2,text:'A dry reply.'});
  for(const c of f.calls.filter(c=>c.url)) {assert.equal(c.options.credentials,'omit');assert.equal(c.options.headers['X-Sp1e-Session'],'t'.repeat(43));}
  assert.equal(f.calls.filter(c=>c.url?.endsWith('/jobs')).length,1);
});
test('aborted polling cancels only this job and does not return late text',async()=>{
  const controller=new AbortController();
  const f=fixture(url=>{
    if(url.includes('/status?')) return json({providers:[{id:'claude',installed:true,signedIn:true,billingMode:'subscription'}]});
    if(url.endsWith('/jobs')) return json({id:'job_123456789'});
    if(url.endsWith('/cancel')) return json({cancelled:true});
    controller.abort();return json({state:'done',result:{text:'Late reply'}});
  });await f.pair();await assert.rejects(f.adapter.answer(prepared(),{signal:controller.signal}),{name:'AbortError'});
  assert.equal(f.calls.filter(c=>c.url?.endsWith('/cancel')).length,1);
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),{id:'job_123456789'});
});
test('cancellation during status lookup prevents a new Claude job',async()=>{
  const controller=new AbortController();
  const f=fixture(()=>{controller.abort();return json({providers:[{id:'claude',installed:true,signedIn:true,billingMode:'subscription'}]});});
  await f.pair();await assert.rejects(f.adapter.answer(prepared(),{signal:controller.signal}),{name:'AbortError'});
  assert.equal(f.calls.filter(c=>c.url?.endsWith('/jobs')).length,0);
});
test('disconnect clears pairing and rejects a later use',async()=>{
  const f=fixture(()=>json({disconnected:true}));await f.pair();await f.adapter.disconnect();
  assert.equal(f.adapter.connected,false);await assert.rejects(f.adapter.status(),/Anslut/);
});
test('disconnect closes a pending pairing window and prevents late reconnection',async()=>{
  const f=fixture(()=>json({}));const pending=f.adapter.pair();
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await f.adapter.disconnect();await rejected;f.message();
  assert.equal(f.popup.closed,true);assert.equal(f.adapter.connected,false);
});
test('oversized output is rejected and cancelled before commit',async()=>{
  const f=fixture(url=>url.includes('/status?') ? json({providers:[{id:'claude',installed:true,signedIn:true,billingMode:'subscription'}]}) : url.endsWith('/jobs') ? json({id:'job_123456789'}) : url.endsWith('/cancel') ? json({cancelled:true}) : json({state:'done',result:{text:'x'.repeat(12001)}}));await f.pair();
  await assert.rejects(f.adapter.answer(prepared()),/stort/);assert.equal(f.calls.filter(c=>c.url?.endsWith('/cancel')).length,1);
});
