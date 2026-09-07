/** Structural hypotheses, never assertions about the circuit's operating point. */
import {parseDrawio,getPage} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {pinAbs} from './route.js';
import {cellsOf,localCandidate} from './generic-refinement.js';
import {mirrorGroups} from './gate-bus.js';

const passive=c=>['R','L','C'].includes(c.prefix)&&c.nodes.length===2&&c.nodes[0]!==c.nodes[1];
const pin=(c,i)=>pinAbs(c,getPin(classify(c).shape.key,pinOrderFor(classify(c))[i]));
function graph(reference){const parts=reference.components.filter(passive),adj=new Map();for(const p of parts)for(const n of p.nodes){if(!adj.has(n))adj.set(n,[]);adj.get(n).push(p);}return {parts,adj};}
/** Degree-two chains are unambiguous graph branches; tapped alternative paths are hypotheses. */
export function inferCircuitRoles(model,reference){
 const {parts,adj}=graph(reference),map=new Map(cellsOf(model).map(c=>[c.id,c])),branches=[],ambiguous=[],seen=new Set();
 const total=new Map();for(const p of reference.components)for(const n of p.nodes)total.set(n,(total.get(n)||0)+1);
 for(const start of parts)for(const n of start.nodes){if(total.get(n)===2)continue;let node=n,part=start;const refs=[],nodes=[n];while(part&&!refs.includes(part.ref)){refs.push(part.ref);node=part.nodes.find(x=>x!==node);nodes.push(node);if(total.get(node)!==2)break;part=(adj.get(node)||[]).find(p=>p.ref!==part.ref);}
 const key=[...refs].sort().join('|');if(refs.length>1&&!seen.has(key)){seen.add(key);branches.push({kind:'passive-chain',refs,nodes});}}
 // Enumerate bounded simple alternative paths. Limit search to avoid exponential growth.
 for(const bridge of parts){let searches=0;const paths=[];function walk(node,refs,nodes){if(++searches>256||refs.length>4)return;if(node===bridge.nodes[1]){if(refs.length>=2)paths.push({refs,nodes});return;}for(const p of adj.get(node)||[]){if(p.ref===bridge.ref||refs.includes(p.ref))continue;const next=p.nodes.find(n=>n!==node);if(nodes.includes(next))continue;walk(next,[...refs,p.ref],[...nodes,next]);}}walk(bridge.nodes[0],[],[bridge.nodes[0]]);
 for(const path of paths){if(!map.has(bridge.ref)||path.refs.some(id=>!map.has(id)))continue;const tapped=path.nodes.slice(1,-1).some(n=>total.get(n)!==2);branches.push({kind:'passive-bridge',bridge:bridge.ref,refs:path.refs,nodes:path.nodes,tapped,confidence:tapped?'tentative':'structural'});if(tapped)ambiguous.push({kind:'tapped-passive-path',refs:[bridge.ref,...path.refs],reason:'An internal node has another branch; visual placement must decide.'});}}
 const mos=reference.components.filter(c=>c.prefix==='M'&&map.has(c.ref)),differentialPairs=[],cascodes=[];
 const polarity=p=>/pmos/i.test(classify(map.get(p.ref)).shape.key)?'P':'N';
 for(let i=0;i<mos.length;i++)for(let j=i+1;j<mos.length;j++){const a=mos[i],b=mos[j];if(polarity(a)!==polarity(b))continue;if(a.nodes[2]===b.nodes[2]&&a.nodes[1]!==b.nodes[1]&&a.nodes[0]!==b.nodes[0])differentialPairs.push({refs:[a.ref,b.ref],confidence:'tentative'});if(a.nodes[0]===b.nodes[2]||b.nodes[0]===a.nodes[2])cascodes.push({refs:[a.ref,b.ref],confidence:'tentative'});}
 return {branches,mirrors:mirrorGroups(model,reference).map(g=>({...g,confidence:'tentative'})),differentialPairs,cascodes,ambiguous};
}
export function passiveBranchProposals(model,reference){
 const map=new Map(cellsOf(model).map(c=>[c.id,c])),parts=new Map(reference.components.map(c=>[c.ref,c])),out=[];
 for(const group of inferCircuitRoles(model,reference).branches.filter(g=>g.kind==='passive-bridge')){
 const first=parts.get(group.refs[0]),last=parts.get(group.refs.at(-1)),a=pin(map.get(first.ref),first.nodes.indexOf(group.nodes[0])),b=pin(map.get(last.ref),last.nodes.indexOf(group.nodes.at(-1)));
 // Only an already ordered, straight chain supplies trustworthy placement anchors.
 if(Math.abs(a.y-b.y)>.05||Math.abs(a.x-b.x)<100)continue;
 const xs=group.refs.map(id=>{const c=map.get(id);return c.x+c.w/2;});const direction=Math.sign(b.x-a.x);if(xs.some((x,i)=>i&&direction*(x-xs[i-1])<=0))continue;
 if(group.refs.some(id=>{const c=map.get(id);return Math.abs(pin(c,0).y-a.y)>.05||Math.abs(pin(c,1).y-a.y)>.05;}))continue;
 const c=map.get(group.bridge),part=parts.get(group.bridge),near=part.nodes.indexOf(group.nodes[0]);
 for(const gap of [70,100])for(const side of [-1,1]){let q={...c,rotation:0,flipH:false};if(Math.sign(pin(q,1-near).x-pin(q,near).x)!==direction)q.flipH=true;const p0=pin(q,0),p1=pin(q,1);q.x+=(a.x+b.x-p0.x-p1.x)/2;q.y+=a.y+side*gap-p0.y;if(Math.hypot(q.x-c.x,q.y-c.y)<.05&&q.rotation===c.rotation&&q.flipH===c.flipH)continue;out.push({id:'passive-bridge-'+out.length,kind:'passive-bridge',group,moves:[{id:c.id,x:q.x,y:q.y,rotation:0,flipH:q.flipH}],mode:'bends'});}
 }
 return out;
}
export function passiveBranchCandidate(xml,proposal){
 if(proposal.kind!=='passive-bridge'||proposal.moves?.length!==1||proposal.moves[0].id!==proposal.group?.bridge)throw Error('Unsupported passive branch proposal');
 const model=getPage(parseDrawio(xml)),before=cellsOf(model),moved=proposal.group.bridge,incident=new Set(before.filter(c=>c.kind==='edge'&&(c.source===moved||c.target===moved)).map(c=>c.id));
 const vertex=before.find(c=>c.id===moved);if(!vertex||!['R','C','L'].includes(classify(vertex).prefix))throw Error('Bridge is not a passive component');
 for(const move of proposal.moves)for(const key of ['x','y','rotation'])if(!Number.isFinite(move[key]))throw Error('Non-finite placement');
 const result=localCandidate(xml,proposal),after=new Map(cellsOf(getPage(parseDrawio(result))).map(c=>[c.id,c]));
 for(const c of before){if(c.kind==='edge'&&!incident.has(c.id)&&JSON.stringify(c.points)!==JSON.stringify(after.get(c.id)?.points))throw Error('Bridge placement would reroute an unrelated edge');if(c.kind==='vertex'&&c.id!==moved&&c.id!=='LBL_'+moved&&c.style.map.get('contactDot')!=='1'){const a=after.get(c.id);if(!a||a.x!==c.x||a.y!==c.y||a.rotation!==c.rotation||a.flipH!==c.flipH)throw Error('Bridge placement changed unrelated vertex');}}
 return result;
}
