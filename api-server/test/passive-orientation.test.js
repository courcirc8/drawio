import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newDocument,getPage,serialize,parseDrawio,allCells,cellInfo} from '../lib/model.js';
import {importNetlist2} from '../lib/place2.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {compare} from '../lib/lvs.js';
import {passiveOrientationCandidate,improvesOrientation} from '../lib/passive-orientation.js';
const make=()=>{const parsed=parseSpice(fs.readFileSync(new URL('../benchmark/netlists30/gilbert-mixer.cir',import.meta.url),'utf8')),doc=newDocument();importNetlist2(getPage(doc),parsed);return {xml:serialize(doc),parsed};};
test('passive reflection retains saved netlist and leaves the input snapshot unchanged',async()=>{
 const {xml,parsed}=make(),before=allCells(getPage(parseDrawio(xml))).map(cellInfo).map(c=>({id:c.id,x:c.x,y:c.y}));
 for(const carry of [false,true]){
  const result=await passiveOrientationCandidate(xml,'R1',carry);
  assert.equal(compare(extractNetlist(getPage(parseDrawio(result))),parsed).match,true);
 }
 assert.deepEqual(allCells(getPage(parseDrawio(xml))).map(cellInfo).map(c=>({id:c.id,x:c.x,y:c.y})),before);
 await assert.rejects(passiveOrientationCandidate(xml,'M1'),/Not a passive/);
});
test('ranking preserves original ties, prioritizes errors and rejects invalid scores',()=>{
 const r=(errors,crossings,jogs,warnings)=>({check:{errors,crossings,warnings},gatePortJogs:Array(jogs).fill(0)});
 assert.equal(improvesOrientation(r(0,2,0,2),r(1,0,0,0)),true);
 assert.equal(improvesOrientation(r(0,2,0,2),r(0,1,3,3)),false);
 assert.equal(improvesOrientation(r(0,1,0,2),r(0,1,0,2)),false);
 assert.equal(improvesOrientation(r(NaN,0,0,0),r(1,1,1,1)),false);
});
