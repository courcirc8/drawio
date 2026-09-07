/** One horizontal distribution trunk per homogeneous current-mirror gate net. */
import {parseDrawio,getPage,serialize,allCells,cellInfo,updateCell} from './model.js';
import {mirrorAboutConductionAxis} from './signal-alignment.js';
import {classify,pinOrderFor} from './components.js';import {getPin} from './stencils.js';
import {pinAbs,netGroups,polylineOf} from './route.js';import {rebuildLocalDots} from './generic-refinement.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
const cells=m=>allCells(m).map(cellInfo);
const pin=(c,i)=>pinAbs(c,getPin(classify(c).shape.key,pinOrderFor(classify(c))[i]));
const anchor=(e,c,which)=>{const pre=which||(e.source===c.id?'exit':'entry');return pinAbs(c,{x:Number(e.style.map.get(pre+'X')??.5),y:Number(e.style.map.get(pre+'Y')??.5)});};
export function mirrorGroups(model,reference){const cs=cells(model),map=new Map(cs.map(c=>[c.id,c])),nets=new Map();
 for(const m of reference.components.filter(c=>c.prefix==='M')){if(!map.has(m.ref))continue;const g=m.nodes[1];if(!nets.has(g))nets.set(g,[]);nets.get(g).push(m);}
 const out=[];
 for(const [net,mos] of nets){if(mos.length<2||!mos.some(m=>m.nodes[0]===net))continue;
 const vv=mos.map(m=>map.get(m.ref));if(vv.some(v=>(v.rotation||0)%180!==0))continue;
 const polar=vv.map(v=>/pmos/i.test(classify(v).shape.key)?'P':'N');if(new Set(polar).size!==1)continue;
 out.push({net,refs:mos.map(m=>m.ref),referenceRefs:mos.filter(m=>m.nodes[0]===net).map(m=>m.ref),outputRefs:mos.filter(m=>m.nodes[0]!==net).map(m=>m.ref),polarity:polar[0],gateY:vv.map(v=>pin(v,1).y)});
 }return out;
}
export function mirrorGateGroups(model,reference){return mirrorGroups(model,reference).filter(g=>g.outputRefs.length>1);}
/** Orient diode-connected references toward the output conduction columns. */
export function orientMirrorReferences(model,group){const cs=cells(model),map=new Map(cs.map(c=>[c.id,c])),changed=[];
 const outputs=group.outputRefs.map(id=>map.get(id));if(!outputs.length)return changed;
 for(const id of group.referenceRefs){const c=map.get(id),d=pin(c,0),g=pin(c,1),target=outputs.reduce((sum,o)=>sum+pin(o,0).x,0)/outputs.length;
 if(Math.abs(target-d.x)<.1||(g.x-d.x)*(target-d.x)>0)continue;
 const cl=classify(c),order=pinOrderFor(cl),next=mirrorAboutConductionAxis(c,getPin(cl.shape.key,order[0]),getPin(cl.shape.key,order[2]));
 updateCell(model,id,{x:next.x,y:next.y,style:{flipH:next.flipH?'1':'0'}});
 const label=map.get('LBL_'+id);if(label)updateCell(model,label.id,{x:label.x+next.x-c.x});changed.push(id);
 }return changed;
}
export function gateBusCandidates(model,group){const map=new Map(cells(model).map(c=>[c.id,c])),vv=group.refs.map(id=>map.get(id)),sign=group.polarity==='N'?-1:1,gate=sign<0?Math.min(...group.gateY):Math.max(...group.gateY),body=sign<0?Math.min(...vv.map(c=>c.y)):Math.max(...vv.map(c=>c.y+c.h));
 return [...new Set([24,40,60,80,100,130].map(d=>gate+sign*d).concat([24,40,60].map(d=>body+sign*d)))].map((y,i)=>({id:i,y,group}));
}
export function gateBusCandidate(xml,proposal){if(proposal.group.outputRefs.length<2)throw Error('Bus requires at least two mirror outputs');const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model),cs=cells(model),map=new Map(cs.map(c=>[c.id,c])),groups=netGroups(cs),gateKeys=new Set();
 for(const ref of proposal.group.refs){const c=map.get(ref),g=pin(c,1);for(const e of cs.filter(e=>e.kind==='edge'&&(e.source===ref||e.target===ref))){const a=anchor(e,c);if(Math.hypot(a.x-g.x,a.y-g.y)<.1)gateKeys.add(groups.get(e.id));}}
 if(gateKeys.size!==1)throw Error('Mirror gate net is not a single connected group');const net=[...gateKeys][0],wires=cs.filter(c=>c.kind==='edge'&&groups.get(c.id)===net),ids=new Set(wires.flatMap(e=>[e.source,e.target]));
 for(const id of ids){const c=map.get(id),role=classify(c).role;if(['port','junction'].includes(role)){const links=cs.filter(e=>e.kind==='edge'&&(e.source===id||e.target===id));if(links.some(e=>groups.get(e.id)!==net))continue;const a=anchor(links[0],c);updateCell(model,id,{y:c.y+proposal.y-a.y});}}
 const oriented=orientMirrorReferences(model,proposal.group);
 const current=new Map(cells(model).map(c=>[c.id,c]));
 const gatePoints=proposal.group.refs.map(id=>pin(current.get(id),1));
 const escape=(e,id,which)=>{const c=current.get(id),a=anchor(e,c,which),cl=classify(c);if(cl.prefix==='M'){const g=pin(c,1),d=pin(c,0);if(Math.hypot(a.x-g.x,a.y-g.y)<.1){const side=g.x<d.x?-1:1,near=gatePoints.filter(p=>Math.abs(p.y-g.y)<.1&&(p.x-g.x)*side>0).map(p=>Math.abs(p.x-g.x));const step=Math.min(24,...near.map(d=>d/3));return [a,{x:a.x+side*step,y:a.y}];}}
 // Other terminals connect vertically to the same trunk; no arbitrary secondary bus.
 return [a];};
 for(const e of wires){const a=escape(e,e.source,'exit'),b=escape(e,e.target,'entry'),p=[...a,{x:a.at(-1).x,y:proposal.y},{x:b.at(-1).x,y:proposal.y},...b.reverse()],clean=[];for(const q of p)if(!clean.length||Math.hypot(q.x-clean.at(-1).x,q.y-clean.at(-1).y)>.01)clean.push(q);updateCell(model,e.id,{points:clean.slice(1,-1),style:{drawioApiGateBus:proposal.group.polarity,drawioApiGateBusY:String(proposal.y)}});}
 // Regenerate only the decorations of this net; preserve every other net's dots.
 const onPolyline=(p,pl)=>pl?.slice(1).some((b,i)=>{const a=pl[i],dx=b.x-a.x,dy=b.y-a.y,L=dx*dx+dy*dy;if(!L)return false;const t=((p.x-a.x)*dx+(p.y-a.y)*dy)/L;return t>=0&&t<=1&&Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<.2;});
 const oldPolys=wires.map(e=>polylineOf(e,map));const saved=allCells(model).filter(el=>{const c=cellInfo(el);return c.style.map.get('contactDot')==='1'&&!oldPolys.some(pl=>onPolyline({x:c.x+c.w/2,y:c.y+c.h/2},pl));}).map(el=>el.cloneNode(true));
 rebuildLocalDots(model);const finalMap=new Map(cells(model).map(c=>[c.id,c])),newPolys=wires.map(e=>polylineOf(finalMap.get(e.id),finalMap));let seq=0;
 for(const el of allCells(model)){const c=cellInfo(el);if(c.style.map.get('contactDot')!=='1')continue;if(!newPolys.some(pl=>onPolyline({x:c.x+c.w/2,y:c.y+c.h/2},pl)))el.parentNode.removeChild(el);else el.setAttribute('id','BUS_DOT_'+(++seq)+'_'+proposal.group.refs.join('_'));}
 for(const el of saved)model.getElementsByTagName('root')[0].appendChild(el);
 assertGeometryOnly(before,connectivityFingerprint(model),'single mirror gate bus');
 const after=new Map(cells(model).map(c=>[c.id,c]));for(const c of cs.filter(c=>classify(c).role==='component')){const a=after.get(c.id);if(oriented.includes(c.id)){for(const i of [0,2])if(Math.hypot(pin(a,i).x-pin(c,i).x,pin(a,i).y-pin(c,i).y)>.01)throw Error('Reference conduction axis moved');}else if(a.x!==c.x||a.y!==c.y||a.flipH!==c.flipH||a.rotation!==c.rotation)throw Error('Gate bus pass moved a component');}
 for(const e of cs.filter(c=>c.kind==='edge'&&!wires.some(w=>w.id===c.id)))if(JSON.stringify(e.points)!==JSON.stringify(after.get(e.id).points))throw Error('Unrelated net changed');
 return serialize(doc);
}
