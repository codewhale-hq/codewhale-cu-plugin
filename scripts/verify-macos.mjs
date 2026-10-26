#!/usr/bin/env node
// Opt-in live verification. Operates only a new, initially empty TextEdit
// document through the plugin's MCP surface. Never part of npm test.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hello } from '../src/app-socket.mjs';
if(process.platform!=='darwin') throw new Error('verify-macos requires macOS');
const showPreview=process.argv.includes('--preview');
const recordVideo=process.argv.includes('--recording');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=spawn(process.execPath,[path.join(root,'mcp/server.mjs')],{stdio:['pipe','pipe','inherit']});
let seq=0, buffer=''; const pending=new Map(); const evidence=[]; const consents=[];
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk=>{buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});
async function rpc(method,params,timeoutMs=65000){
  const id=++seq;
  const response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},timeoutMs);pending.set(id,m=>{clearTimeout(timer);resolve(m);});server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  assert.ok(response.result,JSON.stringify(response.error));
  return response;
}
async function tool(name,args={},setupStage=null){
  const start=Date.now();
  const setup=setupStage?{stage:setupStage,tool:name,startedAt:new Date(start).toISOString(),scope:'connection',persistenceVerified:false}:null;
  if(setup) consents.push(setup);
  let response;
  try { response=await rpc('tools/call',{name,arguments:args},setupStage==='host-approval' || name==='open_application'?130000:65000); }
  catch(error) { if(setup) Object.assign(setup,{finishedAt:new Date().toISOString(),ok:false,error:error.message}); throw error; }
  const data=JSON.parse(response.result.content[0].text);
  const entry={tool:name,ms:Date.now()-start,ok:data.ok,error:data.error,path:data.file??data.path};
  if(setup) Object.assign(setup,entry,{finishedAt:new Date().toISOString(),...(data.host?{host:data.host}:{})});
  else evidence.push(entry);
  if(name==='open_application') fixtureOpenAttempted=data.ok===true || data.action_sent===true || data.outcome_unknown===true;
  assert.equal(data.ok,true,JSON.stringify(data));
  return {data,content:response.result.content};
}
const app_ref={bundle_id:'com.apple.TextEdit'};
async function state(){return (await tool('get_app_state',{app_ref})).data;}
async function foreground(){
  const apps=(await tool('list_apps',{all:true})).data.apps;
  const app=apps.find(app=>app.frontmost===true);
  assert.ok(app,'The frontmost app is identified without reading its controls');
  return app.pid;
}
function fixtureWindow(s){
  const w=s.elements.find(e=>e.role==='AXWindow'&&e.label?.includes(path.basename(fixture)));
  assert.ok(w,'The unique fixture window is present');return w;
}
function editor(s){const w=fixtureWindow(s);return s.elements.find(e=>e.role==='AXTextArea'&&e.windowIndex===w.windowIndex);}
function target(s){const e=editor(s);assert.ok(e,'The fixture editor is present');return {type:'element',state_id:s.state_id,index:e.index};}
function value(s){return editor(s)?.value;}
const dir=path.join(root,'receipts',`macos-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
const fixture=path.join(dir,`cu-verification-${Date.now()}.txt`);
let result, helper;
let fixtureOpenAttempted=false, previewStarted=false;
const cleanup=[];
fs.writeFileSync(fixture,'');
try {
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Codewhale release check',version:'1.0'}});
  server.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const probe=(await tool('request_access')).data;
  assert.equal(probe.via,'app');assert.equal(probe.permissions.accessibility,'granted');assert.equal(probe.permissions.screen_capture,'ok');
  helper=await hello();
  assert.ok(helper?.hostTrustProtocol>=1,'The running helper supports host trust');
  const before=(await tool('consent_status',{},'host-status-before')).data;
  assert.equal(before.host?.trusted,false,'The fresh connection starts without approval');
  assert.equal(before.host?.persisted,false,'The verifier does not supply a persistent pairing key');
  process.stderr.write('Approve Codewhale release check in the native Computer Use panel to continue this connection-only verification.\n');
  await tool('list_apps',{all:true},'host-approval');
  const approval=(await tool('consent_status',{},'host-status-after')).data;
  assert.equal(approval.host?.trusted,true,'The helper records the real native approval');
  assert.equal(approval.host?.persisted,false,'This run does not verify persistent trust');
  await new Promise(resolve=>setTimeout(resolve,2100));
  // Take the baseline only once the desktop is settled: a previous run closing
  // its fixture hands the foreground back a moment later, and a baseline caught
  // mid-handover makes the check below flap for reasons this run did not cause.
  const settledForeground=async()=>{
    let last=null;
    for(let i=0;i<8;i++){
      const now=await foreground();
      if(now===last) return now;
      last=now;
      await new Promise(r=>setTimeout(r,400));
    }
    return last;
  };
  const foregroundBefore=await settledForeground();
  evidence.push({check:'post_approval_baseline',pid:foregroundBefore,at:new Date().toISOString()});
  await tool('open_application',{name:'TextEdit',url:pathToFileURL(fixture).href,activate:false});
  let s=await state();
  assert.notEqual(s.pid,foregroundBefore,'TextEdit remains in the background after approval');
  assert.ok(s.elements.some(e=>e.role==='AXWindow' && e.label?.includes(path.basename(fixture))),'The unique fixture window is present');
  assert.equal(value(s),'','Refuse to overwrite an existing document');
  const expected='Codewhale computer use works.\nUnicode: Hello 世界 🐋';
  await tool('type',{text:expected,target:target(s)});s=await state();assert.equal(value(s),expected);
  await tool('select_text',{target:target(s),text_range:[0,9]});s=await state();await tool('type',{text:'CODEWHALE',target:target(s)});s=await state();assert.equal(value(s),'CODEWHALE'+expected.slice(9));
  await tool('set_value',{target:target(s),value:expected});s=await state();assert.equal(value(s),expected);
  const w=fixtureWindow(s);
  const region=[w.position.x,w.position.y,w.size.w,w.size.h];
  const shot=await tool('screenshot',{app_ref,window_id:w.windowIndex});assert.ok(shot.content.some(c=>c.type==='image'),'MCP embeds screenshot bytes');
  assert.equal(shot.data.points.x,region[0]);assert.equal(shot.data.pixels.w,region[2]*shot.data.scale);
  const zoom=await tool('zoom',{region:[0,0,Math.min(600,shot.data.pixels.w),Math.min(240,shot.data.pixels.h)],raster_id:shot.data.raster_id});assert.ok(zoom.content.some(c=>c.type==='image'));
  if(showPreview) { await tool('preview',{enabled:true}); previewStarted=true; }
  // Everything so far is background-safe: observation, accessibility writes,
  // keyboard, window capture and the preview. None of it may take the
  // foreground.
  assert.equal(await foreground(),foregroundBefore,'Background tools and preview preserve foreground app');

  // A coordinate with no pressable accessibility element under it becomes a
  // window-routed click to the bound app's window. Either way the user's
  // cursor must not move: verified against the real cursor, not the receipt.
  const pointerBefore=(await tool('cursor_position')).data;
  const click=(await tool('left_click',{target:{type:'coordinate',x:40,y:100,raster_id:zoom.data.raster_id}})).data;
  s=await state();assert.equal(value(s),expected,'Pointer click preserves document contents');
  assert.ok(['a11y','window-record'].includes(click.strategy),'the click names its strategy');
  const frontAfterClick=await foreground();
  assert.equal(click.pointer_moved,false,'no click route moves the user cursor');
  const pointerAfter=(await tool('cursor_position')).data;
  assert.deepEqual([pointerAfter.x,pointerAfter.y],[pointerBefore.x,pointerBefore.y],'the user cursor stayed where it was');
  if(click.strategy==='a11y') assert.equal(frontAfterClick,foregroundBefore,'an accessibility press leaves the foreground alone');
  await tool('mouse_move',{target:{type:'coordinate',x:40,y:100,raster_id:zoom.data.raster_id}});
  const cursor=(await tool('cursor_position')).data;
  assert.ok(Number.isFinite(cursor.x)&&Number.isFinite(cursor.y));
  evidence.push({check:'pointer_cost',strategy:click.strategy,pointer_moved:click.pointer_moved,
    pointer_restored:click.pointer_restored,foreground_taken:click.foreground_taken,
    foreground_before:foregroundBefore,foreground_after:frontAfterClick,
    physical_pointer:{before:{x:pointerBefore.x,y:pointerBefore.y},after:{x:cursor.x,y:cursor.y}}});
  await tool('scroll',{target:target(s),direction:'down',amount:2});
  let stopped;
  if(recordVideo){
    const recording=(await tool('recording_start',{app_ref,window_id:w.windowIndex,durationSec:2})).data;
    await tool('wait',{seconds:3});stopped=(await tool('recording_stop',{id:recording.id})).data;assert.ok(stopped.bytes>0,'Recorded nonempty video');
  }
  result={passed:true,probe,helper,recording:stopped,approvalScope:'connection',persistenceVerified:false,consents,evidence};
} catch(e){result={passed:false,error:e.message,helper,approvalScope:'connection',persistenceVerified:false,consents,evidence};console.error(e);process.exitCode=1;}
finally{
  if(previewStarted) try { await tool('preview',{enabled:false}); } catch(e) { cleanup.push(e.message);process.exitCode=1; }
  // Address only this run's unique file. Never close the front document or
  // quit TextEdit: either could belong to the user by the time cleanup runs.
  if(fixtureOpenAttempted) try {
    execFileSync('osascript',['-e',`on run argv
      tell application "TextEdit"
        repeat with d in documents
          if path of d is item 1 of argv then
            close d saving no
            exit repeat
          end if
        end repeat
      end tell
    end run`,fixture],{timeout:10000,stdio:'pipe'});
  } catch(e) { cleanup.push('Fixture cleanup failed; left document open: '+e.message);process.exitCode=1; }
  server.stdin.end();await once(server,'exit');
  result={...result,passed:result.passed && cleanup.length===0,cleanup,evidence};
  fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,dir,calls:evidence.filter(e=>e.tool).length,cleanup},null,2));
}
