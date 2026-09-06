import test from 'node:test';import assert from 'node:assert/strict';
import {newDocument,getPage,addVertex,addWire,cellInfo,getCell,setEdgePoints} from '../lib/model.js';
import {getShape} from '../lib/stencils.js';import {pinAbs} from '../lib/route.js';import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
const shape='mxgraph.electrical.resistors.resistor_2';
function model(){const m=getPage(newDocument());addVertex(m,{id:'R1',shape,x:0,y:0,w:20,h:100,value:'1k'});addVertex(m,{id:'R2',shape,x:200,y:80,w:20,h:100,value:'2k'});const pins=getShape(shape).pins;const a=pins.find(p=>p.name==='in'),b=pins.find(p=>p.name==='out');addWire(m,{id:'w',source:'R1',target:'R1',sourcePin:a,targetPin:b,style:'edgeStyle=none;endArrow=none;'});return {m,a,b};}
test('geometry independently detects a wire running into a foreign component pin',()=>{
 const {m,a}=model();assert.equal(auditVisibleConnectivity(m).visible_connectivity_match,true);
 const p=pinAbs(cellInfo(getCell(m,'R2')),a);setEdgePoints(getCell(m,'w'),[p]);
 const report=auditVisibleConnectivity(m);assert.equal(report.visible_connectivity_match,false);assert.equal(report.issues[0].code,'visible-partition-mismatch');
});
test('implicit nonorthogonal automatic path is not claimed as visually checked',()=>{
 const {m,a,b}=model();addWire(m,{id:'auto',source:'R1',target:'R2',sourcePin:a,targetPin:b});
 const report=auditVisibleConnectivity(m);assert.equal(report.visible_connectivity_match,null);assert.ok(report.unevaluated_wires.includes('auto'));
});
