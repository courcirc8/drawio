/** Optional floorplanning: reserve whitespace from net demand, then explore
 * conduction-branch orders using existing analogue motifs. No net is rewritten. */
import {detectStructures, isPmosLike} from './patterns.js';
const rail = n => /^(0|gnd|vdd|vcc|vss|avdd|dvdd)$/i.test(n);
const visibleNodes = c => c.nodes.slice(0, c.prefix === 'M' ? 3 : c.nodes.length);

export function reserveChannels(components, slots, {pitch = 14, cap = 112} = {}) {
  if (!(pitch >= 0 && cap >= 0 && Number.isFinite(pitch + cap))) throw new Error('Invalid channel dimensions');
  const nets = new Map();
  for (const c of components) {
    const s = slots.get(c.ref); if (!s) continue;
    for (const n of new Set(visibleNodes(c))) {
      if (rail(n)) continue;
      if (!nets.has(n)) nets.set(n, []);
      nets.get(n).push(s);
    }
  }
  const axis = key => {
    const coords = [...new Set([...slots.values()].map(s => s[key]).filter(Number.isFinite))].sort((a,b) => a-b);
    const intervals = coords.slice(1).map((hi,i) => {
      const lo = coords[i], cut = (lo+hi)/2;
      const demand = [...nets.values()].filter(ss => ss.some(s => s[key] < cut) && ss.some(s => s[key] > cut)).length;
      return {lo, hi, demand, extra: Math.min(cap, Math.max(0,demand-1)*pitch)};
    });
    return {intervals, offset: value => intervals.reduce((sum,g) => sum + g.extra*Math.max(0,Math.min(1,(value-g.lo)/(g.hi-g.lo))),0)};
  };
  const x=axis('col'),y=axis('level');
  return {x:x.offset,y:y.offset,report:{columns:x.intervals,rows:y.intervals}};
}

export function branchOrders(parsed, roots, limit = 3) {
  if (roots.length < 2) return [];
  const comps=parsed.components, byRef=new Map(comps.map(c=>[c.ref,c]));
  const conduction=c => ['M','Q'].includes(c.prefix)
    ? (isPmosLike(c)?[c.nodes[2],c.nodes[0]]:[c.nodes[0],c.nodes[2]])
    : ['R','L','V','I','D'].includes(c.prefix)?c.nodes.slice(0,2):null;
  const ownership=new Map();
  for(const root of roots){
    const queue=[root],seen=new Set();
    while(queue.length){
      const ref=queue.shift();if(seen.has(ref))continue;seen.add(ref);
      if(!ownership.has(ref))ownership.set(ref,new Set());ownership.get(ref).add(root);
      const c=byRef.get(ref), ab=c&&conduction(c);if(!ab||rail(ab[1]))continue;
      for(const k of comps){const next=conduction(k);if(next&&next[0]===ab[1])queue.push(k.ref);}
    }
  }
  const weights=new Map();
  const connect=(refs,w)=>{
    const rs=[...new Set(refs.flatMap(r=>[...(ownership.get(r)||[])]))];
    for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){
      const key=[rs[i],rs[j]].sort().join('|');weights.set(key,(weights.get(key)||0)+w);
    }
  };
  const nets=new Map();
  for(const c of comps)for(const n of new Set(visibleNodes(c))){if(rail(n))continue;if(!nets.has(n))nets.set(n,[]);nets.get(n).push(c.ref);}
  for(const refs of nets.values())connect(refs,1);
  const st=detectStructures(parsed);
  for(const p of [...st.diffPairs,...st.mirrors,...st.crossCoupled])connect(p.refs,6);
  for(const c of st.cascodes)connect([c.top,c.bottom],6);
  const weight=(a,b)=>weights.get([a,b].sort().join('|'))||0;
  const cost=order=>order.reduce((sum,a,i)=>sum+order.slice(i+1).reduce((s,b,j)=>s+weight(a,b)*(j+1),0),0);
  const candidates=[];
  for(const first of roots){
    const order=[first],left=new Set(roots.filter(r=>r!==first));
    while(left.size){let best=null;
      for(const ref of left)for(const side of ['left','right']){
        const next=side==='left'?[ref,...order]:[...order,ref],score=cost(next);
        if(!best||score<best.score)best={ref,next,score};
      }
      order.splice(0,order.length,...best.next);left.delete(best.ref);
    }
    candidates.push(order,[...order].reverse());
  }
  const unique=[...new Map(candidates.map(o=>[o.join('|'),o])).values()];
  return unique.filter(o=>o.join('|')!==roots.join('|')).sort((a,b)=>cost(a)-cost(b)).slice(0,limit);
}
