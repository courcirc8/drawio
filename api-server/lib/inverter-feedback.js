/** Recognize complementary inverter plus parallel passive feedback paths, without names/values. */
import {parseDrawio,getPage,serialize,updateCell} from './model.js';import {cellsOf,rebuildLocalDots} from './generic-refinement.js';import {classify,pinOrderFor} from './components.js';import {getPin} from './stencils.js';import {pinAbs} from './route.js';import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
const pin=(c,i)=>pinAbs(c,getPin(classify(c).shape.key,pinOrderFor(classify(c))[i]));
export function inverterFeedbackGroups(model,ref){const cs=new Map(cellsOf(model).map(c=>[c.id,c])),mos=ref.components.filter(c=>c.prefix==='M'),pass=ref.components.filter(c=>['R','C','L'].includes(c.prefix)),out=[];
 for(let i=0;i<mos.length;i++)for(let j=i+1;j<mos.length;j++){const a=mos[i],b=mos[j];if(a.nodes[0]!==b.nodes[0]||a.nodes[1]!==b.nodes[1]||a.nodes[2]===b.nodes[2])continue;const pa=/pmos/i.test(classify(cs.get(a.ref)).shape.key),pb=/pmos/i.test(classify(cs.get(b.ref)).shape.key);if(pa===pb)continue;const [dn,gn]=a.nodes,paths=[];
 function walk(net,used,path){if(net===dn){paths.push(path);return;}if(path.length>6)return;for(const p of pass.filter(p=>p.nodes.includes(net)&&!used.has(p.ref))){const next=p.nodes[p.nodes[0]===net?1:0];if(next==='0')continue;if(next!==dn&&ref.components.filter(c=>c.nodes.includes(next)).length!==2)continue;walk(next,new Set([...used,p.ref]),[...path,{ref:p.ref,near:p.nodes[0]===net?0:1}]);}}walk(gn,new Set(),[]);
 if(paths.length<2||!paths.some(p=>p.length>1))continue;out.push({p:pa?a:b,n:pa?b:a,gn,dn,paths});}return out;}
export function inverterFeedbackCandidate(xml,proposal,ref){const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model),initial=cellsOf(model),map=new Map(initial.map(c=>[c.id,c])),g=proposal.group,scale=proposal.spacing||1,terminal=new Map(),hub=new Map(),h=(net)=>hub.get(net);const X=260,R=860*scale;hub.set(g.gn,{x:X,y:500});hub.set(g.dn,{x:R,y:500});
 function move(id,patch){const c=map.get(id);updateCell(model,id,patch);const label=map.get('LBL_'+id);if(label)updateCell(model,label.id,{x:label.x+(patch.x??c.x)-c.x,y:label.y+(patch.y??c.y)-c.y});}
 for(const [part,y] of [[g.p,100],[g.n,300]]){move(part.ref,{x:600*scale,y,style:{flipH:'0'}});}
 let current=()=>new Map(cellsOf(model).map(c=>[c.id,c]));
 function put(part,near,point,rotation){const c=current().get(part.ref),q={...c,rotation,flipH:false},p=pin(q,near);move(c.id,{x:q.x+point.x-p.x,y:q.y+point.y-p.y,rotation,style:{flipH:'0'}});}
 // Keep each passive feedback path on its own horizontal row.
 const placed=new Set([g.p.ref,g.n.ref]);g.paths.sort((a,b)=>a.length-b.length);
 for(let k=0;k<g.paths.length;k++){const path=g.paths[k],y=500+k*140,start=X+90,step=(R-X-180)/path.length;for(let i=0;i<path.length;i++){const item=path[i],part=ref.components.find(c=>c.ref===item.ref);put(part,item.near,{x:start+i*step,y},0);placed.add(part.ref);const c=current().get(part.ref),n0=part.nodes[item.near],n1=part.nodes[1-item.near];if(n0!==g.gn&&!hub.has(n0))hub.set(n0,pin(c,item.near));if(n1!==g.dn&&!hub.has(n1))hub.set(n1,pin(c,1-item.near));}}
 for(const part of ref.components.filter(c=>['R','C','L'].includes(c.prefix)&&!placed.has(c.ref)&&c.nodes.includes('0'))){const net=part.nodes.find(n=>n!=='0');if(!hub.has(net))continue;put(part,part.nodes.indexOf(net),{x:h(net).x,y:740},90);placed.add(part.ref);}
 if(ref.components.some(c=>!placed.has(c.ref)))throw Error('Unrecognized extra component in inverter feedback pattern');
 const cs=current(),edges=initial.filter(c=>c.kind==='edge');
 // Route each active terminal outward first, then toward its net's shared trunk.
 for(const part of [g.p,g.n]){const c=cs.get(part.ref),d=pin(c,0),gate=pin(c,1);terminal.set(part.ref+':0',[d,{x:760*scale,y:d.y},{x:760*scale,y:255},{x:R,y:255},h(g.dn)]);terminal.set(part.ref+':1',[gate,{x:540*scale,y:gate.y},{x:540*scale,y:255},{x:X,y:255},h(g.gn)]);}
 for(const e of edges){for(const [id,which] of [[e.source,'exit'],[e.target,'entry']]){const c=cs.get(id);if(['ground','power'].includes(classify(c).role)){const other=cs.get(e.source===id?e.target:e.source),otherWhich=e.source===id?'entry':'exit',p=pinAbs(other,{x:Number(e.style.map.get(otherWhich+'X')),y:Number(e.style.map.get(otherWhich+'Y'))}),a=pinAbs(c,{x:Number(e.style.map.get(which+'X')),y:Number(e.style.map.get(which+'Y'))});move(id,{x:c.x+p.x-a.x,y:c.y+(classify(c).role==='ground'?p.y+55:p.y-55)-a.y});}else if(classify(c).role==='port'){const a=pinAbs(c,{x:Number(e.style.map.get(which+'X')),y:Number(e.style.map.get(which+'Y'))});move(id,{x:c.x+R+110-a.x,y:c.y+255-a.y});}}}
 const final=current();
 function path(id,e,which){const c=final.get(id),a=pinAbs(c,{x:Number(e.style.map.get(which+'X')),y:Number(e.style.map.get(which+'Y'))}),part=ref.components.find(p=>p.ref===id);if(!part)return [a];let i=pinOrderFor(classify(c)).findIndex((_,i)=>Math.hypot(pin(c,i).x-a.x,pin(c,i).y-a.y)<.1);const special=terminal.get(id+':'+i);if(special)return special;const dest=h(part.nodes[i]);if(!dest)return [a];return [a,{x:dest.x,y:a.y},dest];}
 for(const e of edges){const a=path(e.source,e,'exit'),b=path(e.target,e,'entry');let p;
 if(a.length===1&&b.length===1)p=[a[0],{x:a[0].x,y:b[0].y},b[0]];
 else if(a.length===1)p=[a[0],{x:b.at(-1).x,y:a[0].y},...b.slice().reverse()];
 else if(b.length===1)p=[...a,{x:a.at(-1).x,y:b[0].y},b[0]];
 else p=[...a,...b.slice().reverse()];const clean=[];for(const q of p){if(clean.length&&Math.hypot(clean.at(-1).x-q.x,clean.at(-1).y-q.y)<.01)continue;clean.push(q);}updateCell(model,e.id,{points:clean.slice(1,-1)});}
 rebuildLocalDots(model);assertGeometryOnly(before,connectivityFingerprint(model),'inverter feedback lanes');return serialize(doc);}
