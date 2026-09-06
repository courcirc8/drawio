import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {compare} from '../lib/lvs.js';
import {newDocument,getPage,serialize,parseDrawio,getCell,updateCell} from '../lib/model.js';
import {importNetlist2} from '../lib/place2.js';
import {connectivityFingerprint} from '../lib/invariant.js';
const circuit='M1 out in 0 body NMOS W=2u L=180n\nR1 out vdd 1k\nV1 vdd 0 1.8\nV2 body 0 0.2';
function fixture(text=circuit){const golden=parseSpice(text),doc=newDocument(),m=getPage(doc);importNetlist2(m,golden);return {golden,doc,m};}
test('saved schematic preserves all four MOS terminals and parameters',()=>{
 const {golden,doc}=fixture();const ex=extractNetlist(getPage(parseDrawio(serialize(doc))));
 assert.equal(compare(ex,golden).match,true);assert.equal(ex.components.find(c=>c.ref==='M1').fullNodes.length,4);
 assert.match(ex.spice,/M1\s+\S+\s+\S+\s+\S+\s+\S+\s+NMOS W=2u L=180n/);
});
for(const [name,text] of [['bulk',circuit.replace('0 body NMOS','0 0 NMOS')],['model',circuit.replace('NMOS','PMOS')],['width',circuit.replace('W=2u','W=3u')],['value',circuit.replace('1k','2k')],['unsupported',circuit+'\nX1 out in blackbox'],['directive',circuit+'\n.param foo=1']])test('strict LVS rejects '+name,()=>{
 const {m}=fixture();assert.equal(compare(extractNetlist(m),parseSpice(text)).match,false);
});
test('missing omitted-terminal data fails closed',()=>{const {m,golden}=fixture();getCell(m,'M1').removeAttribute('spice_hidden_nodes');assert.equal(compare(extractNetlist(m),golden).match,false);});
test('effective value and coordinate anchors are in invariant',()=>{
 const {m}=fixture();const before=connectivityFingerprint(m);getCell(m,'M1').setAttribute('spice_value','PMOS');assert.notEqual(connectivityFingerprint(m),before);
});
test('passive short and two isolated terminals are not equivalent',()=>{
 const c=nodes=>({components:[{ref:'R1',prefix:'R',nodes,value:'1k'}]});assert.equal(compare(c(['a','a']),c(['a','b'])).match,false);
});
test('duplicate references reject extraction and input',()=>{
 assert.throws(()=>parseSpice('R1 a b 1k\nr1 b c 2k'),/duplicate/);
 const {m,golden}=fixture();const ex=extractNetlist(m);ex.components.push(ex.components[0]);assert.equal(compare(ex,golden).match,false);
});
test('renamed ground must fail even with identical topology',()=>{
 const c=nodes=>({components:[{ref:'V1',prefix:'V',nodes,value:'1'}]});assert.equal(compare(c(['a','b']),c(['a','0'])).match,false);
});
test('a hidden-only bulk net survives serialization',()=>{const {m,golden}=fixture('M1 out in 0 body NMOS\nR1 out 0 1k');assert.equal(compare(extractNetlist(m),golden).match,true);});

import {tryGeometry} from '../lib/transaction.js';
for(const mode of ['reject','throw'])test('whole document rollback after '+mode,async()=>{
 const {m,doc}=fixture();const before=serialize(doc);
 const operation=()=>{updateCell(m,'M1',{dx:25});getCell(m,'R1').setAttribute('spice_value','999k');if(mode==='throw')throw new Error('injected failure');return 0;};
 if(mode==='throw')await assert.rejects(tryGeometry(m,operation,()=>true),/injected failure/);
 else assert.equal((await tryGeometry(m,operation,()=>false)).accepted,false);
 assert.equal(serialize(doc),before);
});
test('moving a wire anchor changes the invariant even with unchanged pin name',()=>{
 const {m}=fixture();const edge=Array.from(m.getElementsByTagName('mxCell')).find(n=>n.getAttribute('edge')==='1');
 const before=connectivityFingerprint(m);edge.setAttribute('style',(edge.getAttribute('style')||'').replace(/exitX=[^;]+/,'exitX=0.333'));assert.notEqual(connectivityFingerprint(m),before);
});
test('named input ports cannot be silently exchanged',()=>{
 const components=[{ref:'M1',prefix:'M',nodes:['out','INP','tail'],value:'NMOS'},{ref:'M2',prefix:'M',nodes:['out','INM','tail'],value:'NMOS'}];
 const ex={components,namedNets:['INP','INM']};const golden={components:components.map(c=>({...c,nodes:c.nodes.map(n=>n==='INP'?'INM':n==='INM'?'INP':n)}))};assert.equal(compare(ex,golden).match,false);
});
test('empty reference and missing element value do not certify a schematic',()=>{
 assert.equal(compare({components:[]},{components:[]}).match,false);
 const ex={components:[{ref:'R1',prefix:'R',nodes:['a','b'],value:''}]};assert.equal(compare(ex,parseSpice('R1 a b')).match,false);
});
test('wrong MOS polarity is rejected even when drain and source are shorted',()=>{
 const {m,golden}=fixture('M1 0 in 0 0 NMOS');const c=getCell(m,'M1');c.setAttribute('style',c.getAttribute('style').replace('transistors.nmos','transistors.pmos'));
 assert.equal(compare(extractNetlist(m),golden).match,false);
});
