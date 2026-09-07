import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {newDocument,getPage,serialize,parseDrawio} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';import {importNetlist2} from '../lib/place2.js';
import {routePage,nearbyTeeProposals,applyTeeProposal,orthogonalSegmentProposals,separatedTrackProposals,orthogonalDetourProposals} from '../lib/route.js';import {compare} from '../lib/lvs.js';import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
test('nearby beta-multiplier tees can share one junction while preserving visible connectivity',async()=>{
 const ref=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/beta-multiplier.cir',import.meta.url),'utf8')),doc=newDocument(),model=getPage(doc);
 importNetlist2(model,ref);await routePage(model,null,{});const original=serialize(doc),dir=fs.mkdtempSync(path.join(os.tmpdir(),'nearby-tees-'));
 const check=xml=>{const p=path.join(dir,'test.xml');fs.writeFileSync(p,xml);const r=spawnSync('python3',[fileURLToPath(new URL('../tools/check.py',import.meta.url)),p,'--json'],{encoding:'utf8'});return JSON.parse(r.stdout);};
 try{
  const before=check(original);assert.ok(before.errors>0);
  let repaired=false;
  for(const proposal of nearbyTeeProposals(model)){
   const candidate=parseDrawio(original);applyTeeProposal(getPage(candidate),proposal);
   const xml=serialize(candidate),saved=getPage(parseDrawio(xml));
   if(compare(extractNetlist(saved),ref).match&&auditVisibleConnectivity(saved).visible_connectivity_match===true&&check(xml).errors<before.errors)repaired=true;
  }
  assert.ok(repaired,'at least one proposal removes the missing contact without electrical regression');
  assert.equal(serialize(doc),original,'candidate generation leaves the original drawing untouched');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('explicit orthogonal candidates can remove a VCO diagonal without a short',async()=>{
 const ref=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/vco-lc.cir',import.meta.url),'utf8')),doc=newDocument(),model=getPage(doc);
 importNetlist2(model,ref,{reservedChannels:true,signalAlignment:true});await routePage(model,null,{});
 const original=serialize(doc),proposals=orthogonalSegmentProposals(model);assert.ok(proposals.length>0);
 let valid=false;
 for(const proposal of proposals){const candidate=parseDrawio(original);applyTeeProposal(getPage(candidate),proposal);const saved=getPage(parseDrawio(serialize(candidate)));
  if(compare(extractNetlist(saved),ref).match&&auditVisibleConnectivity(saved).visible_connectivity_match===true&&orthogonalSegmentProposals(saved).length<proposals.length)valid=true;
 }
 assert.ok(valid);assert.equal(serialize(doc),original);
});

test('separating close Cherry-Hooper tracks can remove an error with saved connectivity intact',async()=>{
 const ref=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/cherry-hooper.cir',import.meta.url),'utf8')),doc=newDocument(),model=getPage(doc);
 importNetlist2(model,ref,{order:['R4','R3'],reservedChannels:true,signalAlignment:true});await routePage(model,null,{});
 const original=serialize(doc),dir=fs.mkdtempSync(path.join(os.tmpdir(),'separated-tracks-'));
 const check=xml=>{const p=path.join(dir,'test.xml');fs.writeFileSync(p,xml);return JSON.parse(spawnSync('python3',[fileURLToPath(new URL('../tools/check.py',import.meta.url)),p,'--json'],{encoding:'utf8'}).stdout);};
 try{
  const before=check(original);let valid=false;
  for(const proposal of separatedTrackProposals(model)){
   const candidate=parseDrawio(original);applyTeeProposal(getPage(candidate),proposal);const xml=serialize(candidate),saved=getPage(parseDrawio(xml));
   if(compare(extractNetlist(saved),ref).match&&auditVisibleConnectivity(saved).visible_connectivity_match===true&&check(xml).errors<before.errors)valid=true;
  }
  assert.ok(valid);assert.equal(serialize(doc),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('three-bend StrongARM alternative removes the final geometric error without changing connectivity',async()=>{
 const ref=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/strongarm-latch.cir',import.meta.url),'utf8')),doc=newDocument(),model=getPage(doc);
 importNetlist2(model,ref,{order:['M8','M6','M7','M5']});await routePage(model,null,{});
 const original=serialize(doc),dir=fs.mkdtempSync(path.join(os.tmpdir(),'orthogonal-detours-'));
 const check=xml=>{const p=path.join(dir,'test.xml');fs.writeFileSync(p,xml);return JSON.parse(spawnSync('python3',[fileURLToPath(new URL('../tools/check.py',import.meta.url)),p,'--json'],{encoding:'utf8'}).stdout);};
 try{
  assert.ok(check(original).errors>0);let valid=false;
  for(const proposal of orthogonalDetourProposals(model)){
   const candidate=parseDrawio(original);applyTeeProposal(getPage(candidate),proposal);const xml=serialize(candidate),saved=getPage(parseDrawio(xml));
   if(compare(extractNetlist(saved),ref).match&&auditVisibleConnectivity(saved).visible_connectivity_match===true&&check(xml).errors===0){valid=true;break;}
  }
  assert.ok(valid);assert.equal(serialize(doc),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
