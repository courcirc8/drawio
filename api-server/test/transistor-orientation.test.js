import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {newDocument,getPage,allCells,cellInfo,serialize,parseDrawio} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';import {importNetlist2} from '../lib/place2.js';import {compare} from '../lib/lvs.js';
import {classify,pinOrderFor} from '../lib/components.js';import {getPin} from '../lib/stencils.js';import {pinAbs} from '../lib/route.js';
import {transistorOrientationCandidate,spacedMirrorCandidate} from '../lib/transistor-orientation.js';
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

test('spaced Wilson mirror faces gates inward and re-centres displaced labels',async()=>{
 const parsed=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/wilson-mirror.cir',import.meta.url),'utf8')),doc=newDocument();importNetlist2(getPage(doc),parsed,{reservedChannels:{pitch:28,cap:168}});
 const saved=getPage(parseDrawio(await spacedMirrorCandidate(serialize(doc),['M2','M3'],24))),cells=allCells(saved).map(cellInfo),pair=['M2','M3'].map(id=>cells.find(c=>c.id===id));
 const point=(c,i)=>{const cl=classify(c);return pinAbs(c,getPin(cl.shape.key,pinOrderFor(cl)[i]));};
 pair.sort((a,b)=>point(a,0).x-point(b,0).x);
 assert.ok(point(pair[0],1).x>point(pair[0],0).x);
 assert.ok(point(pair[1],1).x<point(pair[1],0).x);
 assert.ok(pair[1].x-pair[0].x>=pair[0].w+24);
 for(const c of pair){const label=cells.find(l=>l.id==='LBL_'+c.id);assert.equal(label.x+label.w/2,c.x+c.w/2);}
 assert.equal(compare(extractNetlist(saved),parsed).match,true);
});
