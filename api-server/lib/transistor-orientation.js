import {parseDrawio,getPage,allCells,cellInfo,updateCell,serialize} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {routePage,pinAbs} from './route.js';
import {mirrorAboutConductionAxis} from './signal-alignment.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';

/** Reflect the gate about the fixed conduction axis, carrying the owner label. */
export async function transistorOrientationCandidate(xml, ref) {
 const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model);
 const cells=allCells(model).map(cellInfo),old=cells.find(c=>c.id===ref),cl=old&&classify(old);
 if(cl?.prefix!=='M')throw new Error(`Not a MOS: ${ref}`);
 const order=pinOrderFor(cl),next=mirrorAboutConductionAxis(old,getPin(cl.shape.key,order[0]),getPin(cl.shape.key,order[2]));
 updateCell(model,ref,{x:next.x,y:next.y,style:{flipH:next.flipH?'1':'0'}});
 const label=cells.find(c=>c.id==='LBL_'+ref);
 if(label)updateCell(model,label.id,{x:label.x+next.x-old.x,y:label.y+next.y-old.y});
 await routePage(model,null,{});
 assertGeometryOnly(before,connectivityFingerprint(model),'MOS orientation');
 return serialize(doc);
}

/** Open a vertical channel between a two-MOS mirror, then face its gates inward. */
export async function spacedMirrorCandidate(xml, refs, extraGap = 40) {
 const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model);
 let cells=allCells(model).map(cellInfo);
 const pin=(c,i)=>{const cl=classify(c);return getPin(cl.shape.key,pinOrderFor(cl)[i]);};
 const pair=refs.map(ref=>cells.find(c=>c.id===ref));
 if(pair.length!==2||pair.some(c=>!c||classify(c).prefix!=='M'||(c.rotation||0)%180!==0))throw new Error('Requires two vertical MOS');
 const axis=c=>pinAbs(c,pin(c,0)).x;
 pair.sort((a,b)=>axis(a)-axis(b));
 const [left,right]=pair,cut=(axis(left)+axis(right))/2;
 if(axis(right)-axis(left)<1)throw new Error('Coincident conduction axes');
 const width=left.w+right.w+extraGap,dx=Math.max(0,width-(axis(right)-axis(left)));
 // Components follow their conduction column, auxiliaries follow their centre.
 const moved=new Set();
 for(const c of cells){
  if(c.kind!=='vertex'||c.id.startsWith('LBL_')||classify(c).role==='junction')continue;
  const x=classify(c).prefix==='M'?axis(c):c.x+c.w/2;
  if(x<=cut)continue;
  updateCell(model,c.id,{x:c.x+dx});moved.add(c.id);
 }
 for(const c of cells.filter(c=>c.id.startsWith('LBL_')&&moved.has(c.id.slice(4))))updateCell(model,c.id,{x:c.x+dx});
 cells=allCells(model).map(cellInfo);
 for(const [index,ref] of pair.map(c=>c.id).entries()){
  const old=cells.find(c=>c.id===ref),g=pinAbs(old,pin(old,1)).x,d=axis(old);
  if(index===0?g>d:g<d)continue;
  const next=mirrorAboutConductionAxis(old,pin(old,0),pin(old,2));
  updateCell(model,ref,{x:next.x,y:next.y,style:{flipH:next.flipH?'1':'0'}});
  const label=cells.find(c=>c.id==='LBL_'+ref);
  if(label)updateCell(model,label.id,{x:label.x+next.x-old.x,y:label.y+next.y-old.y});
 }
 // Re-centre labels previously displaced by the old crowded layout.
 const finalCells=allCells(model).map(cellInfo);
 for(const ref of refs){const owner=finalCells.find(c=>c.id===ref),label=finalCells.find(c=>c.id==='LBL_'+ref);
  if(label)updateCell(model,label.id,{x:owner.x+(owner.w-label.w)/2,y:owner.y+owner.h+4});
 }
 await routePage(model,null,{});
 assertGeometryOnly(before,connectivityFingerprint(model),'spaced MOS mirror');
 return serialize(doc);
}
