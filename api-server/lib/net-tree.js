/** Bounded whole-net trunk proposals. Candidates are not accepted layouts: callers
 * must run the independent geometry, visible connectivity and LVS audits. */
import {parseDrawio,getPage,serialize,updateCell} from './model.js';
import {cellsOf,rebuildLocalDots} from './generic-refinement.js';
import {netGroups,polylineOf} from './route.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';

const protectedEdge=e=>e.style.map.has('drawioApiGateBus')||e.style.map.has('drawioApiFixedRoute');
const same=(a,b)=>a.x===b.x&&a.y===b.y;
function grouped(cells){
  const groups=netGroups(cells),out=new Map();
  for(const e of cells.filter(c=>c.kind==='edge')){
    const key=groups.get(e.id);if(key===undefined)continue;
    if(!out.has(key))out.set(key,[]);out.get(key).push(e);
  }
  return [...out.values()].map(es=>es.sort((a,b)=>a.id.localeCompare(b.id)));
}
function terminals(edges,map){
  const points=[];
  for(const e of edges){
    for(const prefix of ['exit','entry'])for(const axis of ['X','Y']){
      const value=e.style.map.get(prefix+axis);
      if(value==null||!Number.isFinite(Number(value)))throw Error('Net tree requires explicit finite anchors');
    }
    const line=polylineOf(e,map);
    if(!line||line.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw Error('Missing or nonfinite terminal geometry');
    for(const p of [line[0],line.at(-1)])if(!points.some(q=>same(p,q)))points.push(p);
  }
  return points;
}
function path(a,b,axis,coordinate){
  const raw=axis==='h'?[a,{x:a.x,y:coordinate},{x:b.x,y:coordinate},b]:[a,{x:coordinate,y:a.y},{x:coordinate,y:b.y},b];
  const out=[];
  for(const p of raw){
    if(out.length&&same(p,out.at(-1)))continue;
    // Remove only a point BETWEEN its neighbours; preserve backtracking escapes.
    while(out.length>1){const u=out.at(-2),v=out.at(-1);
      const collinear=(u.x===v.x&&v.x===p.x)||(u.y===v.y&&v.y===p.y);
      if(!collinear||v.x<Math.min(u.x,p.x)||v.x>Math.max(u.x,p.x)||v.y<Math.min(u.y,p.y)||v.y>Math.max(u.y,p.y))break;
      out.pop();
    }
    out.push(p);
  }
  return out;
}
/** At most six terminal-coordinate trunks per net, independent of names/values.
 * A complete net is skipped if even one of its edges is protected. */
export function netTreeProposals(model){
  const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),out=[];
  for(const edges of grouped(cs)){
    if(edges.length<2||edges.some(protectedEdge))continue;
    let pts;try{pts=terminals(edges,map);}catch{continue;}
    if(pts.length<3)continue;
    for(const axis of ['h','v']){
      const values=[...new Set(pts.map(p=>axis==='h'?p.y:p.x))].sort((a,b)=>a-b);
      for(const coordinate of [...new Set([values[0],values[Math.floor((values.length-1)/2)],values.at(-1)])]){
        const differs=edges.some(e=>{const old=polylineOf(e,map),next=path(old[0],old.at(-1),axis,coordinate);return JSON.stringify(old)!==JSON.stringify(next);});
        if(differs)out.push({kind:'net-tree',id:`net-tree-${edges[0].id}-${axis}-${coordinate}`,edgeIds:edges.map(e=>e.id),axis,coordinate});
      }
    }
  }
  return out;
}
/** Preserve documentary edge identities, every terminal and non-contact vertex.
 * Repeated edge paths deliberately share copper; this is not Steiner optimisation.
 * No obstacle detours are attempted: unsupported results must be rejected externally. */
export function netTreeCandidate(xml,proposal){
  if(proposal?.kind!=='net-tree'||!['h','v'].includes(proposal.axis)||!Number.isFinite(proposal.coordinate)||!Array.isArray(proposal.edgeIds))throw Error('Invalid net tree proposal');
  const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model),cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c]));
  const ids=[...proposal.edgeIds].sort();
  const edges=grouped(cs).find(es=>JSON.stringify(es.map(e=>e.id).sort())===JSON.stringify(ids));
  if(!edges||edges.length<2)throw Error('Proposal must contain one complete current net');
  if(edges.some(protectedEdge))throw Error('Protected gate bus or fixed route');
  if(terminals(edges,map).length<3)throw Error('Net tree requires three distinct terminal positions');
  for(const e of edges){const old=polylineOf(e,map);updateCell(model,e.id,{points:path(old[0],old.at(-1),proposal.axis,proposal.coordinate).slice(1,-1),style:{edgeStyle:'none'}});}
  rebuildLocalDots(model);
  assertGeometryOnly(before,connectivityFingerprint(model),'whole-net trunk candidate');
  return serialize(doc);
}
