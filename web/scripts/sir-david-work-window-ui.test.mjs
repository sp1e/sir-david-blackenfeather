import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
async function fixture(t,{theme='light',delayed=false}={}){
 const dom=new JSDOM(fs.readFileSync('admin/index.html','utf8'),{url:'https://sp1e.test/admin/',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window,$=id=>w.document.getElementById(id);w.structuredClone=structuredClone;w.matchMedia=()=>({matches:theme==='dark',addEventListener(){}});w.localStorage.setItem('sir-david-theme',theme);w.setInterval=()=>1;w.clearInterval=()=>{};
 let authorized=true,release,proposals=0;const requests=[];
 const snapshot={version:1,document:{projects:[{id:'project',title:'<img src=x>',nextAction:'Write draft',status:'active',notes:'',priority:'high',deadline:null}],events:[],settings:{reminders:false,desktopNotifications:false,speakWhenOpen:false,timezone:'Europe/Stockholm',quietStart:22,quietEnd:8}},focus:['project'],outlookEvents:[],reminders:[]};
 const api=async route=>({json:async()=>route==='planner'?{planner:structuredClone(snapshot)}:route==='planner/work-windows'?{settings:{durationMinutes:60,windowStart:'10:00',windowEnd:'16:00',bufferMinutes:5}}:{outlook:{configured:false}}});
 const post=async(route,data)=>{requests.push({route,data});if(route==='planner/work-windows'){proposals++;if(delayed)await new Promise(resolve=>{release=resolve;});return {json:async()=>({basis:'a'.repeat(64),slots:[{start:'10:00',end:'10:45'}],message:'Förslag · ingen bokning'})};}return {json:async()=>({saved:data.decision==='accept',message:'Sparad privat kalenderhändelse'})};};
 w.eval(fs.readFileSync('admin/sir-david-planner.js','utf8'));const planner=w.SirDavidPlanner.create({api,post,authorized:()=>authorized,speechEnabled:()=>false,canSpeak:()=>false,speak:()=>{throw Error('No model or TTS');}});await planner.init();$('work-window-panel').open=true;await settle();
 const submit=()=>{$('work-window-form').dispatchEvent(new w.Event('submit',{cancelable:true}));};
 return {w,$,requests,submit,release:()=>release?.(),revoke:()=>{authorized=false;planner.clear();},proposals:()=>proposals};
}
for(const theme of ['light','dark'])test(theme+' UI loads preferences, keeps text safe and only accepts on explicit click',async t=>{
 const f=await fixture(t,{theme});assert.equal(f.w.document.documentElement.dataset.theme,theme);assert.equal(f.$('work-duration').value,'60');assert.equal(f.$('work-project').querySelector('img'),null);
 f.$('work-duration').value='45';f.submit();await settle();assert.equal(f.requests.length,1);assert.equal(f.requests[0].route,'planner/work-windows');
 f.$('work-window-results').querySelector('button').click();f.$('work-choice-start').value='11:00';f.$('work-choice-end').value='11:45';f.$('work-window-accept').click();await settle();
 assert.equal(f.requests[1].data.start,'11:00');assert.equal(f.requests[1].data.decision,'accept');assert.equal(f.$('work-window-choice').hidden,true);assert.equal(f.$('work-window-results').textContent,'');
 assert.equal(f.w.document.activeElement,f.$('work-window-form').querySelector('button'));
});
test('duplicate pending proposals and a response after logout cannot restore project data',async t=>{
 const f=await fixture(t,{delayed:true});f.submit();f.submit();assert.equal(f.proposals(),1);assert.equal(f.$('work-project').disabled,true);f.revoke();f.release();await settle();
 assert.equal(f.$('work-window-status').textContent,'');assert.equal(f.$('work-window-results').textContent,'');assert.equal(f.$('work-project').textContent,'');
});
test('editing proposal input invalidates its pending acceptance',async t=>{
 const f=await fixture(t);f.submit();await settle();f.$('work-window-results').querySelector('button').click();
 f.$('work-duration').value='90';f.$('work-duration').dispatchEvent(new f.w.Event('input',{bubbles:true}));f.$('work-window-accept').click();await settle();
 assert.equal(f.requests.length,1);assert.equal(f.$('work-window-choice').hidden,true);
});
