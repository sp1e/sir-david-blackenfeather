import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync('admin/index.html','utf8'),script=fs.readFileSync('admin/sir-david-planner.js','utf8');
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
async function fixture(t,{native=false,visible=true,sound=true,due=true,theme='system',systemDark=false}={}) {
  const dom=new JSDOM(html,{url:'https://sp1e.se/admin/?panel=sir-david',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,$=id=>w.document.getElementById(id);
  Object.defineProperty(w.document,'visibilityState',{get:()=>visible?'visible':'hidden'});w.structuredClone=structuredClone;w.matchMedia=()=>({matches:systemDark,addEventListener(){}});w.localStorage.setItem('sir-david-theme',theme);
  let authorized=true,timer,claim=0,clockBusy=false,pendingGet=null,failSave=false,snoozeError=null,snoozeGate=null,claimGate=null,staleGetGate=null;const calls=[],spoken=[],messages=[];
  const project={id:'11111111-1111-4111-8111-111111111111',title:'<img src=x onerror=alert(1)>',notes:'',nextAction:'Skriv utkast',deadline:new Date(Date.now()+3600000).toISOString(),priority:'high',status:'active'};
  const reminder={key:'a'.repeat(64),seriesKey:'b'.repeat(64),title:project.title,message:'Deadline inom två timmar. Skriv utkast.',at:project.deadline,kind:'project',itemId:project.id};
  let snapshot={version:0,document:{projects:[project],events:[],settings:{reminders:true,desktopNotifications:true,speakWhenOpen:true,timezone:'Europe/Stockholm',quietStart:0,quietEnd:0}},focus:[project.id],outlookEvents:[],reminders:due?[reminder]:[],serverTime:new Date().toISOString(),quiet:false};
  let nativeMessages;if(native){nativeMessages=new w.EventTarget();nativeMessages.postMessage=data=>messages.push(data);Object.defineProperty(w,'chrome',{value:{webview:nativeMessages}});}
  w.setInterval=fn=>{timer=fn;return 1;};w.clearInterval=()=>{};
  async function api(route,options={}){calls.push([route,options]);if(route==='planner'){if(options.method==='PUT'){if(failSave)throw Error('Planeringen ändrades i en annan vy.');const data=JSON.parse(options.body);assert.equal(data.version,snapshot.version);snapshot={...snapshot,version:snapshot.version+1,document:data.document};}if(staleGetGate){const gate=staleGetGate,captured=structuredClone(snapshot);staleGetGate=null;return{json:async()=>{await gate.promise;return{planner:captured};}};}if(pendingGet)return new Promise(resolve=>{pendingGet=()=>resolve({json:async()=>({planner:structuredClone(snapshot)})});});return{json:async()=>({planner:structuredClone(snapshot)})};}if(route==='outlook/status')return{json:async()=>({outlook:{configured:false,connected:false,lastSync:null}})};throw Error('Unexpected route '+route);}
  async function post(route,data){calls.push([route,data]);if(route==='planner/claim'){claim++;const claimed=structuredClone(snapshot.reminders.find(r=>r.key===data.key)??reminder),gate=claimGate;return{json:async()=>{if(gate)await gate.promise;return{claimId:'11111111-1111-4111-8111-111111111111',reminder:claimed};}};}if(route==='planner/ack'){snapshot.reminders=[];return{json:async()=>({acknowledged:true})};}if(route==='planner/snooze'){if(snoozeGate)await snoozeGate.promise;if(snoozeError)throw snoozeError;snapshot.reminders=[];return{json:async()=>({snoozed:true})};}throw Error('Unexpected route '+route);}
  $('sir-david-panel').hidden=false;w.eval(script);const planner=w.SirDavidPlanner.create({api,post,authorized:()=>authorized,speechEnabled:()=>sound,canSpeak:()=>!clockBusy,speak:async value=>{spoken.push(value);}});
  if(native){const event=new w.MessageEvent('message',{data:{type:'sir-david-native-tick',visible}});nativeMessages.dispatchEvent(event);}
  await planner.init();await settle();
  let releaseStaleGet;
  return{w,$,planner,calls,spoken,messages,claim:()=>claim,async tick(){timer();await settle();},async nativeTick(value){nativeMessages.dispatchEvent(new w.MessageEvent('message',{data:{type:'sir-david-native-tick',visible:value}}));await settle();},ack(accepted=true){nativeMessages.dispatchEvent(new w.MessageEvent('message',{data:{type:'sir-david-reminder-result',claimId:'11111111-1111-4111-8111-111111111111',accepted}}));},revoke(){authorized=false;planner.clear();},busy(value){clockBusy=value;},delayGet(){pendingGet=true;},releaseGet(){const release=pendingGet;pendingGet=null;release();},delayClaim(){let release,reject;const promise=new Promise((resolve,fail)=>{release=resolve;reject=fail;});claimGate={promise,release,reject};},releaseClaim(){claimGate.release();claimGate=null;},rejectClaim(error){claimGate.reject(error);claimGate=null;},delayStaleGet(){staleGetGate={promise:new Promise(resolve=>{releaseStaleGet=resolve;})};},releaseStaleGet(){releaseStaleGet();},failSave(){failSave=true;},failSnooze(){snoozeError=Error('Påminnelsen kunde inte skjutas upp.');},delaySnooze(){let release;const promise=new Promise(resolve=>{release=resolve;});snoozeGate={promise,release};},releaseSnooze(){snoozeGate.release();snoozeGate=null;},snapshot:()=>snapshot};
}
test('visible web view announces once and uses text nodes for private project data',async t=>{const f=await fixture(t);assert.equal(f.spoken.length,1);assert.equal(f.claim(),1);assert.equal(f.$('planner-focus').querySelectorAll('img').length,0);assert.match(f.$('planner-focus').textContent,/<img src/);await f.tick();assert.equal(f.claim(),1);});
test('hidden native view sends a generic Windows notice, stays silent and acknowledges native acceptance only',async t=>{const f=await fixture(t,{native:true,visible:false});assert.equal(f.spoken.length,0);const notice=f.messages.find(m=>m.type==='sir-david-reminder');assert.ok(notice);assert.ok(!notice.body.includes('utkast'));assert.equal(f.calls.some(([r])=>r==='planner/ack'),false);f.ack();await settle();assert.equal(f.calls.filter(([r])=>r==='planner/ack').length,1);});
test('hidden browser does not consume reminders or speech; muted visible native still notifies',async t=>{const f=await fixture(t,{visible:false});assert.equal(f.claim(),0);assert.equal(f.spoken.length,0);const muted=await fixture(t,{native:true,sound:false});assert.equal(muted.claim(),1);assert.equal(muted.spoken.length,0);assert.ok(muted.messages.some(m=>m.type==='sir-david-reminder'));});
test('busy speech defers reminder without losing it',async t=>{const f=await fixture(t,{due:false});f.snapshot().reminders=[{key:'a'.repeat(64),message:'Reminder',title:'Test'}];f.busy(true);await f.tick();assert.equal(f.claim(),0);f.busy(false);await f.tick();assert.equal(f.claim(),1);});
test('authentication loss removes private planner and late native receipts cannot acknowledge',async t=>{const f=await fixture(t,{native:true,visible:false});f.revoke();f.ack();await settle();assert.equal(f.$('planner-panel').hidden,true);assert.equal(f.$('planner-focus').textContent,'');assert.equal(f.$('project-title').value,'');assert.equal(f.calls.some(([r])=>r==='planner/ack'),false);});
test('late poll after authentication loss cannot restore private data',async t=>{const f=await fixture(t,{due:false});f.delayGet();const work=f.tick();await settle();f.revoke();f.releaseGet();await work;assert.equal(f.$('planner-panel').hidden,true);assert.equal(f.$('planner-projects').textContent,'');});
test('project form creates durable next step and a failed save preserves the draft',async t=>{const f=await fixture(t,{due:false});f.$('project-title').value='New project';f.$('project-next').value='Prepare a draft';f.$('project-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();assert.ok(f.snapshot().document.projects.some(p=>p.title==='New project'&&p.nextAction==='Prepare a draft'));f.failSave();f.$('project-title').value='Keep draft';f.$('project-form').dispatchEvent(new f.w.Event('submit',{cancelable:true}));await settle();assert.equal(f.$('project-title').value,'Keep draft');assert.match(f.$('planner-status').textContent,/Dina fält finns kvar/);});
const alertText=f=>f.$('planner-alerts').textContent;
const snoozeButton=(f,label)=>[...f.$('planner-alerts').querySelectorAll('button')].find(b=>b.textContent===label);

for(const [minutes,label] of [[15,'Påminn om 15 minuter'],[60,'Påminn om en timme'],[1440,'Påminn om 24 timmar']])
  for(const native of [false,true])
    test(`${native?'native':'web'} reminder snoozes for ${minutes} minutes and removes the delivered message`,async t=>{
      const f=await fixture(t,{native});if(native){f.ack();await settle();}
      const button=snoozeButton(f,label);assert.ok(button);button.focus();assert.equal(f.w.document.activeElement,button);button.click();await settle();
      assert.deepEqual(f.calls.filter(([r])=>r==='planner/snooze').map(([,data])=>({key:data.key,minutes:data.minutes})),[{key:'a'.repeat(64),minutes}]);
      assert.equal(alertText(f),'');assert.match(f.$('planner-status').textContent,/Valet delas med din andra vy/);await f.tick();assert.equal(alertText(f),'');
    });

test('a reminder awaiting speech can be snoozed without claiming or announcing it',async t=>{
  const f=await fixture(t,{due:false});const p=f.snapshot().document.projects[0];
  f.snapshot().reminders=[{key:'a'.repeat(64),seriesKey:'b'.repeat(64),message:'Deadline inom två timmar.',kind:'project',itemId:p.id,at:p.deadline}];
  f.busy(true);await f.tick();assert.equal(f.claim(),0);snoozeButton(f,'Påminn om 15 minuter').click();await settle();
  assert.equal(alertText(f),'');assert.equal(f.claim(),0);assert.equal(f.spoken.length,0);
});

test('a pending snooze disables choices and prevents duplicate requests across polls',async t=>{
  const f=await fixture(t);f.delaySnooze();const button=snoozeButton(f,'Påminn om en timme');button.click();button.click();
  assert.ok([...f.$('planner-alerts').querySelectorAll('button')].every(b=>b.disabled));await f.tick();
  assert.equal(f.calls.filter(([r])=>r==='planner/snooze').length,1);assert.equal(f.claim(),1);f.releaseSnooze();await settle();assert.equal(alertText(f),'');
});

test('a poll already in flight cannot announce a reminder while snooze is saving',async t=>{
  const f=await fixture(t);f.delayGet();const poll=f.tick();await settle();f.delaySnooze();snoozeButton(f,'Påminn om en timme').click();
  const p=f.snapshot().document.projects[0];f.snapshot().reminders=[{key:'a'.repeat(64),seriesKey:'b'.repeat(64),message:'Deadline inom två timmar.',kind:'project',itemId:p.id,at:p.deadline}];
  f.releaseGet();await poll;assert.equal(f.claim(),1);assert.equal(f.spoken.length,1);f.releaseSnooze();await settle();assert.equal(alertText(f),'');
});

for(const native of [false,true])test(`${native?'native':'web'} late claim after completed snooze cannot restore or deliver the reminder`,async t=>{
  const f=await fixture(t,{native,due:false}),project=f.snapshot().document.projects[0];
  f.snapshot().reminders=[{key:'a'.repeat(64),seriesKey:'b'.repeat(64),message:'Deadline inom två timmar.',kind:'project',itemId:project.id,at:project.deadline}];
  f.delayClaim();if(native)await f.nativeTick(true);else await f.tick();assert.equal(f.claim(),1);
  snoozeButton(f,'Påminn om en timme').click();await settle();assert.equal(alertText(f),'');
  assert.equal(f.calls.filter(([route])=>route==='planner/snooze').length,1);
  f.releaseClaim();await settle();
  assert.equal(alertText(f),'');assert.equal(f.spoken.length,0);
  assert.equal(f.messages.filter(message=>message.type==='sir-david-reminder').length,0);
  assert.equal(f.calls.filter(([route])=>route==='planner/ack').length,0);
});

test('late stale planner observation after completed snooze cannot restore the reminder',async t=>{
  const f=await fixture(t,{due:false}),project=f.snapshot().document.projects[0];
  f.snapshot().reminders=[{key:'a'.repeat(64),seriesKey:'b'.repeat(64),message:'Deadline inom två timmar.',kind:'project',itemId:project.id,at:project.deadline}];
  f.busy(true);await f.tick();assert.match(alertText(f),/Deadline inom två timmar/);
  f.delayStaleGet();await f.tick();
  snoozeButton(f,'Påminn om 15 minuter').click();await settle();assert.equal(alertText(f),'');assert.equal(f.snapshot().reminders.length,0);
  f.releaseStaleGet();await settle();
  assert.equal(alertText(f),'');assert.equal(f.claim(),0);assert.equal(f.spoken.length,0);
});

test('late failed claim after completed snooze cannot replace its success status',async t=>{
  const f=await fixture(t,{due:false}),project=f.snapshot().document.projects[0];
  f.snapshot().reminders=[{key:'a'.repeat(64),seriesKey:'b'.repeat(64),message:'Deadline inom två timmar.',kind:'project',itemId:project.id,at:project.deadline}];
  f.delayClaim();await f.tick();assert.equal(f.claim(),1);
  snoozeButton(f,'Påminn om en timme').click();await settle();
  const success=f.$('planner-status').textContent;assert.match(success,/Påminnelsen är uppskjuten/);
  f.rejectClaim(Error('Det gamla anropets nätverksfel.'));await settle();
  assert.equal(f.$('planner-status').textContent,success);assert.equal(alertText(f),'');
  assert.equal(f.spoken.length,0);assert.equal(f.calls.filter(([route])=>route==='planner/ack').length,0);
});

test('a failed snooze keeps the reminder and re-enables every choice',async t=>{
  const f=await fixture(t);f.failSnooze();snoozeButton(f,'Påminn om 24 timmar').click();await settle();
  assert.match(alertText(f),/Deadline inom två timmar/);assert.equal(f.$('planner-alerts').querySelectorAll('button').length,3);
  assert.ok([...f.$('planner-alerts').querySelectorAll('button')].every(b=>!b.disabled));assert.match(f.$('planner-status').textContent,/kunde inte skjutas upp/);
});

test('a late snooze response after authentication loss cannot restore planner or status',async t=>{
  const f=await fixture(t);f.delaySnooze();snoozeButton(f,'Påminn om 15 minuter').click();f.revoke();f.releaseSnooze();await settle();
  assert.equal(f.$('planner-panel').hidden,true);assert.equal(alertText(f),'');assert.equal(f.$('planner-status').textContent,'');
});

test('a stale detached snooze button cannot postpone a completed project',async t=>{
  const f=await fixture(t);const button=snoozeButton(f,'Påminn om 15 minuter');f.snapshot().document.projects[0].status='done';await f.tick();button.click();await settle();
  assert.equal(f.calls.filter(([r])=>r==='planner/snooze').length,0);assert.equal(alertText(f),'');
});
test('delivered reminder stays visible with snooze while its project is still due',async t=>{const f=await fixture(t);assert.equal(f.snapshot().reminders.length,0);assert.match(alertText(f),/Deadline inom två timmar/);assert.ok([...f.$('planner-alerts').querySelectorAll('button')].some(b=>b.textContent==='Påminn om en timme'));await f.tick();assert.match(alertText(f),/Deadline inom två timmar/);});
test('marking the project done removes the delivered reminder',async t=>{const f=await fixture(t);const done=[...f.$('planner-projects').querySelectorAll('button')].find(b=>b.textContent==='Markera klart');done.click();await settle();assert.equal(f.snapshot().document.projects[0].status,'done');assert.equal(alertText(f),'');await f.tick();assert.equal(alertText(f),'');});
for(const [name,change] of [['paused',p=>{p.status='paused';}],['removed',null],['given a new deadline',p=>{p.deadline=new Date(Date.parse(p.deadline)+86400000).toISOString();}]])
  test(`a project ${name} in another view drops the delivered reminder on the next poll`,async t=>{const f=await fixture(t);const doc=f.snapshot().document;if(change)change(doc.projects[0]);else doc.projects=[];await f.tick();assert.equal(alertText(f),'');});
test('turning reminders off drops the delivered reminder',async t=>{const f=await fixture(t);f.snapshot().document.settings.reminders=false;await f.tick();assert.equal(alertText(f),'');});
test('delivered meeting reminder follows the event and expires five minutes after start',async t=>{const f=await fixture(t,{due:false});const start=new Date(Date.now()+10*60000).toISOString(),event={id:'22222222-2222-4222-8222-222222222222',title:'Möte',start,end:new Date(Date.now()+70*60000).toISOString(),allDay:false,source:'manual'};const s=f.snapshot();s.document.events=[event];s.reminders=[{key:'c'.repeat(64),seriesKey:'d'.repeat(64),title:'Möte',message:'Börjar inom 30 minuter: Möte.',at:start,kind:'event',itemId:event.id}];await f.tick();assert.equal(f.snapshot().reminders.length,0);assert.match(alertText(f),/Börjar inom 30 minuter/);const realNow=Date.now();f.w.Date.now=()=>realNow+16*60000;await f.tick();assert.equal(alertText(f),'');});
test('a delivered meeting reminder disappears when the meeting is moved',async t=>{const f=await fixture(t,{due:false});const start=new Date(Date.now()+10*60000).toISOString(),event={id:'22222222-2222-4222-8222-222222222222',title:'Möte',start,end:new Date(Date.now()+70*60000).toISOString(),allDay:false,source:'manual'};const s=f.snapshot();s.document.events=[event];s.reminders=[{key:'c'.repeat(64),seriesKey:'d'.repeat(64),title:'Möte',message:'Börjar inom 30 minuter: Möte.',at:start,kind:'event',itemId:event.id}];await f.tick();assert.match(alertText(f),/Börjar inom 30 minuter/);event.start=new Date(Date.now()+20*60000).toISOString();await f.tick();assert.equal(alertText(f),'');});
test('light and dark explicit choice is visible, persisted and overrides system preference',async t=>{for(const theme of ['light','dark']){const f=await fixture(t,{due:false,theme,systemDark:theme==='light'});assert.equal(f.w.document.documentElement.dataset.theme,theme);f.$('theme-choice').focus();assert.equal(f.w.document.activeElement,f.$('theme-choice'));f.$('theme-choice').value=theme==='light'?'dark':'light';f.$('theme-choice').dispatchEvent(new f.w.Event('change'));assert.equal(f.w.localStorage.getItem('sir-david-theme'),f.$('theme-choice').value);assert.equal(f.w.document.documentElement.dataset.theme,f.$('theme-choice').value);}});
test('system preference is used initially without storing project or calendar data in browser storage',async t=>{const f=await fixture(t,{due:false,systemDark:true});assert.equal(f.w.document.documentElement.dataset.theme,'dark');assert.equal(f.w.localStorage.length,1);assert.equal(f.w.localStorage.key(0),'sir-david-theme');});
