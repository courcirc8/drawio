#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {parseDrawio,getPage,serialize} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {compare} from '../lib/lvs.js';
import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
import {directGatePortJogs} from '../lib/signal-alignment.js';
import {improvesOrientation} from '../lib/passive-orientation.js';
import {orthogonalDetourProposals,applyTeeProposal} from '../lib/route.js';
import {exportDocument,closeBrowser} from '../lib/render.js';
const [input,output]=process.argv.slice(2);
if(!input||!output||path.resolve(input)===path.resolve(output))throw new Error('Usage: refine-orthogonal-detours.mjs INPUT OUTPUT (distinct directories)');
if(fs.existsSync(output))throw new Error('Output already exists; refusing to overwrite an experiment');
fs.cpSync(input,output,{recursive:true});
const rows=JSON.parse(fs.readFileSync(path.join(output,'summary.json'))),checker=fileURLToPath(new URL('./check.py',import.meta.url));
const deadline=Date.parse(process.env.DEADLINE_UTC||'9999-01-01');
function evaluate(p,ref,id){
 const saved=getPage(parseDrawio(fs.readFileSync(p+'.xml','utf8'))),lvs=compare(extractNetlist(saved),ref),visual=auditVisibleConnectivity(saved);
 const run=spawnSync('python3',[checker,p+'.xml','--json'],{encoding:'utf8',timeout:60000});
 if(run.error||![0,1].includes(run.status)||!run.stdout)throw new Error(run.error?.message||run.stderr||'Checker failed');
 const check=JSON.parse(run.stdout);
 if(![check.errors,check.crossings,check.warnings].every(Number.isFinite))throw new Error('Invalid checker counters');
 return {id,lvs,visual,check,gatePortJogs:directGatePortJogs(saved),eligible:lvs.match===true&&visual.visible_connectivity_match===true};
}
try{for(const row of rows){
 if(Date.now()>=deadline)break;
 const dir=path.join(output,row.name),ref=parseSpice(fs.readFileSync(row.source,'utf8'));
 const before=row.selected;let best=evaluate(path.join(dir,before),ref,before);
 if(!best.eligible)throw new Error(`Invalid initial drawing ${row.name}`);
 // Every candidate in a round starts from the exact same accepted drawing.
 for(let round=1;round<=3;round++){
  const parent=best.id,xml=fs.readFileSync(path.join(dir,parent+'.xml'),'utf8');
  for(const proposal of orthogonalDetourProposals(getPage(parseDrawio(xml))).slice(0,200)){
   if(Date.now()>=deadline)break;
   const id=`${path.basename(output)}-detour-${round}-${proposal.id}`,p=path.join(dir,id);
   try{
    const doc=parseDrawio(xml);applyTeeProposal(getPage(doc),proposal);fs.writeFileSync(p+'.xml',serialize(doc));
    const r={...evaluate(p,ref,id),parent,tee:proposal};
    row.results.push(r);fs.writeFileSync(p+'.json',JSON.stringify(r,null,2));
    if(r.eligible&&improvesOrientation(r,best))best=r;
   }catch(e){row.results.push({id,parent,eligible:false,error:e.message});}
  }
  if(best.id===parent)break;
 }
 row.selected=best.id;row.selectedMetrics=[best.check.errors,best.check.crossings,best.check.warnings];
 row.detourPrevious=before;row.improved=improvesOrientation(best,row.results[0]);
 fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(rows,null,2));
 if(best.id!==before){const p=path.join(dir,best.id),doc=parseDrawio(fs.readFileSync(p+'.xml','utf8'));fs.writeFileSync(p+'.png',(await exportDocument(doc,getPage(doc),{scale:1.5})).buffer);}
 console.log(row.name,before,'->',best.id,row.selectedMetrics);
}}finally{await closeBrowser();}
