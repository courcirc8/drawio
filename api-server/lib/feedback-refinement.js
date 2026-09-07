/** Rules derived from visual annotations, selected by topology rather than circuit names. */
import {netTeeCandidate} from './net-tee.js';
import {parseDrawio,getPage} from './model.js';
import {cellsOf,genericProposals,localCandidate} from './generic-refinement.js';
import {classify,pinOrderFor} from './components.js';import {getPin} from './stencils.js';import {pinAbs,rotatedAabb,polylineOf,netGroups} from './route.js';import {mirrorGroups} from './gate-bus.js';
const pin=(c,i)=>pinAbs(c,getPin(classify(c).shape.key,pinOrderFor(classify(c))[i]));
const anchor=(e,c,which)=>pinAbs(c,{x:Number(e.style.map.get(which+'X')??.5),y:Number(e.style.map.get(which+'Y')??.5)});
export function feedbackPenalty(model,ref){const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),bodies=cs.filter(c=>classify(c).role==='component').map(rotatedAabb);let clearance=0,shortJogs=0,teeOffset=0;const nets=netGroups(cs);
 for(const c of cs.filter(c=>classify(c).role==='port')){const a=rotatedAabb(c);for(const b of bodies){const dx=Math.max(b.x-a.x-a.w,a.x-b.x-b.w,0),dy=Math.max(b.y-a.y-a.h,a.y-b.y-b.h,0);if(Math.hypot(dx,dy)<18)clearance++;}}
 for(const e of cs.filter(c=>c.kind==='edge')){const pl=polylineOf(e,map);if(!pl)continue;for(let i=1;i<pl.length;i++){const a=pl[i-1],b=pl[i],d=Math.hypot(a.x-b.x,a.y-b.y);if(d>.1&&d<25&&Math.abs(a.x-b.x)<.1)shortJogs++;}}
 let rowMisalignment=0;
 for(const g of mirrorGroups(model,ref).filter(g=>g.outputRefs.length===1)){const part=ref.components.find(c=>c.ref===g.referenceRefs[0]),drivers=ref.components.filter(c=>c.prefix==='M'&&!g.refs.includes(c.ref)&&c.nodes[0]===part.nodes[0]);if(drivers.length!==1)continue;const vv=g.refs.map(id=>map.get(id)),same=cs.filter(c=>classify(c).prefix==='M'&&/pmos/i.test(classify(c).shape.key)===(g.polarity==='P'));const y=g.polarity==='N'?Math.max(...same.map(c=>pin(c,2).y)):Math.min(...same.map(c=>pin(c,2).y));rowMisalignment+=vv.reduce((sum,c)=>sum+Math.abs(pin(c,2).y-y),0);}
 for(const port of cs.filter(c=>classify(c).role==='port')){const links=cs.filter(e=>e.kind==='edge'&&(e.source===port.id||e.target===port.id));if(links.length!==1)continue;const e=links[0],a=anchor(e,port,e.source===port.id?'exit':'entry'),ys=[];for(const w of cs.filter(w=>w.kind==='edge'&&w.id!==e.id&&nets.get(w.id)===nets.get(e.id))){const pl=polylineOf(w,map);for(let i=1;i<pl.length;i++)if(Math.abs(pl[i].y-pl[i-1].y)<.1&&Math.abs(pl[i].x-pl[i-1].x)>35&&Math.abs(pl[i].y-a.y)<=60)ys.push(pl[i].y);}if(ys.length&&Math.min(...ys.map(y=>Math.abs(y-a.y)))>.1)teeOffset++;}return {clearance,shortJogs,rowMisalignment,teeOffset};}
export function feedbackProposals(model,ref,loop){const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),edges=cs.filter(c=>c.kind==='edge'),ports=cs.filter(c=>classify(c).role==='port'),out=[];let seq=0;const add=(kind,moves)=>out.push({id:kind+'-'+(++seq),kind,moves});
 const carry=(moves)=>{const ids=new Set(moves.map(m=>m.id));for(const move of [...moves])for(const e of edges.filter(e=>e.source===move.id||e.target===move.id)){const id=e.source===move.id?e.target:e.source,c=map.get(id);if(c&&!ids.has(id)&&['ground','power'].includes(classify(c).role)&&edges.filter(e=>e.source===id||e.target===id).length===1){moves.push({id,dx:move.dx||0,dy:move.dy||0});ids.add(id);}}return moves;};
 if(loop===1||loop===2||loop===5){for(const p of ports){const links=edges.filter(e=>e.source===p.id||e.target===p.id);if(!links.length)continue;const a=anchor(links[0],p,links[0].source===p.id?'exit':'entry');
 const nets=netGroups(cs),own=nets.get(links[0].id),ys=new Set();for(const e of edges.filter(e=>nets.get(e.id)===own)){const pl=polylineOf(e,map);for(let i=1;i<pl.length;i++)if(Math.abs(pl[i].y-pl[i-1].y)<.1)ys.add(pl[i].y);}
 if(loop!==2)for(const y of ys)if(Math.abs(y-a.y)>.1)add('port-tee',[{id:p.id,dy:y-a.y}]);
 if(loop!==1&&links.length===1){const e=links[0],c=map.get(e.source===p.id?e.target:e.source);if(classify(c).prefix==='M'){const g=pin(c,1),b=anchor(e,c,e.source===c.id?'exit':'entry');if(Math.hypot(g.x-b.x,g.y-b.y)<.1){const side=Math.sign(g.x-pin(c,0).x);for(const gap of [24,36,50])add('gate-port-clearance',[{id:p.id,dx:g.x+side*gap-a.x,dy:g.y-a.y}]);}}}
 }}
 if(loop===3){for(const g of mirrorGroups(model,ref).filter(g=>g.outputRefs.length===1)){const vv=g.refs.map(id=>map.get(id));if(vv.some(v=>classify(v).prefix!=='M'))continue;
 const others=cs.filter(c=>classify(c).prefix==='M'&&!g.refs.includes(c.id)&&/pmos/i.test(classify(c).shape.key)===(g.polarity==='P'));const targets=others.length?[g.polarity==='N'?Math.max(...others.map(c=>pin(c,2).y)):Math.min(...others.map(c=>pin(c,2).y))]:[];
 for(const target of targets){const moves=vv.map(c=>({id:c.id,dy:target-pin(c,2).y}));if(moves.every(m=>Math.abs(m.dy)<1))continue;
 // Reference conduction column follows the device driving its drain, if unique.
 const refPart=ref.components.find(c=>c.ref===g.referenceRefs[0]),driver=ref.components.filter(c=>c.prefix==='M'&&!g.refs.includes(c.ref)&&c.nodes[0]===refPart.nodes[0]);
 if(driver.length!==1)continue;if(driver.length===1){const reference=map.get(refPart.ref),d=map.get(driver[0].ref),m=moves.find(m=>m.id===reference.id);m.dx=pin(d,0).x-pin(reference,0).x;const outputs=g.outputRefs.map(id=>map.get(id)),targetX=outputs.reduce((s,c)=>s+pin(c,0).x,0)/outputs.length;m.mirror=(pin(reference,1).x-pin(reference,0).x)*(targetX-pin(d,0).x)<0;}
 add('mirror-row',carry(moves));}
 }}
 if(loop===4){const passives=ref.components.filter(c=>['R','C','L'].includes(c.prefix));for(const part of passives){const c=map.get(part.ref);if(!c)continue;const adjacent=passives.filter(p=>p.ref!==part.ref&&p.nodes.some(n=>n!=='0'&&part.nodes.includes(n)));for(const other of adjacent){const v=map.get(other.ref);if(v&&Math.abs((v.rotation||0)%180)<.1){const y=pin(v,0).y,q={...c,rotation:0},a=pin(q,0);add('passive-chain-row',[{id:c.id,rotation:0,dy:y-a.y}]);}}
 }
 out.push(...genericProposals(model,ref,4));}
 if(loop===5){out.push(...genericProposals(model,ref,3));
 const pp=ref.components.filter(c=>['R','C','L'].includes(c.prefix));const seen=new Set();
 for(const p of pp){const chain=[p],ids=new Set([p.ref]);for(let k=0;k<chain.length;k++)for(const n of chain[k].nodes){const terms=ref.components.filter(c=>c.nodes.includes(n));if(terms.length!==2||n==='0')continue;for(const q of terms)if(['R','C','L'].includes(q.prefix)&&!ids.has(q.ref)){ids.add(q.ref);chain.push(q);}}
 const key=[...ids].sort().join('|');if(chain.length<2||seen.has(key))continue;seen.add(key);
 const ends=chain.flatMap(c=>c.nodes).filter(n=>chain.filter(c=>c.nodes.includes(n)).length===1);const mos=ref.components.filter(c=>c.prefix==='M'&&ends.includes(c.nodes[0]));
 for(const m of mos)for(const delta of [0,-30,30]){const y=pin(map.get(m.ref),0).y+delta;add('feedback-chain-level',chain.map(p=>{const c=map.get(p.ref),q={...c,rotation:0};return {id:p.ref,rotation:0,dy:y-pin(q,0).y};}));}
 }

 // Output shunts belong beside the amplifier output, not among its input components.
 for(const active of ref.components.filter(c=>['G','E'].includes(c.prefix))){const av=map.get(active.ref),output=active.nodes[0];if(!av)continue;for(const part of ref.components.filter(c=>['R','C'].includes(c.prefix)&&c.nodes.includes(output)&&c.nodes.includes('0'))){const v=map.get(part.ref),q={...v,rotation:90,flipH:false},near=part.nodes.indexOf(output),a=pin(q,near),target={x:av.x+av.w+100,y:av.y+av.h/2+65},dx=target.x-a.x,dy=target.y-a.y;const moves=[{id:v.id,dx,dy,rotation:90}];const ns=netGroups(cs),oe=edges.find(e=>(e.source===av.id||e.target===av.id)&&Math.hypot(anchor(e,av,e.source===av.id?'exit':'entry').x-pin(av,0).x,anchor(e,av,e.source===av.id?'exit':'entry').y-pin(av,0).y)<.1);if(oe)for(const p of ports){const pe=edges.find(e=>e.source===p.id||e.target===p.id);if(pe&&ns.get(pe.id)===ns.get(oe.id)&&p.x<target.x+90)moves.push({id:p.id,dx:target.x+90-p.x});}add('output-shunt',carry(moves));out.at(-1).shunt={ref:part.ref,near,driver:active.ref};}}
 }

 return out;
}

export function outputShuntCandidate(xml,proposal){const moved=localCandidate(xml,proposal),cs=cellsOf(getPage(parseDrawio(moved))),r=cs.find(c=>c.id===proposal.shunt.ref),g=cs.find(c=>c.id===proposal.shunt.driver),a=pin(r,proposal.shunt.near),e=cs.find(e=>e.kind==='edge'&&(e.source===r.id||e.target===r.id)&&Math.hypot(anchor(e,r,e.source===r.id?'exit':'entry').x-a.x,anchor(e,r,e.source===r.id?'exit':'entry').y-a.y)<.1);return netTeeCandidate(moved,{moves:[{id:r.id}],edgeId:e.id,teeY:pin(g,0).y});}
