/** Geometry candidates derived only from topology and coordinates. No circuit-name profiles. */
import {parseDrawio,getPage,serialize,allCells,cellInfo,updateCell,addVertex} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {pinAbs,rotatedAabb,netGroups,polylineOf} from './route.js';
import {mirrorAboutConductionAxis} from './signal-alignment.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
export const cellsOf=m=>allCells(m).map(cellInfo);
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),eps=.05;
const on=(p,a,b)=>Math.abs((p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x))<eps&&p.x>=Math.min(a.x,b.x)-eps&&p.x<=Math.max(a.x,b.x)+eps&&p.y>=Math.min(a.y,b.y)-eps&&p.y<=Math.max(a.y,b.y)+eps;
const direction=(a,b)=>Math.abs(a.x-b.x)>Math.abs(a.y-b.y)?(b.x>a.x?'R':'L'):(b.y>a.y?'D':'U');
const anchor=(e,c)=>{const pre=e.source===c.id?'exit':'entry';return pinAbs(c,{x:Number(e.style.map.get(pre+'X')??.5),y:Number(e.style.map.get(pre+'Y')??.5)});};
function clean(points){const out=[];for(const p of points){if(out.length&&dist(out.at(-1),p)<eps)continue;while(out.length>1&&on(out.at(-1),out.at(-2),p))out.pop();out.push(p);}return out;}
function hits(a,b,r,margin=0){const x=r.x-margin,y=r.y-margin,w=r.w+2*margin,h=r.h+2*margin;
 if(Math.abs(a.y-b.y)<eps)return a.y>y+eps&&a.y<y+h-eps&&Math.max(a.x,b.x)>x+eps&&Math.min(a.x,b.x)<x+w-eps;
 if(Math.abs(a.x-b.x)<eps)return a.x>x+eps&&a.x<x+w-eps&&Math.max(a.y,b.y)>y+eps&&Math.min(a.y,b.y)<y+h-eps;
 return true;
}
function outward(c,p){const r=rotatedAabb(c),dx=(p.x-r.x-r.w/2)/Math.max(r.w,1),dy=(p.y-r.y-r.h/2)/Math.max(r.h,1);return Math.abs(dy)>=Math.abs(dx)?{x:0,y:Math.sign(dy)||1}:{x:Math.sign(dx)||1,y:0};}
/** Rebuild contact decorations from actual, same-net incident directions, including endpoints. */
export function rebuildLocalDots(model){
 for(const el of allCells(model)){const c=cellInfo(el);if(c.kind==='vertex'&&c.style.map.get('contactDot')==='1')el.parentNode.removeChild(el);}
 const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),groups=netGroups(cs),wires=cs.filter(c=>c.kind==='edge'&&c.source&&c.target).map(e=>({e,net:groups.get(e.id),p:polylineOf(e,map)})).filter(w=>w.p),points=[];
 for(const w of wires)for(const p of w.p)if(!points.some(q=>q.net===w.net&&dist(p,q.p)<eps))points.push({p,net:w.net});
 let seq=0;
 for(const {p,net} of points){const dirs=new Set();let foreign=false;
 for(const w of wires)for(let i=1;i<w.p.length;i++){const a=w.p[i-1],b=w.p[i];if(dist(a,b)<eps||!on(p,a,b))continue;if(w.net!==net){foreign=true;continue;}if(dist(a,p)>eps)dirs.add(direction(p,a));if(dist(b,p)>eps)dirs.add(direction(p,b));}
 if(foreign)continue;
 for(const w of wires.filter(w=>w.net===net))for(const [id,pt] of [[w.e.source,w.p[0]],[w.e.target,w.p.at(-1)]]){const c=map.get(id);if(dist(p,pt)>eps||classify(c).role!=='component')continue;const n=outward(c,p);dirs.add(direction(p,{x:p.x-n.x,y:p.y-n.y}));}
 if(dirs.size<3)continue;
 const existing=cs.some(c=>classify(c).role==='junction'&&c.style.map.get('apiJunctionHidden')!=='1'&&dist(p,{x:c.x+c.w/2,y:c.y+c.h/2})<3);
 if(!existing)addVertex(model,{id:'GDOT_'+(++seq),x:p.x-3,y:p.y-3,w:6,h:6,style:'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;contactDot=1;'});
 }
}
/** Search orthogonal paths with mandatory outward escapes; all symbol bodies remain obstacles. */
function localPath(e,cs,mode,gap=18){const map=new Map(cs.map(c=>[c.id,c])),s=map.get(e.source),t=map.get(e.target);if(!s||!t)return null;
 const a=anchor(e,s),b=anchor(e,t),na=outward(s,a),nb=outward(t,b),A={x:a.x+gap*na.x,y:a.y+gap*na.y},B={x:b.x+gap*nb.x,y:b.y+gap*nb.y};
 const boxes=cs.filter(c=>c.kind==='vertex'&&['component','port','power','ground'].includes(classify(c).role)).map(c=>({...rotatedAabb(c),id:c.id}));
 const groups=netGroups(cs),my=groups.get(e.id),foreign=cs.filter(c=>c.kind==='edge'&&groups.get(c.id)!==my).map(c=>polylineOf(c,map)).filter(Boolean);
 const xs=[A.x,B.x,(A.x+B.x)/2],ys=[A.y,B.y,(A.y+B.y)/2];
 for(const r of boxes){xs.push(r.x-20,r.x+r.w+20);ys.push(r.y-20,r.y+r.h+20);}
 const mid=[[A,B],[A,{x:B.x,y:A.y},B],[A,{x:A.x,y:B.y},B]];
 for(const x of [...new Set(xs)])mid.push([A,{x,y:A.y},{x,y:B.y},B]);for(const y of [...new Set(ys)])mid.push([A,{x:A.x,y},{x:B.x,y},B]);
 // Direct paths are admitted only if their first and last directions leave the terminals.
 const candidates=mid.map(p=>clean([a,...p,b]));if(Math.abs(a.x-b.x)<eps||Math.abs(a.y-b.y)<eps)candidates.push([a,b]);
 let best=null,cost=Infinity;
 for(const p of candidates){let blocked=false,length=0,cross=0;for(let i=1;i<p.length;i++){const u=p[i-1],v=p[i];length+=dist(u,v);if(boxes.some(r=>hits(u,v,r,-1.5))){blocked=true;break;}
 for(const q of foreign)for(let j=1;j<q.length;j++){const c=q[j-1],d=q[j];if(Math.abs(u.y-v.y)<eps&&Math.abs(c.x-d.x)<eps&&on({x:c.x,y:u.y},u,v)&&on({x:c.x,y:u.y},c,d))cross++;else if(Math.abs(u.x-v.x)<eps&&Math.abs(c.y-d.y)<eps&&on({x:u.x,y:c.y},u,v)&&on({x:u.x,y:c.y},c,d))cross++;}}
 if(blocked)continue;const score=cross*10000+(p.length-2)*(mode==='compact'?15:80)+length;if(score<cost){cost=score;best=p;}}
 return best?.slice(1,-1);
}
export function localCandidate(xml,proposal){
 const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model),initial=cellsOf(model),moved=new Set();
 if(!(proposal.moves?.length||proposal.edges?.length||proposal.dots))return xml;
 for(const move of proposal.moves||[]){const cs=cellsOf(model),old=cs.find(c=>c.id===move.id);if(!old)throw Error('Missing component');let next={...old,...move};
 if(move.mirror){const cl=classify(old),po=pinOrderFor(cl);next={...mirrorAboutConductionAxis(old,getPin(cl.shape.key,po[0]),getPin(cl.shape.key,po[2])),...move};}
 next.x+=(move.dx||0);next.y+=(move.dy||0);updateCell(model,old.id,{x:next.x,y:next.y,rotation:next.rotation,style:{flipH:next.flipH?'1':'0'}});moved.add(old.id);
 const label=cs.find(c=>c.id==='LBL_'+old.id);if(label)updateCell(model,label.id,{x:label.x+next.x-old.x,y:label.y+next.y-old.y});}
 const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),affected=new Set(proposal.edges||[]);
 for(const e of cs.filter(c=>c.kind==='edge')){if(moved.has(e.source)||moved.has(e.target))affected.add(e.id);else{const p=polylineOf(e,map);if(p&&[...moved].some(id=>{const r=rotatedAabb(map.get(id));return p.slice(1).some((q,i)=>hits(p[i],q,r));}))affected.add(e.id);}}
 for(const id of affected){const e=cellsOf(model).find(c=>c.id===id);if(e.style.map.has('drawioApiFixedRoute'))throw Error('Fixed route affected');const points=localPath(e,cellsOf(model),proposal.mode)||localPath(e,cellsOf(model),proposal.mode,6);if(!points)throw Error('No body-safe local path: '+e.source+' -> '+e.target);updateCell(model,id,{points});}
 rebuildLocalDots(model);assertGeometryOnly(before,connectivityFingerprint(model),'generic local refinement');
 const final=new Map(cellsOf(model).map(c=>[c.id,c]));for(const e of initial.filter(c=>c.kind==='edge'&&!affected.has(c.id)))if(JSON.stringify(e.points)!==JSON.stringify(final.get(e.id).points))throw Error('Unrelated route changed');
 return serialize(doc);
}
export function genericProposals(model,ref,loop){const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),edges=cs.filter(c=>c.kind==='edge'),out=[];let seq=0;const add=(kind,p)=>out.push({id:kind+'-'+(++seq),kind,...p});
 if(loop===1||loop===5)for(const c of cs.filter(c=>classify(c).role==='port')){const links=edges.filter(e=>e.source===c.id||e.target===c.id);if(!links.length)continue;const a=anchor(links[0],c),ys=[];
 for(const e of links){const p=polylineOf(e,map);for(let i=1;i<p.length;i++)if(Math.abs(p[i].y-p[i-1].y)<eps&&Math.abs(p[i].x-p[i-1].x)>30)ys.push(p[i].y);const other=map.get(e.source===c.id?e.target:e.source);ys.push(anchor(e,other).y);}
 for(const y of [...new Set(ys)])if(Math.abs(y-a.y)>.5)add('port-track',{moves:[{id:c.id,y:c.y+y-a.y}]});}
 if(loop===2){add('junction-repair',{dots:true});for(const c of cs.filter(c=>classify(c).prefix==='M')){add('axis-mirror',{moves:[{id:c.id,mirror:true}]});
 const cl=classify(c),gate=pinAbs(c,getPin(cl.shape.key,pinOrderFor(cl)[1]));for(const dy of [-80,80,140])add('mirror-height',{moves:[{id:c.id,mirror:true,dy}]});
 // A gate-facing mirror may carry immediately adjacent passive input branches.
 const gateEdges=edges.filter(e=>(e.source===c.id||e.target===c.id)&&dist(anchor(e,c),gate)<eps);
 const peers=gateEdges.map(e=>map.get(e.source===c.id?e.target:e.source)).filter(p=>['R','C','L'].includes(classify(p).prefix));
 if(peers.length)for(const gap of [50,100]){const side=c.flipH?-1:1;add('mirror-clearance',{moves:[{id:c.id,mirror:true},...peers.map(p=>({id:p.id,dx:side*gap}))]});}}
 }
 if(loop===3||loop===5)for(const e of edges){const p=clean(polylineOf(e,map)||[]);if(p.length<3)continue;add('terminal-escape',{edges:[e.id],mode:loop===5?'compact':'bends'});}
 if(loop===4){const terms=new Map();for(const c of ref.components)for(const n of c.nodes.slice(0,c.prefix==='M'?3:2)){if(!terms.has(n))terms.set(n,[]);terms.get(n).push(c);}
 for(const c of ref.components.filter(c=>['R','C','L'].includes(c.prefix))){const v=map.get(c.ref);if(!v)continue;
 for(const rotation of [0,90])if(rotation!==v.rotation)add('passive-axis',{moves:[{id:v.id,rotation}]});
 for(const [dx,dy] of [[-80,0],[80,0],[0,-80],[0,80]]){const ids=new Set([c.ref]),queue=[c];while(queue.length){const part=queue.shift();for(const n of part.nodes){const tt=terms.get(n)||[];if(tt.length!==2)continue;for(const other of tt)if(!ids.has(other.ref)&&['R','C','L'].includes(other.prefix)){ids.add(other.ref);queue.push(other);}}}
 const moves=[...ids].map(id=>({id,dx,dy}));for(const e of edges){const id=ids.has(e.source)?e.target:ids.has(e.target)?e.source:null,aux=map.get(id);if(aux&&['ground','power','port'].includes(classify(aux).role)&&edges.filter(x=>x.source===id||x.target===id).length===1)moves.push({id,dx,dy});}
 add('series-branch',{moves:[...new Map(moves.map(m=>[m.id,m])).values()]});}
 }
 }
 if(loop===5)out.push(...signalBranchProposals(model,ref));
 return out;
}

/** Recognize a MOS signal path with external passive branches and optional D/G feedback. */
function signalBranchProposals(model,ref){
 const cs=cellsOf(model),map=new Map(cs.map(c=>[c.id,c])),edges=cs.filter(c=>c.kind==='edge'),ports=cs.filter(c=>classify(c).role==='port'),out=[];
 const portFor=n=>ports.find(p=>String(p.value).toLowerCase()===n.toLowerCase());
 const pin=(c,i)=>{const cl=classify(c);return getPin(cl.shape.key,pinOrderFor(cl)[i]);};
 const passive=ref.components.filter(c=>['R','C','L'].includes(c.prefix));let seq=0;
 for(const mos of ref.components.filter(c=>c.prefix==='M')){const old=map.get(mos.ref);if(!old||(old.rotation||0)%180!==0)continue;
 const [dn,gn]=mos.nodes;const inputs=passive.filter(c=>c.nodes.includes(gn)&&portFor(c.nodes[c.nodes[0]===gn?1:0]));if(inputs.length!==1)continue;
 const input=inputs[0],inIndex=input.nodes[0]===gn?0:1,port=portFor(input.nodes[1-inIndex]),axis=pinAbs(old,pin(old,0)).x,side=port.x+port.w/2<axis?-1:1;
 const gate0=pinAbs(old,pin(old,1)),mirror=(gate0.x-axis)*side<0,m=mirror?mirrorAboutConductionAxis(old,pin(old,0),pin(old,2)):old,gate=pinAbs(m,pin(m,1)),drain=pinAbs(m,pin(m,0));
 const feedback=passive.find(c=>c.nodes.includes(gn)&&c.nodes.includes(dn));
 const outputs=passive.filter(c=>c.nodes.includes(dn)&&c.ref!==feedback?.ref&&portFor(c.nodes[c.nodes[0]===dn?1:0]));
 for(const clearance of [42,60,80])for(const feedbackGap of [24,40]){const moves=[{id:old.id,mirror}];
 const place=(part,near,point,dir)=>{const v=map.get(part.ref);if(!v)return null;const a=pin(v,near),b=pin(v,1-near),q={...v,rotation:0,flipH:(a.x<b.x)?dir<0:dir>0};const p=pinAbs(q,a);q.x+=point.x-p.x;q.y+=point.y-p.y;moves.push({id:v.id,x:q.x,y:q.y,rotation:0,flipH:q.flipH});return pinAbs(q,b);};
 const far=place(input,inIndex,{x:gate.x+side*clearance,y:gate.y},side);if(!far)continue;const pe=edges.find(e=>e.source===port.id||e.target===port.id);if(!pe)continue;const pa=anchor(pe,port);moves.push({id:port.id,x:port.x+far.x+side*46-pa.x,y:port.y+far.y-pa.y});
 if(feedback){const di=feedback.nodes[0]===dn?0:1;place(feedback,di,{x:axis,y:drain.y-Math.sign(gate.y-drain.y)*feedbackGap},side);}
 if(outputs.length===1){const output=outputs[0],near=output.nodes[0]===dn?0:1,net=output.nodes[1-near],op=portFor(net),end=place(output,near,{x:axis-side*84,y:drain.y},-side);
 if(end&&op){const oe=edges.find(e=>e.source===op.id||e.target===op.id),oa=oe&&anchor(oe,op);if(oa)moves.push({id:op.id,x:op.x+end.x-side*180-oa.x,y:op.y+end.y-oa.y});
 for(const sh of passive.filter(c=>c.ref!==output.ref&&c.nodes.includes(net))){const v=map.get(sh.ref),farNet=sh.nodes[sh.nodes[0]===net?1:0];if(!v||farNet!=='0')continue;const si=sh.nodes[0]===net?0:1,q={...v,rotation:90,flipH:si===1};const ap=pinAbs(q,pin(q,si));q.x+=end.x-side*65-ap.x;q.y+=end.y+70-ap.y;moves.push({id:v.id,x:q.x,y:q.y,rotation:q.rotation,flipH:q.flipH});const bottom=pinAbs(q,pin(q,1-si));
 for(const e of edges.filter(e=>e.source===v.id||e.target===v.id)){const aux=map.get(e.source===v.id?e.target:e.source);if(aux&&classify(aux).role==='ground'){const a=anchor(e,aux);moves.push({id:aux.id,x:aux.x+bottom.x-a.x,y:aux.y+bottom.y+45-a.y});}}
 }
 }}
 // Carry a private source ground onto the fixed conduction axis.
 for(const e of edges.filter(e=>e.source===old.id||e.target===old.id)){const aux=map.get(e.source===old.id?e.target:e.source);if(aux&&classify(aux).role==='ground'&&edges.filter(w=>w.source===aux.id||w.target===aux.id).length===1){const a=anchor(e,aux);moves.push({id:aux.id,x:aux.x+axis-a.x});}}
 out.push({id:'signal-branches-'+(++seq),kind:'signal-branches',moves:[...new Map(moves.map(m=>[m.id,m])).values()]});
 }
 }return out;
}

/** A readability improvement cannot buy fewer crossings with excessive wire growth. */
export function withinQualityBudget(candidate,baseline){return candidate.check.errors===0&&candidate.routing.length<=baseline.routing.length*1.2&&candidate.check.warnings<=baseline.check.warnings+2;}
