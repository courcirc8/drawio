/** User drawing rules: align actual pins; mirror MOS around their D/S axis.
 * This pass proposes geometry only. Candidate selection must still check saved
 * documentary AND visible connectivity after rerouting. */
import {allCells,cellInfo,updateCell} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {pinAbs,rotatedAabb} from './route.js';

export function mirrorAboutConductionAxis(cell, drainPin, sourcePin) {
 const d=pinAbs(cell,drainPin),s=pinAbs(cell,sourcePin);
 const next={...cell,flipH:!cell.flipH};
 const nd=pinAbs(next,drainPin),ns=pinAbs(next,sourcePin);
 const dx=d.x-nd.x,dy=d.y-nd.y;
 if(Math.hypot(ns.x+dx-s.x,ns.y+dy-s.y)>.01)throw new Error('Mirror cannot preserve both conduction terminals');
 next.x+=dx;next.y+=dy;return next;
}
export function alignSignalPaths(model,parsed) {
 const cells=allCells(model).map(cellInfo),byId=new Map(cells.map(c=>[c.id,c]));
 const edges=cells.filter(c=>c.kind==='edge'),vertices=cells.filter(c=>c.kind==='vertex');
 const comps=parsed.components;
 const terms=new Map();for(const c of comps)for(const [i,n] of c.nodes.entries()){
  if(c.prefix==='M'&&i>2)continue;
  if(!terms.has(n))terms.set(n,[]);terms.get(n).push({c,i});
 }
 const ports=vertices.filter(c=>classify(c).role==='port');
 const report={mirrored:[],series:[],ports:[],skipped:[]};
 const alignedPorts=new Set();
 const rel=(e,id)=>{const pre=e.source===id?'exit':'entry';return {x:Number(e.style.map.get(pre+'X')),y:Number(e.style.map.get(pre+'Y'))};};
 const pin=(c,i)=>{const cl=classify(c),po=pinOrderFor(cl);return cl.shape&&po?.[i]?getPin(cl.shape.key,po[i]):null;};
 const collides=(proposed,ignored=new Set())=>{
  const changes=new Map(proposed.map(c=>[c.id,c]));
  return proposed.some(c=>{
   const a=rotatedAabb(c);
   return vertices.some(v=>{
    if(v.id===c.id||v.id==='LBL_'+c.id||c.id==='LBL_'+v.id||ignored.has(v.id)||['junction','ground','power'].includes(classify(v).role))return false;
    const b=rotatedAabb(changes.get(v.id)||v);
    return a.x<b.x+b.w+5&&a.x+a.w>b.x-5&&a.y<b.y+b.h+5&&a.y+a.h>b.y-5;
   });
  });
 };
 const commit=proposed=>{for(const p of proposed){updateCell(model,p.id,{x:p.x,y:p.y,rotation:p.rotation,style:{flipH:p.flipH?'1':'0',flipV:p.flipV?'1':'0'}});Object.assign(byId.get(p.id),p);}};
 // A gate fed by passive input/bias branches faces those branches as a group.
 // Do not reinterpret cross-coupled or shared transistor-gate networks.
 for(const c of comps.filter(c=>c.prefix==='M')){
  const m=byId.get(c.ref);if(!m||m.rotation%180!==0)continue;
  const others=(terms.get(c.nodes[1])||[]).filter(t=>t.c.ref!==c.ref);
  if(!others.length||others.some(t=>!['R','C','L'].includes(t.c.prefix)))continue;
  const points=others.map(t=>{const v=byId.get(t.c.ref),p=v&&pin(v,t.i);return p?pinAbs(v,p):null;}).filter(Boolean);
  if(!points.length)continue;
  const dp=pin(m,0),sp=pin(m,2),gp=pin(m,1);if(!dp||!sp||!gp)continue;
  const axis=pinAbs(m,dp).x,g=pinAbs(m,gp),mean=points.reduce((sum,p)=>sum+p.x,0)/points.length;
  if(Math.abs(mean-axis)<20||(mean-axis)*(g.x-axis)>=0)continue;
  const next=mirrorAboutConductionAxis(m,dp,sp);
  let proposed=[next];
  if(collides(proposed)){
   // Make room for the mirrored body by carrying only externally terminated
   // passive branches. Feedback branches and shared nets remain untouched.
   let movable=true;
   for(const t of others){
    const far=t.c.nodes[1-t.i],port=ports.find(p=>String(p.value).toLowerCase()===far.toLowerCase());
    const v=byId.get(t.c.ref);
    if(!v||!port||(terms.get(far)||[]).length!==1){movable=false;break;}
    const dx=next.x-m.x;proposed.push({...v,x:v.x+dx},{...port,x:port.x+dx});
   }
   if(!movable)continue;
  }
  if(!collides(proposed)){commit(proposed);report.mirrored.push(c.ref);}
 }
 // Follow a gate's unbranched passive chain to an external port.
 for(const c of comps.filter(c=>c.prefix==='M')){
  const mos=byId.get(c.ref);if(!mos||mos.rotation%180!==0)continue;
  let net=c.nodes[1],previous=c.ref;const chain=[],seen=new Set([previous]);let port=null;
  while(chain.length<8){
   const tt=terms.get(net)||[],others=tt.filter(t=>t.c.ref!==previous);
   const pp=ports.filter(p=>String(p.value).toLowerCase()===net.toLowerCase());
   if(!others.length&&pp.length===1){port=pp[0];break;}
   if(others.length!==1||tt.length!==2)break;
   const {c:k,i}=others[0];if(!['R','C','L'].includes(k.prefix)||seen.has(k.ref))break;
   chain.push({c:k,near:i});seen.add(k.ref);previous=k.ref;net=k.nodes[1-i];
  }
  if(!port)continue;
  const dp=pin(mos,0),gp=pin(mos,1),sp=pin(mos,2);if(!dp||!gp||!sp)continue;
  const axis=pinAbs(mos,dp).x,side=port.x+port.w/2>=axis?1:-1;
  let next={...mos};const gate=pinAbs(next,gp);
  if((gate.x>=axis?1:-1)!==side)next=mirrorAboutConductionAxis(next,dp,sp);
  let cursor=pinAbs(next,gp);const proposed=[next];let valid=true;
  for(const item of chain){
   const old=byId.get(item.c.ref);if(!old){valid=false;break;}
   const a=pin(old,item.near),b=pin(old,1-item.near);if(!a||!b){valid=false;break;}
   const p={...old,rotation:0,flipV:false,flipH:(a.x<b.x)?side<0:side>0};
   let aa=pinAbs(p,a),bb=pinAbs(p,b);
   if(Math.abs(aa.y-bb.y)>.1){valid=false;break;}
   p.x+=cursor.x+side*42-aa.x;p.y+=cursor.y-aa.y;
   cursor=pinAbs(p,b);proposed.push(p);
  }
  const links=edges.filter(e=>e.source===port.id||e.target===port.id);
  if(!valid||links.length!==1)continue;
  const pp={...port},rp=rel(links[0],port.id),ap=pinAbs(pp,rp);
  if(!Number.isFinite(ap.x+ap.y))continue;
  pp.x+=cursor.x+side*46-ap.x;pp.y+=cursor.y-ap.y;proposed.push(pp);
  if(collides(proposed)){report.skipped.push({ref:c.ref,reason:'occupied gate chain'});continue;}
  const flipped=next.flipH!==mos.flipH;
  commit(proposed);alignedPorts.add(port.id);
  if(flipped)report.mirrored.push(c.ref);
  if(chain.length)report.series.push(chain.map(k=>k.c.ref));
 }
 // AC-coupled output chain: drain -> series passives -> named output,
 // with rail-connected shunts below the horizontal signal line.
 for(const c of comps.filter(c=>c.prefix==='M')){
  const mos=byId.get(c.ref),dp=mos&&pin(mos,0);if(!dp)continue;
  const drain=pinAbs(mos,dp);
  const walk=(net,previous,chain,seen)=>{
   const port=ports.find(p=>/^(OUT|VOUT)(?:[PMN]|\d|_|$)/i.test(String(p.value))&&String(p.value).toLowerCase()===net.toLowerCase());
   if(port&&chain.length>=2)return {chain,net,port};
   if(chain.length>=6)return null;
   for(const t of terms.get(net)||[]){
    const k=t.c;if(k.ref===previous||seen.has(k.ref)||!['C','L','R'].includes(k.prefix))continue;
    if(!chain.length&&k.prefix!=='C')continue;
    const next=k.nodes[1-t.i];if(/^(0|gnd|vdd|vss|vcc)$/i.test(next))continue;
    // Intermediate nodes must be unbranched; only the output can have shunts.
    if(chain.length&&(terms.get(net)||[]).length!==2)continue;
    const found=walk(next,k.ref,[...chain,{c:k,near:t.i}],new Set([...seen,k.ref]));if(found)return found;
   }
   return null;
  };
  const found=walk(c.nodes[0],c.ref,[],new Set([c.ref]));if(!found)continue;
  const proposed=[];let cursor={x:drain.x,y:drain.y-40},valid=true;
  for(const item of found.chain){
   const old=byId.get(item.c.ref),a=old&&pin(old,item.near),b=old&&pin(old,1-item.near);if(!a||!b){valid=false;break;}
   const next={...old,rotation:0,flipH:a.x>b.x,flipV:false};
   const aa=pinAbs(next,a),bb=pinAbs(next,b);if(Math.abs(aa.y-bb.y)>.01){valid=false;break;}
   next.x+=cursor.x+42-aa.x;next.y+=cursor.y-aa.y;cursor=pinAbs(next,b);proposed.push(next);
  }
  if(!valid)continue;
  const last=found.chain.at(-1).c.ref;
  const shunts=(terms.get(found.net)||[]).filter(t=>t.c.ref!==last);
  if(shunts.some(t=>!['C','R'].includes(t.c.prefix)||t.c.nodes[1-t.i]!=='0'))continue;
  let sx=cursor.x+54;
  for(const t of shunts){
   const old=byId.get(t.c.ref),near=old&&pin(old,t.i),far=old&&pin(old,1-t.i);if(!near||!far){valid=false;break;}
   const next={...old,rotation:near.x<far.x?90:-90,flipH:false,flipV:false};
   const a=pinAbs(next,near);next.x+=sx-a.x;next.y+=cursor.y+42-a.y;proposed.push(next);
   const b=pinAbs(next,far);
   const groundEdge=edges.find(e=>(e.source===old.id&&classify(byId.get(e.target)||{}).role==='ground')||(e.target===old.id&&classify(byId.get(e.source)||{}).role==='ground'));
   if(groundEdge){const g=byId.get(groundEdge.source===old.id?groundEdge.target:groundEdge.source),ng={...g},ap=pinAbs(ng,rel(groundEdge,g.id));ng.x+=b.x-ap.x;ng.y+=b.y+36-ap.y;proposed.push(ng);}
   sx+=140;
  }
  const port=found.port,links=edges.filter(e=>e.source===port.id||e.target===port.id);if(!valid||links.length!==1)continue;
  const pp={...port},ap=pinAbs(pp,rel(links[0],port.id));pp.x+=sx+24-ap.x;pp.y+=cursor.y-ap.y;proposed.push(pp);
  // Separate text cells follow the components they annotate.
  for(const next of [...proposed]){const old=byId.get(next.id),label=byId.get('LBL_'+next.id);if(label)proposed.push({...label,x:label.x+next.x-old.x,y:label.y+next.y-old.y});}
  if(collides(proposed)){report.skipped.push({ref:c.ref,reason:'occupied output chain'});continue;}
  commit(proposed);alignedPorts.add(port.id);report.series.push(found.chain.map(t=>t.c.ref));
 }
 // A directly attached port follows its neighbour's actual anchor, not bbox centre.
 for(const p of ports){
  if(alignedPorts.has(p.id))continue;
  const links=edges.filter(e=>e.source===p.id||e.target===p.id);if(links.length!==1)continue;
  const e=links[0],other=byId.get(e.source===p.id?e.target:e.source);if(!other)continue;
  const a=pinAbs(p,rel(e,p.id)),b=pinAbs(other,rel(e,other.id));
  if(!Number.isFinite(a.y+b.y)||Math.abs(a.y-b.y)<.01)continue;
  const next={...p,y:p.y+b.y-a.y};
  if(!collides([next])){commit([next]);report.ports.push(p.id);}
 }
 return report;
}

/** Separate quality signal: direct gate-port jogs missed by bend counting
 * when the placer itself offsets the endpoint. This never changes LVS/DRC. */
export function directGatePortJogs(model) {
 const cells=allCells(model).map(cellInfo),map=new Map(cells.map(c=>[c.id,c])),out=[];
 for(const e of cells.filter(c=>c.kind==='edge')){
  for(const [pid,mid,pre,otherPre] of [[e.source,e.target,'exit','entry'],[e.target,e.source,'entry','exit']]){
   const p=map.get(pid),m=map.get(mid);if(!p||!m||classify(p).role!=='port')continue;
   const cl=classify(m),po=pinOrderFor(cl);if(!cl.shape||!po||!['M','Q'].includes(cl.prefix))continue;
   const gate=getPin(cl.shape.key,po[1]);if(!gate)continue;
   const mx=Number(e.style.map.get(otherPre+'X')),my=Number(e.style.map.get(otherPre+'Y'));
   if(Math.hypot(mx-gate.x,my-gate.y)>.01)continue;
   const a=pinAbs(p,{x:Number(e.style.map.get(pre+'X')),y:Number(e.style.map.get(pre+'Y'))}),b=pinAbs(m,gate);
   if(Math.abs(a.y-b.y)>1)out.push({port:pid,device:mid,offset:Math.abs(a.y-b.y)});
  }
 }
 return out;
}
