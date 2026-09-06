/** Geometric audit of stored wire polylines, independent of net-name/edge grouping.
 * Automatic mxGraph paths without explicit waypoints are reported as unevaluated.
 * This is a vector audit, not OCR and not a claim of pixel-level verification.
 */
import {allCells,cellInfo} from './model.js';
import {classify,activePins,identityOf,pinOrderFor} from './components.js';
import {connectivity} from './netlist.js';
import {pinAbs} from './route.js';
const EPS=0.6;
function onSegment(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<EPS*EPS)return Math.hypot(p.x-a.x,p.y-a.y)<=EPS;const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/l2;return t>=0&&t<=1&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<=EPS;}
export function auditVisibleConnectivity(model){
 const cells=allCells(model).map(cellInfo),byId=new Map(cells.map(c=>[c.id,c])),issues=[],unknown=[],lines=[],pins=[],dots=[],parent=new Map();
 const root=k=>{if(!parent.has(k))parent.set(k,k);let r=k;while(parent.get(r)!==r)r=parent.get(r);return r;};
 const join=(a,b)=>parent.set(root(a),root(b));
 for(const c of cells){
  if(c.kind!=='vertex')continue;const cls=classify(c);
  if(cls.role==='junction'){dots.push({x:c.x+c.w/2,y:c.y+c.h/2});continue;}
  for(const pin of activePins(cls)){
   const key=c.id+':'+pin.name,p=pinAbs(c,pin);root(key);
   pins.push({key,p,component:cls.role==='component',ref:identityOf(c),index:cls.mapping?pinOrderFor(cls).indexOf(pin.name):-1});
   if(['ground','power','port'].includes(cls.role))join(key,'global:'+String(cls.role==='ground'?'0':cls.net).toUpperCase());
  }
 }
 for(const e of cells.filter(c=>c.kind==='edge')){
  const src=byId.get(e.source),tgt=byId.get(e.target);
  if(!src||!tgt){unknown.push(e.id);continue;}
  const endpoint=(c,pref)=>{const x=Number(e.style.map.get(pref+'X')),y=Number(e.style.map.get(pref+'Y'));return e.style.map.has(pref+'X')&&e.style.map.has(pref+'Y')?pinAbs(c,{x,y}):{x:c.x+c.w/2,y:c.y+c.h/2};};
  const a=endpoint(src,'exit'),b=endpoint(tgt,'entry');
  if(!e.points?.length && Math.abs(a.x-b.x)>EPS && Math.abs(a.y-b.y)>EPS && e.style.map.get('edgeStyle')!=='none'){unknown.push(e.id);continue;}
  const pts=[a,...(e.points||[]),b];root('wire:'+e.id);
  for(let i=1;i<pts.length;i++)lines.push({a:pts[i-1],b:pts[i],key:'wire:'+e.id});
 }
 for(const pin of pins)for(const line of lines)if(onSegment(pin.p,line.a,line.b))join(pin.key,line.key);
 for(const dot of dots){const hit=lines.filter(l=>onSegment(dot,l.a,l.b));for(const line of hit.slice(1))join(hit[0].key,line.key);}
 for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
  const a=lines[i],b=lines[j];if(a.key===b.key)continue;
  const touching=[a.a,a.b].filter(p=>onSegment(p,b.a,b.b));
  if(!touching.length)continue;
  const common=touching.find(p=>Math.hypot(p.x-b.a.x,p.y-b.a.y)<=EPS||Math.hypot(p.x-b.b.x,p.y-b.b.y)<=EPS);
  if(common)join(a.key,b.key);
  // Positive-length overlap is visibly continuous even without a junction glyph.
  const overlap=touching.length===2&&Math.hypot(a.a.x-a.b.x,a.a.y-a.b.y)>EPS;
  if(overlap)join(a.key,b.key);
 }
 const expected=connectivity(model),groups=new Map(),wanted=new Map();
 for(const pin of pins.filter(p=>p.component)){
  const id=pin.ref+'.'+pin.index;
  for(const [map,key] of [[groups,root(pin.key)],[wanted,expected.netOf.get(pin.key)]]){if(!map.has(key))map.set(key,[]);map.get(key).push(id);}
 }
 const signatures=m=>[...m.values()].map(v=>v.sort().join(',')).sort();
 const actual=signatures(groups),reference=signatures(wanted),equal=JSON.stringify(actual)===JSON.stringify(reference);
 if(!equal)issues.push({code:'visible-partition-mismatch',visible:actual,document:reference});
 return {scope:'stored_vector_polylines_visible_pins',visible_connectivity_match:unknown.length?null:equal,
  evaluated_wires:new Set(lines.map(l=>l.key)).size,unevaluated_wires:unknown,issues,
  note:'Hidden terminals excluded. Automatic mxGraph routing requires rendered-path inspection; PNG visual review remains required.'};
}
