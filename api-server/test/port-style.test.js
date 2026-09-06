import test from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,getPage,addVertex,addWire,allCells,cellInfo} from '../lib/model.js';
import {applyPortStyle,portDirection} from '../lib/port-style.js';
import {classify} from '../lib/components.js';
import {extractNetlist} from '../lib/netlist.js';
import {compare} from '../lib/lvs.js';
for(const type of ['input','output','inout'])test('family A '+type+' keeps electrical role and connections',()=>{
 const m=getPage(newDocument());addVertex(m,{id:'P',shape:'port',value:'RF',x:0,y:0,w:24,h:24});addVertex(m,{id:'R1',shape:'mxgraph.electrical.resistors.resistor_1',value:'1k',x:130,y:0,w:80,h:20});addWire(m,{id:'w',source:'P',target:'R1',sourcePin:{x:1,y:.5},targetPin:{x:0,y:.5}});
 const before=extractNetlist(m);applyPortStyle(m,{portDirections:{RF:type}});const after=extractNetlist(m),p=allCells(m).map(cellInfo).find(c=>c.id==='P');
 assert.equal(compare(after,before).match,true);assert.equal(classify(p).role,'port');assert.equal(p.style.map.get('portDirection'),type);assert.equal(p.style.map.get('shape'),type==='inout'?'doubleArrow':'singleArrow');assert.equal(p.style.map.get('verticalLabelPosition'),'middle');
});
test('unknown port direction remains bidirectional; overrides are validated',()=>{assert.equal(portDirection('RF'),'inout');assert.equal(portDirection('OUTP'),'output');assert.equal(portDirection('VB1'),'input');assert.throws(()=>portDirection('RF',{RF:'invented'}));});

import {importNetlist3} from '../lib/place3.js';
import {parseSpice} from '../lib/netlist.js';
test('v3 preserves PMOS model and source-up pin order',()=>{
 const m=getPage(newDocument()),golden=parseSpice('M1 out in vdd vdd PMOS\nR1 out 0 1k');importNetlist3(m,golden);
 assert.equal(compare(extractNetlist(m),golden).match,true);
});
