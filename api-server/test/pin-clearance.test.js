import test from 'node:test';import assert from 'node:assert/strict';
import {newDocument,getPage,addVertex,addWire,cellInfo,getCell,updateCell} from '../lib/model.js';
import {getPin} from '../lib/stencils.js';import {repairPinClearance,rotatedAabb} from '../lib/route.js';import {connectivityFingerprint} from '../lib/invariant.js';
test('late lane repair clears a neighbouring MOS gate without changing electrical anchors',()=>{
 const m=getPage(newDocument()),shape='mxgraph.electrical.transistors.pmos';
 addVertex(m,{id:'M1',shape,x:50,y:276,w:70,h:110,value:'PMOS'});getCell(m,'M1').setAttribute('style',getCell(m,'M1').getAttribute('style')+'flipH=1;');
 addVertex(m,{id:'M2',shape,x:240,y:276,w:70,h:110,value:'PMOS'});
 addWire(m,{id:'bad',source:'M1',target:'M2',sourcePin:getPin(shape,'W'),targetPin:getPin(shape,'SE'),points:[{x:236,y:331},{x:236,y:386}]});
 addWire(m,{id:'other',source:'M2',target:'M1',sourcePin:getPin(shape,'W'),targetPin:getPin(shape,'SE'),style:'edgeStyle=none;'});
 const before=connectivityFingerprint(m);const obstacles=['M1','M2'].map(id=>({id,...rotatedAabb(cellInfo(getCell(m,id)))}));
 repairPinClearance(m,obstacles);
 const c=cellInfo(getCell(m,'bad'));assert.equal(c.points[0].x,228);assert.equal(c.points[1].x,228);assert.equal(connectivityFingerprint(m),before);
});
