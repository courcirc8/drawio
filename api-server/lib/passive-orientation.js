/** Geometry-only candidates. Selection must validate the saved drawing independently. */
import {parseDrawio,getPage,allCells,cellInfo,updateCell,serialize} from './model.js';
import {classify} from './components.js';
import {routePage,pinAbs} from './route.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';

export async function passiveOrientationCandidate(xml, ref, carrySupply = false) {
 const doc=parseDrawio(xml), model=getPage(doc), before=connectivityFingerprint(model);
 const cells=allCells(model).map(cellInfo), map=new Map(cells.map(c=>[c.id,c])), old=map.get(ref);
 if(!old || !['R','C','L'].includes(classify(old).prefix))throw new Error(`Not a passive: ${ref}`);
 const next={...old,flipH:!old.flipH};
 updateCell(model,ref,{style:{flipH:next.flipH?'1':'0'}});
 if(carrySupply)for(const e of cells.filter(c=>c.kind==='edge'&&(c.source===ref||c.target===ref))){
  const pre=e.source===ref?'exit':'entry', otherPre=pre==='exit'?'entry':'exit';
  const aux=map.get(e.source===ref?e.target:e.source), role=aux&&classify(aux).role;
  if(!['ground','power'].includes(role))continue;
  // Do not move a shared supply symbol: this proposal only owns a leaf terminal.
  if(cells.filter(c=>c.kind==='edge'&&(c.source===aux.id||c.target===aux.id)).length!==1)continue;
  const coords=[e.style.map.get(pre+'X'),e.style.map.get(pre+'Y'),e.style.map.get(otherPre+'X'),e.style.map.get(otherPre+'Y')];
  if(coords.some(v=>v==null||!Number.isFinite(Number(v))))continue;
  const [x,y,ax,ay]=coords.map(Number),p=pinAbs(next,{x,y}),a=pinAbs(aux,{x:ax,y:ay});
  updateCell(model,aux.id,{x:aux.x+p.x-a.x,y:aux.y+p.y+(role==='ground'?40:-40)-a.y});
 }
 await routePage(model,null,{});
 assertGeometryOnly(before,connectivityFingerprint(model),'passive orientation');
 return serialize(doc);
}

export function orientationRank(r){return [r.check.errors,r.check.crossings,r.gatePortJogs?.length||0,r.check.warnings];}
export function improvesOrientation(a,b){
 const aa=orientationRank(a),bb=orientationRank(b);
 if(![...aa,...bb].every(Number.isFinite))return false;
 for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return aa[i]<bb[i];
 return false;
}
