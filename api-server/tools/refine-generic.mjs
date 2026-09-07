#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {parseDrawio,getPage} from '../lib/model.js';import {parseSpice,extractNetlist} from '../lib/netlist.js';import {compare} from '../lib/lvs.js';import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';import {directGatePortJogs} from '../lib/signal-alignment.js';import {exportDocument,closeBrowser} from '../lib/render.js';
import {routeMetrics} from '../lib/annotation-refinement.js';
import {genericProposals,localCandidate} from '../lib/generic-refinement.js';
const [input,output,loopArg]=process.argv.slice(2),loop=Number(loopArg);
if(!input||!output||![1,2,3,4,5].includes(loop)||fs.existsSync(output))throw new Error('INPUT NEW_OUTPUT LOOP(1..5) required');
fs.cpSync(input,output,{recursive:true});const rows=JSON.parse(fs.readFileSync(path.join(output,'summary.json'))),log=[];
function evaluate(p,ref,id,name){const model=getPage(parseDrawio(fs.readFileSync(p+'.xml','utf8'))),lvs=compare(extractNetlist(model),ref),visual=auditVisibleConnectivity(model),run=spawnSync('python3',[fileURLToPath(new URL('./check.py',import.meta.url)),p+'.xml','--json'],{encoding:'utf8',timeout:60000});if(![0,1].includes(run.status))throw new Error(run.stderr||'Checker failed');const check=JSON.parse(run.stdout);return {id,lvs,visual,check,gatePortJogs:directGatePortJogs(model),routing:routeMetrics(model),eligible:lvs.match===true&&visual.visible_connectivity_match===true};}
function rank(r){return [r.check.errors,r.routing.portBends,r.routing.bends,r.check.warnings,r.check.crossings,r.routing.length];}
const better=(a,b)=>{const aa=rank(a),bb=rank(b);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return aa[i]<bb[i];return false;};
try{for(const row of rows){const dir=path.join(output,row.name),ref=parseSpice(fs.readFileSync(row.source,'utf8')),before=row.selected;let best=evaluate(path.join(dir,before),ref,before,row.name),initial=best;if(!best.eligible||best.check.errors)throw new Error('Invalid initial '+row.name);
 let attempts=0;for(let round=1;round<=2;round++){const parent=best.id,xml=fs.readFileSync(path.join(dir,parent+'.xml'),'utf8'),model=getPage(parseDrawio(xml));const proposals=genericProposals(model,ref,loop);
 for(const proposal of proposals){const id=`${path.basename(output)}-${round}-${proposal.id}`,p=path.join(dir,id);attempts++;
 try{fs.writeFileSync(p+'.xml',localCandidate(xml,proposal));const r={...evaluate(p,ref,id,row.name),parent,proposal};row.results.push(r);fs.writeFileSync(p+'.json',JSON.stringify(r,null,2));if(r.eligible&&better(r,best))best=r;}catch(e){row.results.push({id,parent,eligible:false,error:e.message});}}
 if(best.id===parent)break;}
 row.selected=best.id;row.selectedMetrics=[best.check.errors,best.check.crossings,best.check.warnings];const bi=row.results.findIndex(x=>x.id===best.id);if(bi>=0)row.results[bi]={...row.results[bi],...best};
 if(best.id!==before){const p=path.join(dir,best.id),doc=parseDrawio(fs.readFileSync(p+'.xml','utf8'));fs.writeFileSync(p+'.png',(await exportDocument(doc,getPage(doc),{scale:1.5})).buffer);}
 log.push({name:row.name,attempts,before,after:best.id,beforeRank:rank(initial),afterRank:rank(best)});fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(rows,null,2));fs.writeFileSync(path.join(output,'LOOP.json'),JSON.stringify({loop,rank:['errors','portBends','bends','warnings','crossings','length'],rows:log},null,2));console.log(row.name,attempts,before===best.id?'unchanged':'IMPROVED',rank(initial),'->',rank(best));
}}finally{await closeBrowser();}
