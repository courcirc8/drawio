import {parseDrawio,getPage,allCells,cellInfo,updateCell,serialize} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {routePage} from './route.js';
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
