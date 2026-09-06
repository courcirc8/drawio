#!/usr/bin/env node
/** Read the saved document, never the generator's original in-memory netlist. */
import fs from 'node:fs';
import {parseDrawio,getPage} from '../lib/model.js';
import {extractNetlist,parseSpice} from '../lib/netlist.js';
import {auditVisibleConnectivity} from '../lib/visible-connectivity.js';
import {compare} from '../lib/lvs.js';
const args=process.argv.slice(2),file=args.shift();
function option(key){const i=args.indexOf(key);return i<0?null:args[i+1];}
try {
 if(!file)throw new Error('Usage: schematic-to-netlist.mjs file.drawio --reference golden.cir --strict --out extracted.cir --report report.json');
 const model=getPage(parseDrawio(fs.readFileSync(file,'utf8')));
 const ex=extractNetlist(model);
 const ref=option('--reference');
 if(args.includes('--strict')&&!ref)throw new Error('--strict requires --reference');
 const lvs=ref?compare(ex,parseSpice(fs.readFileSync(ref,'utf8'))):null;
 const report={...lvs,electrical_match:lvs?.match??null,visible_connectivity_match:null,
   visible_status:'not_checked_by_document_extractor',extraction_issues:ex.issues,
   ...(args.includes('--visual')?{visual_audit:auditVisibleConnectivity(model)}:{}),
   hidden_terminal_components:ex.components.filter(c=>c.fullNodes.length!==c.nodes.length).map(c=>c.ref)};
 const out=option('--out'),rp=option('--report');
 if(out)fs.writeFileSync(out,ex.spice);else process.stdout.write(ex.spice);
 if(rp)fs.writeFileSync(rp,JSON.stringify(report,null,2)+'\n');else console.error(JSON.stringify(report));
 if(args.includes('--strict')&&!lvs.match)process.exitCode=2;
} catch(e){console.error(e.message);process.exitCode=1;}
