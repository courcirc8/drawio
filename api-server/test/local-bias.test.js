import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {newDocument,getPage,serialize,parseDrawio} from '../lib/model.js';
import {parseSpice,extractNetlist} from '../lib/netlist.js';
import {importNetlist2} from '../lib/place2.js';
import {compare} from '../lib/lvs.js';
for (const name of ['folded-cascode','telescopic-ota','delay-cell-cc','lna-diff-cascode']) {
 test(`${name}: local bias ports preserve the saved netlist without duplicate global buses`,()=>{
  const golden=parseSpice(fs.readFileSync(new URL(`../benchmark/netlists30/${name}.cir`,import.meta.url),'utf8'));
  const doc=newDocument(),model=getPage(doc);importNetlist2(model,golden);
  const xml=serialize(doc);assert.match(xml,/id="PB_/);
  assert.equal(compare(extractNetlist(getPage(parseDrawio(xml))),golden).match,true);
  const ports=[...model.getElementsByTagName('mxCell')].filter(c=>c.getAttribute('id').startsWith('PB_'));
  const names=new Set(ports.map(c=>c.getAttribute('value')));
  for(const c of model.getElementsByTagName('mxCell')) if(c.getAttribute('id').startsWith('PN'))assert.equal(names.has(c.getAttribute('value')),false);
  const old=newDocument();importNetlist2(getPage(old),golden,{localBiasPorts:false});assert.doesNotMatch(serialize(old),/id="PB_/);
 });
}
