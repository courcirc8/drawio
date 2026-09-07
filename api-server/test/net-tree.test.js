import test from 'node:test';
import assert from 'node:assert/strict';
import {newDocument,getPage,serialize,parseDrawio,addVertex,addWire,updateCell} from '../lib/model.js';
import {cellsOf} from '../lib/generic-refinement.js';
import {connectivityFingerprint} from '../lib/invariant.js';
import {netTreeProposals,netTreeCandidate} from '../lib/net-tree.js';
import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {compare} from '../lib/lvs.js';
import {importNetlist2} from '../lib/place2.js';
function fixture(){
 const doc=newDocument(),m=getPage(doc);
 for(const [id,x,y] of [['A',0,0],['B',120,60],['C',240,0],['D',0,200],['E',240,200]])addVertex(m,{id,x,y,w:0,h:0,style:'ellipse;drawioApiJunction=1;'});
 for(const [id,source,target] of [['ab','A','B'],['bc','B','C'],['de','D','E']])addWire(m,{id,source,target,sourcePin:{x:.5,y:.5},targetPin:{x:.5,y:.5},style:'edgeStyle=none;',points:id==='ab'?[{x:0,y:60}]:id==='bc'?[{x:240,y:60}]:[]});
 return {doc,m};
}
test('whole-net trunk preserves all terminals, vertices and unrelated edge geometry',()=>{
 const {doc,m}=fixture(),xml=serialize(doc),p=netTreeProposals(m).find(p=>p.axis==='h'&&p.coordinate===0);
 assert.ok(p);const after=getPage(parseDrawio(netTreeCandidate(xml,p)));
 assert.equal(connectivityFingerprint(after),connectivityFingerprint(m));
 const pick=c=>[c.id,c.x,c.y,c.w,c.h,c.rotation,c.points,c.style.raw];
 const original=cellsOf(m).filter(c=>c.style.map.get('contactDot')!=='1'&&c.id!=='ab'&&c.id!=='bc').map(pick);
 assert.deepEqual(cellsOf(after).filter(c=>c.style.map.get('contactDot')!=='1'&&c.id!=='ab'&&c.id!=='bc').map(pick),original);
 assert.equal(auditVisibleConnectivity(after).visible_connectivity_match,true);
 assert.equal(serialize(doc),xml);
 assert.ok(netTreeProposals(m).length<=6);
});
test('protected member excludes its entire net and manually supplied proposal fails closed',()=>{
 for(const key of ['drawioApiGateBus','drawioApiFixedRoute']){const {doc,m}=fixture(),p=netTreeProposals(m)[0];updateCell(m,'ab',{style:{[key]:'1'}});assert.equal(netTreeProposals(m).length,0);assert.throws(()=>netTreeCandidate(serialize(doc),p),/Protected/);}
});
test('partial net, invalid coordinate and missing terminal anchors fail closed',()=>{
 const {doc,m}=fixture(),p=netTreeProposals(m)[0];
 assert.throws(()=>netTreeCandidate(serialize(doc),{...p,edgeIds:['ab']}),/complete/);
 assert.throws(()=>netTreeCandidate(serialize(doc),{...p,coordinate:NaN}),/Invalid/);
 updateCell(m,'ab',{style:{exitX:'bad'}});assert.equal(netTreeProposals(m).length,0);
 assert.throws(()=>netTreeCandidate(serialize(doc),p),/anchors/);
});
test('electrical extraction remains LVS equivalent on an imported passive star',()=>{
 const ref=parseSpice('R1 in x 1k\nR2 x out 2k\nC1 x 0 1p\nR3 out 0 3k\n.end'),doc=newDocument(),m=getPage(doc);importNetlist2(m,ref,{signalAlignment:true});
 const ps=netTreeProposals(m);assert.ok(ps.length);
 for(const p of ps){const result=getPage(parseDrawio(netTreeCandidate(serialize(doc),p)));assert.equal(compare(extractNetlist(result),ref).match,true);}
});
test('candidate is geometrically idempotent and proposals translate with the drawing',()=>{
 const {doc,m}=fixture(),p=netTreeProposals(m).find(p=>p.axis==='h'&&p.coordinate===0);
 const once=netTreeCandidate(serialize(doc),p),twice=netTreeCandidate(once,p);
 assert.equal(twice,once);
 const before=netTreeProposals(m).map(({axis,coordinate,edgeIds})=>({axis,coordinate,edgeIds}));
 for(const c of cellsOf(m)){
  if(c.kind==='vertex')updateCell(m,c.id,{x:c.x+37,y:c.y-19});
  else if(c.kind==='edge')updateCell(m,c.id,{points:(c.points||[]).map(q=>({x:q.x+37,y:q.y-19}))});
 }
 const shifted=netTreeProposals(m).map(({axis,coordinate,edgeIds})=>({axis,coordinate:coordinate-(axis==='h'?-19:37),edgeIds}));
 assert.deepEqual(shifted,before);
});
