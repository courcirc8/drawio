import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newDocument,getPage,allCells,cellInfo,serialize,parseDrawio} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {importNetlist2} from '../lib/place2.js';
import {mirrorAboutConductionAxis} from '../lib/signal-alignment.js';
import {pinAbs} from '../lib/route.js';
import {compare} from '../lib/lvs.js';
import {classify,pinOrderFor} from '../lib/components.js';
import {getPin} from '../lib/stencils.js';
const point=(c,i)=>pinAbs(c,getPin(classify(c).shape.key,pinOrderFor(classify(c))[i]));
test('MOS reflection preserves D and S at all rotations',()=>{
 for(const rotation of [0,90,180,270])for(const flipH of [false,true]){
 const c={x:10,y:20,w:80,h:110,rotation,flipH},d={x:1,y:0},s={x:1,y:1},g={x:0,y:.5};
 const p=mirrorAboutConductionAxis(c,d,s);
 for(const pin of [d,s])assert.ok(Math.hypot(pinAbs(p,pin).x-pinAbs(c,pin).x,pinAbs(p,pin).y-pinAbs(c,pin).y)<1e-6);
 assert.ok(Math.hypot(pinAbs(p,g).x-pinAbs(c,g).x,pinAbs(p,g).y-pinAbs(c,g).y)>100);
 }
});
test('LNA mirrored gate and both series inductors align without moving D/S',()=>{
 const p=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/lna-diff-cascode.cir',import.meta.url),'utf8'));
 const make=opts=>{const d=newDocument();importNetlist2(getPage(d),p,opts);return d;};
 const before=make({}),after=make({signalAlignment:true});
 const bb=new Map(allCells(getPage(before)).map(cellInfo).map(c=>[c.id,c]));
 const aa=new Map(allCells(getPage(after)).map(cellInfo).map(c=>[c.id,c]));
 for(const [m,l] of [['M1','L1'],['M3','L4']]){
  for(const i of [0,2])assert.deepEqual(point(aa.get(m),i),point(bb.get(m),i));
  assert.ok(Math.abs(point(aa.get(m),1).y-point(aa.get(l),1).y)<.01);
 }
 assert.ok(point(aa.get('M3'),1).x>point(aa.get('M3'),0).x);
 assert.equal(compare(extractNetlist(getPage(parseDrawio(serialize(after)))),p).match,true);
});
test('PA output capacitor and inductor form a horizontal chain to the right of the drain',()=>{
 const p=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/pa-class-a.cir',import.meta.url),'utf8'));
 const d=newDocument();importNetlist2(getPage(d),p,{signalAlignment:true});
 const cs=new Map(allCells(getPage(d)).map(cellInfo).map(c=>[c.id,c]));
 assert.ok(point(cs.get('M1'),1).x<point(cs.get('M1'),0).x);
 const a=point(cs.get('C2'),0),b=point(cs.get('C2'),1),c=point(cs.get('L2'),0),e=point(cs.get('L2'),1);
 assert.ok(a.x>point(cs.get('M1'),0).x);assert.ok(a.x<b.x&&b.x<c.x&&c.x<e.x);
 for(const pt of [b,c,e])assert.ok(Math.abs(pt.y-a.y)<.01);
 assert.equal(compare(extractNetlist(getPage(parseDrawio(serialize(d)))),p).match,true);
});
import {directGatePortJogs} from '../lib/signal-alignment.js';
test('direct input ports align on OTA gates and alignment audit catches the old offsets',()=>{
 const p=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/ota-5t.cir',import.meta.url),'utf8'));
 const before=getPage(newDocument()),after=getPage(newDocument());
 importNetlist2(before,p);importNetlist2(after,p,{signalAlignment:true});
 assert.equal(directGatePortJogs(before).length,2);assert.equal(directGatePortJogs(after).length,0);
 assert.equal(compare(extractNetlist(after),p).match,true);
});
