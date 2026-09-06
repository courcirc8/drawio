#!/usr/bin/env node
import {directGatePortJogs} from '../lib/signal-alignment.js';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {newDocument,getPage,serialize,parseDrawio,normalizeOrigin} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {importNetlist2} from '../lib/place2.js';
import {branchOrders} from '../lib/floorplan.js';
import {routePage} from '../lib/route.js';
import {compare} from '../lib/lvs.js';
import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
import {exportDocument,closeBrowser} from '../lib/render.js';
const [out,...files]=process.argv.slice(2);
if(!out||!files.length)throw new Error('Usage: compare-floorplans.mjs OUTPUT_DIR NETLIST...');
fs.mkdirSync(out,{recursive:true});
const checker=fileURLToPath(new URL('./check.py',import.meta.url));
const summary=[];
const rank=r=>[r.check.errors,r.check.crossings,r.check.warnings];
const selectionRank=r=>[r.check.errors,r.check.crossings,r.gatePortJogs?.length||0,r.check.warnings];
const better=(a,b)=>{const aa=selectionRank(a),bb=selectionRank(b);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return aa[i]<bb[i];return false;};
try{
for(const file of files){
 const name=path.basename(file,'.cir'),dir=path.join(out,name);fs.mkdirSync(dir,{recursive:true});
 const parsed=parseSpice(fs.readFileSync(file,'utf8'));
 const roots=importNetlist2(getPage(newDocument()),parsed).roots||[];
 const orders=branchOrders(parsed,roots);
 const variants=[{id:'baseline',opts:{}},{id:'channels',opts:{reservedChannels:true}},
   {id:'wide-channels',opts:{reservedChannels:{pitch:28,cap:168}}},
   ...orders.flatMap((order,i)=>[{id:`blocks-${i+1}`,opts:{order}}, {id:`blocks-channels-${i+1}`,opts:{order,reservedChannels:true}}])];
 if(process.env.SIGNAL_ALIGNMENT==='1'){const original=[...variants];for(const v of original)variants.push({id:v.id+'-aligned',opts:{...v.opts,signalAlignment:true}});}
 const results=[];let best=null;
 for(const v of variants){
  try{
   const doc=newDocument(),m=getPage(doc);const placement=importNetlist2(m,parsed,v.opts);
   await routePage(m,null,{});normalizeOrigin(m);
   const xml=serialize(doc),p=path.join(dir,v.id);fs.writeFileSync(p+'.xml',xml);
   const saved=getPage(parseDrawio(fs.readFileSync(p+'.xml','utf8')));
   const lvs=compare(extractNetlist(saved),parsed),visual=auditVisibleConnectivity(saved);
   const run=spawnSync('python3',[checker,p+'.xml','--json'],{encoding:'utf8',timeout:60000});
   if(run.error||!run.stdout)throw new Error(run.error?.message||run.stderr||'Checker returned no result');
   const check=JSON.parse(run.stdout);
   if(![check.errors,check.crossings,check.warnings].every(Number.isFinite))throw new Error('Invalid checker counters');
   const r={id:v.id,opts:v.opts,lvs,visual,check,gatePortJogs:directGatePortJogs(saved),channels:placement.channels,
     eligible:lvs.match===true&&visual.visible_connectivity_match===true};
   fs.writeFileSync(p+'.json',JSON.stringify(r,null,2));results.push(r);
   if(r.eligible&&(!best||better(r,best)))best=r;
   console.log(name,v.id,'LVS',lvs.match,'visible',visual.visible_connectivity_match,'errors',check.errors,'crossings',check.crossings);
  }catch(e){results.push({id:v.id,error:e.message,eligible:false});console.log(name,v.id,'REJECT',e.message);}
 }
 const baseline=results[0];
 const record={name,source:path.resolve(file),baseline:baseline.id,selected:best?.id||null,
  baselineMetrics:baseline.check?rank(baseline):null,selectedMetrics:best?rank(best):null,
  improved:!!best&&!!baseline.check&&better(best,baseline),results};
 summary.push(record);fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
 for(const id of new Set(['baseline',best?.id].filter(Boolean))){
  try {
  const p=path.join(dir,id),doc=parseDrawio(fs.readFileSync(p+'.xml','utf8'));
  fs.writeFileSync(p+'.png',(await exportDocument(doc,getPage(doc),{scale:1.5})).buffer);
  } catch(e) {record.renderErrors ||= [];record.renderErrors.push({id,error:e.message});}
 }
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
}
}finally{await closeBrowser();}
