/** Opt-in route-only cleanup. Geometry checks and electrical audits remain mandatory. */
import {cellsOf,localCandidate} from './generic-refinement.js';
import {polylineOf,netGroups} from './route.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
import {cleaningProposals,cleaningCandidate} from './cleaning.js';
const eps=.05;
/** Union of collinear copper: duplicate edge representations must not earn a gain. */
export function copperMetrics(paths){
 const lines=new Map();let diagonal=false;
 for(const points of paths)for(let i=1;i<points.length;i++){
  const a=points[i-1],b=points[i];if(Math.hypot(a.x-b.x,a.y-b.y)<eps)continue;
  const h=Math.abs(a.y-b.y)<eps,v=Math.abs(a.x-b.x)<eps;if(!h&&!v){diagonal=true;continue;}
  const axis=h?'h':'v',fixed=h?a.y:a.x,key=axis+':'+Math.round(fixed*1000)/1000;
  if(!lines.has(key))lines.set(key,{axis,fixed,intervals:[]});lines.get(key).intervals.push([Math.min(h?a.x:a.y,h?b.x:b.y),Math.max(h?a.x:a.y,h?b.x:b.y)]);
 }
 const segments=[];let length=0;
 for(const {axis,fixed,intervals} of lines.values()){
  intervals.sort((a,b)=>a[0]-b[0]);const merged=[];for(const [a,b] of intervals){const last=merged.at(-1);if(last&&a<=last[1]+eps)last[1]=Math.max(last[1],b);else merged.push([a,b]);}
  for(const [a,b] of merged){length+=b-a;segments.push(axis==='h'?[{x:a,y:fixed},{x:b,y:fixed}]:[{x:fixed,y:a},{x:fixed,y:b}]);}
 }
 const vertices=new Map();for(const pair of segments)for(const p of pair)vertices.set(p.x+':'+p.y,p);
 let bends=0;for(const p of vertices.values()){
  const dirs=new Set();for(const [a,b] of segments){if(Math.abs(a.y-b.y)<eps&&Math.abs(p.y-a.y)<eps&&p.x>=a.x-eps&&p.x<=b.x+eps){if(a.x<p.x-eps)dirs.add('L');if(b.x>p.x+eps)dirs.add('R');}else if(Math.abs(a.x-b.x)<eps&&Math.abs(p.x-a.x)<eps&&p.y>=a.y-eps&&p.y<=b.y+eps){if(a.y<p.y-eps)dirs.add('U');if(b.y>p.y+eps)dirs.add('D');}}
  if(dirs.size===2&&[...dirs].some(d=>'LR'.includes(d))&&[...dirs].some(d=>'UD'.includes(d)))bends++;
 }
 return {length:Math.round(length*1000)/1000,bends,diagonal};
}
export function visibleNetMetrics(model){const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),groups=netGroups(cs),paths=new Map();for(const e of cs.filter(c=>c.kind==='edge')){const net=groups.get(e.id);if(!paths.has(net))paths.set(net,[]);paths.get(net).push(polylineOf(e,map));}return new Map([...paths].map(([net,p])=>[net,copperMetrics(p)]));}
export function routeProtection(before,after){
 try{assertGeometryOnly(connectivityFingerprint(before),connectivityFingerprint(after),'conservative cleanup');}catch{return 'electrical identity';}
 const old=cellsOf(before),next=new Map(cellsOf(after).map(c=>[c.id,c]));
 for(const c of old){const n=next.get(c.id);if(c.kind==='vertex'&&c.style.map.get('contactDot')!=='1'&&JSON.stringify([c.x,c.y,c.w,c.h,c.rotation,c.flipH,c.flipV,c.value])!==JSON.stringify(n&&[n.x,n.y,n.w,n.h,n.rotation,n.flipH,n.flipV,n.value]))return 'placement';
 if(c.kind==='edge'&&(c.style.map.has('drawioApiGateBus')||c.style.map.has('drawioApiFixedRoute'))&&JSON.stringify(c.points)!==JSON.stringify(n?.points))return 'protected route';}
 return null;
}
export function copperDominance(before,after){let gain=false;const a=visibleNetMetrics(before),b=visibleNetMetrics(after);if(a.size!==b.size)return false;for(const [net,x] of a){const y=b.get(net);if(!y||y.diagonal||y.length>x.length+eps||y.bends>x.bends)return false;if(y.length<x.length-1||y.bends<x.bends)gain=true;}return gain;}
export function conservativeProposals(model,ref,stage){
 const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c]));
 if(stage===2||stage===4)return cs.filter(c=>c.kind==='edge'&&!c.style.map.has('drawioApiGateBus')&&!c.style.map.has('drawioApiFixedRoute')&&polylineOf(c,map).length>2).map(c=>({id:'edge-'+c.id,kind:'local',edges:[c.id],mode:stage===2?'bends':'compact'}));
 return cleaningProposals(model,ref,3).filter(p=>p.kind===(stage===3?'conduction-axis':'conduction-project'));
}
export const conservativeCandidate=(xml,p)=>p.kind==='local'?localCandidate(xml,p):cleaningCandidate(xml,p);
