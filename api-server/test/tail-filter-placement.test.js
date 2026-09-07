import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {newDocument,getPage,allCells,cellInfo,serialize,parseDrawio} from '../lib/model.js';import {parseSpice,extractNetlist} from '../lib/netlist.js';import {importNetlist2} from '../lib/place2.js';import {compare} from '../lib/lvs.js';import {tailFilters,tailFilterCandidate} from '../lib/tail-filter-placement.js';import {classify,pinOrderFor} from '../lib/components.js';import {getPin} from '../lib/stencils.js';import {pinAbs} from '../lib/route.js';
test('tail filter forms a vertical L-M chain with a capacitor branch at its upper node',async()=>{
 const parsed=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/vco-lc-tail-filter.cir',import.meta.url),'utf8')),doc=newDocument();importNetlist2(getPage(doc),parsed,{order:['L2','L1'],reservedChannels:true,signalAlignment:true});
 const patterns=tailFilters(parsed);assert.equal(patterns.length,1);const original=serialize(doc),xml=await tailFilterCandidate(original,patterns[0],160,40),saved=getPage(parseDrawio(xml)),cells=new Map(allCells(saved).map(cellInfo).map(c=>[c.id,c]));
 const p=(id,i)=>{const c=cells.get(id),cl=classify(c);return pinAbs(c,getPin(cl.shape.key,pinOrderFor(cl)[i]));};
 assert.equal(p('L3',0).y,p('C2',0).y);assert.equal(p('C2',0).x-p('L3',0).x,160);
 assert.equal(p('L3',1).x,p('M3',0).x);assert.equal(p('M3',0).y-p('L3',1).y,40);
 assert.equal(compare(extractNetlist(saved),parsed).match,true);assert.equal(serialize(doc),original);
});
