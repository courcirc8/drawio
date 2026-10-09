import fs from 'node:fs';
// motif-census.mjs — how many bank circuits (3-25 parts, exclusions applied,
// sealed refused) hold each circuit-level motif: the list of templates to build
// (orchestrator 2026-10-09, after the CML comparator template).
// Usage: node tools/motif-census.mjs
const A = new URL('../lib/', import.meta.url).href;
const { parseSpice } = await import(A+'netlist.js');
const { detectMotifs } = await import(A+'motifs.js');
const { detectStructures, isPmosLike } = await import(A+'patterns.js');
const { latchReading } = await import(A+'place-latch.js');
const { bankExclusions, sealedStatus } = await import(A+'sealed.js');
const B='/AI/datasets/netlists/bank', ex=bankExclusions(B);
const man=new Map(fs.readdirSync(B).filter(f=>/^manifest.*\.jsonl$/.test(f)).flatMap(f=>fs.readFileSync(`${B}/${f}`,'utf8').trim().split('\n').map(l=>JSON.parse(l))).map(r=>[r.id,r.file]));
const inv=fs.readFileSync(`${B}/inventory.jsonl`,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.usable&&!r.duplicateOf&&!ex.has(r.id)&&r.parts<=25&&r.parts>=3);
const D=c=>c.nodes[0],G=c=>c.nodes[1],S=c=>c.nodes[2];
const RAIL=/^(0|gnd\w*|vss\w*|vdd\w*|vcc\w*|vee\w*|avdd|avss|dvdd|dvss)$/i;
const cnt={}, fam={}, ex1={}; let n=0;
const hit=(k,r)=>{cnt[k]=(cnt[k]||0)+1; (fam[k]??={})[r.family]=((fam[k]??={})[r.family]||0)+1; (ex1[k]??=[]).length<3&&ex1[k].push(r.id);};
for (const r of inv){ let t; try{t=fs.readFileSync(man.get(r.id),'utf8');}catch{continue;} if(sealedStatus(t))continue; let p; try{p=parseSpice(/\.end\b/i.test(t)?t:t+'\n.end');}catch{continue;} n++;
  const by=new Map(p.components.map(c=>[c.ref,c])); let st,mo; try{st=detectStructures(p);mo=detectMotifs(p).instances;}catch{continue;}
  const has=k=>mo.some(i=>i.motif===k);
  const mos=p.components.filter(c=>c.prefix==='M'), bjt=p.components.filter(c=>c.prefix==='Q');
  // OTA 5T: diff pair whose drains are the two sides of a current mirror (active load)
  const ota=st.diffPairs.some(dp=>{const [a,b]=dp.refs.map(x=>by.get(x)); return st.mirrors.some(m=>{const ds=m.refs.map(x=>D(by.get(x))); return ds.includes(D(a))&&ds.includes(D(b));});});
  if (ota) hit('OTA à charge miroir (5T)',r);
  if (ota && has('miller-capacitor')) hit('OTA 2 étages Miller',r);
  // cascode mirror: a mirror whose devices each carry a cascode above/below
  if (st.mirrors.some(m=>m.refs.filter(x=>st.cascodes.some(c=>c.top===x||c.bottom===x)).length>=2)) hit('miroir cascode',r);
  if (has('inductive-degeneration')) hit('LNA à dégénérescence inductive',r);
  const Ls=p.components.filter(c=>c.prefix==='L');
  if (st.crossCoupled.some(cc=>{const [a,b]=cc.refs.map(x=>by.get(x)); return Ls.some(l=>l.nodes.includes(D(a))||l.nodes.includes(D(b)));})) hit('VCO LC à paire croisée',r);
  else if (st.crossCoupled.length) hit('autre paire croisée (sans L)',r);
  if (bjt.filter(q=>D(q)===G(q)||RAIL.test(D(q))&&RAIL.test(G(q))).length>=2) hit('bandgap / référence à BJT',r);
  if (has('latch')) hit('StrongARM (2 paires croisées opposées)',r);
  if (latchReading(p)) hit('verrou CML (gabarit fait)',r);
  if (has('source-follower')) hit('suiveur de source',r);
  if (has('ring')) hit('oscillateur en anneau',r);
  if (has('gilbert-quad')) hit('quad de Gilbert',r);
  if (has('cascade')) hit('cascade de paires (Cherry-Hooper…)',r);
  if (st.diffPairs.length && !ota) hit('paire diff. à charges passives',r);
  if (!st.diffPairs.length && has('common-source') ) hit('étage source commune seul',r);
}
console.log('circuits',n);
for (const [k,v] of Object.entries(cnt).sort((a,b)=>b[1]-a[1])) console.log(String(v).padStart(4), k, '|', Object.entries(fam[k]).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([f,c])=>f+' '+c).join(', '), '|', ex1[k].join(' '));
process.exit(0);
