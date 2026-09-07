/** Annotation-driven geometry proposals; never changes terminal identity or nets. */
import {parseDrawio,getPage,allCells,cellInfo,updateCell,serialize} from './model.js';
import {classify,pinOrderFor} from './components.js';
import {getPin} from './stencils.js';
import {routePage,pinAbs} from './route.js';
import {mirrorAboutConductionAxis} from './signal-alignment.js';
import {connectivityFingerprint,assertGeometryOnly} from './invariant.js';
export const cellsOf=m=>allCells(m).map(cellInfo);
export function anchor(e,c){const pre=e.source===c.id?'exit':'entry';return pinAbs(c,{x:Number(e.style.map.get(pre+'X')??.5),y:Number(e.style.map.get(pre+'Y')??.5)});}
export function routeMetrics(model){
 const cells=cellsOf(model),map=new Map(cells.map(c=>[c.id,c]));let bends=0,portBends=0,length=0;
 for(const e of cells.filter(c=>c.kind==='edge')){const a=map.get(e.source),b=map.get(e.target);if(!a||!b)continue;
 const p=[anchor(e,a),...e.points,anchor(e,b)].filter((p,i,arr)=>!i||Math.hypot(p.x-arr[i-1].x,p.y-arr[i-1].y)>.01);let n=0;
 for(let i=1;i<p.length;i++){length+=Math.hypot(p[i].x-p[i-1].x,p[i].y-p[i-1].y);if(i>1){const u={x:p[i-1].x-p[i-2].x,y:p[i-1].y-p[i-2].y},v={x:p[i].x-p[i-1].x,y:p[i].y-p[i-1].y};if(Math.abs(u.x*v.y-u.y*v.x)>.01||u.x*v.x+u.y*v.y<0)n++;}}
 bends+=n;if([a,b].some(c=>classify(c).role==='port'))portBends+=n;
 }return {bends,portBends,length:Math.round(length)};
}
export function portProposals(model){
 const cells=cellsOf(model),map=new Map(cells.map(c=>[c.id,c])),out=[];
 for(const p of cells.filter(c=>classify(c).role==='port')){
 const edges=cells.filter(e=>e.kind==='edge'&&(e.source===p.id||e.target===p.id));if(!edges.length)continue;
 const e=edges[0],other=map.get(e.source===p.id?e.target:e.source);if(!other)continue;
 const a=anchor(e,p),b=anchor(e,other),ys=edges.map(link=>{const peer=map.get(link.source===p.id?link.target:link.source);return peer?anchor(link,peer).y:b.y;});
 const points=[b,...(e.source===p.id?[...e.points].reverse():e.points),a];
 for(let i=1;i<points.length;i++)if(Math.abs(points[i].y-points[i-1].y)<.01&&Math.abs(points[i].x-points[i-1].x)>35)ys.push(points[i].y);
 for(const y of [...new Set(ys)])if(Math.abs(y-a.y)>.5)out.push({id:p.id+'-y'+Math.round(y),moves:[{id:p.id,y:p.y+y-a.y}]});
 if(edges.length===1&&classify(other).prefix==='M')for(const gap of [28,40,60]){const side=a.x<b.x?-1:1;out.push({id:p.id+'-gap'+gap,moves:[{id:p.id,x:p.x+b.x+side*gap-a.x,y:p.y+b.y-a.y}]});}
 }return out;
}
export async function geometryCandidate(xml,proposal){
 const doc=parseDrawio(xml),model=getPage(doc),before=connectivityFingerprint(model);
 for(const move of proposal.moves||[]){const cells=cellsOf(model),c=cells.find(c=>c.id===move.id);if(!c)throw new Error('Missing '+move.id);let next={...c,...move};
 if(move.mirror){const cl=classify(c),order=pinOrderFor(cl);next={...mirrorAboutConductionAxis(c,getPin(cl.shape.key,order[0]),getPin(cl.shape.key,order[2])),...move};}
 if(move.dx)next.x+=move.dx;if(move.dy)next.y+=move.dy;
 updateCell(model,c.id,{x:next.x,y:next.y,rotation:next.rotation,style:{flipH:next.flipH?'1':'0'}});
 const label=cells.find(x=>x.id==='LBL_'+c.id);if(label)updateCell(model,label.id,{x:label.x+next.x-c.x,y:label.y+next.y-c.y});
 }
 await routePage(model,null,{});assertGeometryOnly(before,connectivityFingerprint(model),'annotation refinement');return serialize(doc);
}
export function guidedProposals(name,model,loop){
 const c=cellsOf(model),get=id=>c.find(c=>c.id===id),out=[];
 const add=(id,moves)=>out.push({id,moves,guided:true});
 if(loop===2||loop===5){
 if(name==='diffpair-resistive')for(const y of [220,245,279])add('outputs-right-'+y,[{id:'PN6',x:930,y:y-12,flipH:false},{id:'PN7',x:930,y:y+48,flipH:false}]);
 if(name==='ota-symmetrical'){add('bias-input-align',[{id:'PN11',y:get('M10').y+55-12},{id:'P_inm',y:get('M2').y+55-12}]);for(const y of [240,270,300])add('inputs-left-'+y,[{id:'M1',mirror:true},{id:'P_inp',x:get('P_inm').x,y,flipH:false},{id:'P_inm',y:get('M2').y+43}]);}
 if(name==='ota-2stage-pmos')for(const dx of [60,100,140])add('open-output-column-'+dx,['M6','M7','VT3','GND6','P_out'].map(id=>({id,dx})).concat([{id:'P_inm',x:get('M2').x+get('M2').w+28,y:get('M2').y+43}]));
 if(name==='folded-cascode')for(const dy of [100,160,222])add('lower-input-'+dy,[{id:'M2',dy},{id:'P_inm',dy}]);
 }
 if(loop===3){
 if(name==='lna-shunt-fb')for(const dx of [0,-50,-90])add('gate-faces-rf-'+dx,[{id:'M1',mirror:true},...['C1','P_rf'].map(id=>({id,dx})),{id:'R2',x:120,y:396}]);
 if(name==='rgc-tia')for(const dy of [100,140,175])add('lower-mirror-M2-'+dy,[{id:'M2',mirror:true,dy},{id:'GND4',y:get('GND5').y}]);
 }
 if(loop===4||loop===5){
 if(name==='lna-shunt-fb')add('mirror-and-horizontal-chain',[{id:'M1',mirror:true},{id:'C1',x:74},{id:'P_rf',x:-42},{id:'R2',x:116,y:200,flipH:false},{id:'C2',x:370,y:221},{id:'R3',x:500,y:361},{id:'GND2',x:537,y:466},{id:'P_out',x:650,y:239}]);
 if(name==='lna-shunt-fb')for(const y of [get('M1').y,get('M1').y-25])add('horizontal-output-'+y,[{id:'C2',y:y-30,x:370},{id:'R3',x:500,y:y+110},{id:'GND2',x:537,y:y+215},{id:'P_out',x:650,y:y-12}]);
 if(name==='lc-match')for(const dx of [70,110,150])add('space-output-shunts-'+dx,[{id:'R2',dx},{id:'GND2',dx},{id:'P_out',dx}]);
 if(name==='lc-match')add('input-left-resistor-down',[{id:'PN3',x:180,y:44,flipH:false},{id:'R1',x:251,y:96,rotation:-90},{id:'P_rf',x:269,y:285},{id:'R2',dx:110},{id:'GND2',dx:110},{id:'P_out',dx:110}]);
 if(name==='pierce-xtal')for(const x of [100,160,210])add('feedback-vertical-'+x,[{id:'C2',x:20,y:251},{id:'GND4',x:57,y:376},{id:'R1',x,y:470,rotation:90},{id:'C3',x:490},{id:'GND3',x:527}]);
 }
 if(loop===5){
 if(name==='lna-shunt-fb')for(const rx of [180,186,200])for(const ry of [190,210,400])add('feedback-clearance-'+rx+'-'+ry,[{id:'M1',mirror:true},{id:'C1',x:74},{id:'P_rf',x:-42},{id:'R2',x:rx,y:ry,flipH:false},{id:'C2',x:370,y:221},{id:'R3',x:500,y:361},{id:'GND2',x:537,y:466},{id:'P_out',x:650,y:239}]);
 if(name==='folded-cascode')for(const dy of [220,260])add('lower-pair-stagger-cascode-'+dy,[{id:'M1',dy},{id:'M2',dy},{id:'P_inp',dy},{id:'P_inm',dy},{id:'M6',dy:40},{id:'PB_12_M6',dy:40}]);
 }
 return out;
}

// An explicit user preference may require more bends to free the crowded centre.
export function annotationPenalty(name,model){if(name!=='diffpair-resistive')return 0;const cs=cellsOf(model),a=cs.find(c=>c.id==='PN6'),b=cs.find(c=>c.id==='PN7'),right=Math.max(...cs.filter(c=>classify(c).prefix==='M').map(c=>c.x+c.w));return Number(a.x<right+80)+Number(b.x<right+80)+Number(Math.abs(a.y-b.y)<40);}
