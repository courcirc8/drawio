import {parseDrawio,getPage,allCells,cellInfo,updateCell,serialize} from './model.js';
import {classify,pinOrderFor} from './components.js';import {getPin} from './stencils.js';
import {pinAbs,routePage} from './route.js';import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
export function tailFilters(parsed){
 const out=[];for(const l of parsed.components.filter(c=>c.prefix==='L'))for(const i of [0,1]){
  const shared=l.nodes[i],tail=l.nodes[1-i];
  if(parsed.components.filter(c=>c.prefix==='M'&&c.nodes[2]===shared).length<2)continue;
  const m=parsed.components.find(c=>c.prefix==='M'&&c.nodes[0]===tail),cap=parsed.components.find(c=>c.prefix==='C'&&c.nodes.includes(shared)&&c.nodes.includes('0'));
  if(m&&cap)out.push({inductor:l.ref,sharedPin:i,tail:m.ref,capacitor:cap.ref,capSharedPin:cap.nodes.indexOf(shared)});
 }return out;
}
export async function tailFilterCandidate(xml,pattern,offset=150,gap=50){
 const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model),cells=allCells(model).map(cellInfo),map=new Map(cells.map(c=>[c.id,c]));
 const point=(c,i)=>{const cl=classify(c);return pinAbs(c,getPin(cl.shape.key,pinOrderFor(cl)[i]));};
 const l=map.get(pattern.inductor),m=map.get(pattern.tail),cap=map.get(pattern.capacitor);
 const top=point(l,pattern.sharedPin),bottom=point(l,1-pattern.sharedPin);
 if(top.y>=bottom.y||Math.abs(top.x-bottom.x)>.01)throw new Error('Requires vertical inductor with shared node above tail');
 const shifted=new Set();
 const move=(c,dx,dy)=>{updateCell(model,c.id,{x:c.x+dx,y:c.y+dy});shifted.add(c.id);const label=map.get('LBL_'+c.id);if(label)updateCell(model,label.id,{x:label.x+dx,y:label.y+dy});};
 const cp=point(cap,pattern.capSharedPin),mp=point(m,0),cd={x:top.x+offset-cp.x,y:top.y-cp.y},md={x:bottom.x-mp.x,y:bottom.y+gap-mp.y};
 move(cap,cd.x,cd.y);move(m,md.x,md.y);
 // Carry only leaf auxiliaries owned by the moved devices.
 for(const [owner,delta] of [[cap,cd],[m,md]])for(const e of cells.filter(c=>c.kind==='edge'&&(c.source===owner.id||c.target===owner.id))){
  const aux=map.get(e.source===owner.id?e.target:e.source);if(!aux||shifted.has(aux.id)||!['ground','power','port'].includes(classify(aux).role))continue;
  if(cells.filter(c=>c.kind==='edge'&&(c.source===aux.id||c.target===aux.id)).length!==1)continue;
  move(aux,delta.x,delta.y);
 }
 await routePage(model,null,{});assertGeometryOnly(before,connectivityFingerprint(model),'tail filter branch');return serialize(doc);
}
