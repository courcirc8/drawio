import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reserveChannels,branchOrders} from '../lib/floorplan.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {newDocument,getPage,serialize,parseDrawio} from '../lib/model.js';
import {importNetlist2} from '../lib/place2.js';
import {compare} from '../lib/lvs.js';
test('channel demand ignores MOS bulk and rails, preserves row/column alignment',()=>{
 const slots=new Map([['M1',{col:0,level:0}],['M2',{col:1,level:0}]]);
 const comps=parseSpice('M1 a b 0 shared NMOS\nM2 a b 0 shared NMOS').components;
 const ch=reserveChannels(comps,slots);
 assert.equal(ch.report.columns[0].demand,2);assert.equal(ch.x(1),14);assert.equal(ch.y(0),0);
 assert.equal(ch.x(.5),7);assert.throws(()=>reserveChannels(comps,slots,{pitch:NaN}));
});
for(const name of ['folded-cascode','ota-5t','bandgap-core','vco-lc','lna-diff-cascode','pa-class-a'])test(name+' candidate floorplans preserve saved electrical data',()=>{
 const p=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/'+name+'.cir',import.meta.url),'utf8'));
 const roots=importNetlist2(getPage(newDocument()),p).roots;
 const orders=branchOrders(p,roots);
 for(const order of [roots,...orders]){
  assert.deepEqual([...order].sort(),[...roots].sort());
  const doc=newDocument();importNetlist2(getPage(doc),p,{order,reservedChannels:true});
  assert.equal(compare(extractNetlist(getPage(parseDrawio(serialize(doc)))),p).match,true);
 }
});
