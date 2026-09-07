import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {newDocument,getPage,allCells,cellInfo,serialize,parseDrawio} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';import {importNetlist2} from '../lib/place2.js';import {compare} from '../lib/lvs.js';
import {classify,pinOrderFor} from '../lib/components.js';import {getPin} from '../lib/stencils.js';import {pinAbs} from '../lib/route.js';
import {transistorOrientationCandidate} from '../lib/transistor-orientation.js';
test('saved MOS reflection preserves both conduction pins, netlist and owner label offset',async()=>{
 const parsed=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/wilson-mirror.cir',import.meta.url),'utf8')),doc=newDocument();importNetlist2(getPage(doc),parsed);
 const xml=serialize(doc),before=new Map(allCells(getPage(doc)).map(cellInfo).map(c=>[c.id,c]));
 for(const ref of ['M1','M2','M3']){
  const result=await transistorOrientationCandidate(xml,ref),saved=getPage(parseDrawio(result)),after=new Map(allCells(saved).map(cellInfo).map(c=>[c.id,c]));
  assert.equal(compare(extractNetlist(saved),parsed).match,true);
  const a=before.get(ref),b=after.get(ref),cl=classify(a),order=pinOrderFor(cl);
  for(const i of [0,2])assert.deepEqual(pinAbs(a,getPin(cl.shape.key,order[i])),pinAbs(b,getPin(cl.shape.key,order[i])));
  assert.equal(after.get('LBL_'+ref).x-before.get('LBL_'+ref).x,b.x-a.x);
 }
 assert.equal(serialize(doc),xml);
});
