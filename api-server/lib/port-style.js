/** Family A: named arrow tags. Direction is explicit or inferred conservatively
 * from boundary names. Unknown/RF terminals remain bidirectional. */
import {allCells,cellInfo,mxCellPart,mergeStyle} from './model.js';
import {classify} from './components.js';
import {pinAbs} from './route.js';
export function portDirection(name, overrides={}) {
 const key=String(name).toUpperCase();
 const explicit=Object.entries(overrides).find(([k])=>k.toUpperCase()===key)?.[1];
 if(explicit!=null){if(!['input','output','inout'].includes(explicit))throw new Error('Invalid port direction: '+explicit);return explicit;}
 if(/^(OUT|VOUT|DOUT|OUTPUT|OSC)(?:[PMN]|\d|_|$)/.test(key))return 'output';
 if(/^(IN|VIN|DIN|INPUT|VB|VBIAS|BIAS|CLK|LO)(?:[PMN]|\d|_|$)/.test(key))return 'input';
 return 'inout';
}
export function applyPortStyle(model,{portStyle='A',portDirections={}}={}) {
 if(portStyle!=='A')return;
 const nodes=allCells(model),cells=nodes.map(cellInfo),edges=cells.filter(c=>c.kind==='edge');
 for(let i=0;i<cells.length;i++){
  const p=cells[i];if(p.kind!=='vertex'||classify(p).role!=='port')continue;
  const links=edges.filter(e=>e.source===p.id||e.target===p.id);
  if(!links.length)continue;
  const anchors=links.map(e=>{const pre=e.source===p.id?'exit':'entry';return {e,pre,point:pinAbs(p,{x:Number(e.style.map.get(pre+'X')??0.5),y:Number(e.style.map.get(pre+'Y')??0)})};});
  const a=anchors[0].point, cx=p.x+p.w/2,cy=p.y+p.h/2;
  // Preserve the absolute attachment while increasing space for the inside label.
  const otherId=links[0].source===p.id?links[0].target:links[0].source;
  const other=cells.find(c=>c.id===otherId);
  const dx=a.x-cx;
  const side=Math.abs(dx)>0.1?(dx>0?'east':'west'):((other?.x??a.x)+(other?.w??0)/2>=a.x?'east':'west');
  const width=Math.max(64,String(p.value).length*7+28),height=24;
  const x=side==='east'?a.x-width:a.x;
  let y=a.y-height/2;
  const blocked=yy=>cells.some(v=>v.kind==='vertex'&&v.id!==p.id&&classify(v).role!=='junction'&&x<v.x+v.w+4&&x+width>v.x-4&&yy<v.y+v.h+4&&yy+height>v.y-4);
  const originalY=y;
  if(blocked(y))for(let step=16;step<=160;step+=16){const candidate=[originalY-step,originalY+step].find(yy=>!blocked(yy));if(candidate!==undefined){y=candidate;break;}}
  const shiftY=y-originalY;

  const direction=portDirection(p.value,portDirections);
  const facing=direction==='output'?(side==='east'?'west':'east'):side;
  const flip=facing==='west';
  const cell=mxCellPart(nodes[i]),g=cell.getElementsByTagName('mxGeometry')[0];
  g.setAttribute('x',String(x));g.setAttribute('y',String(y));g.setAttribute('width',String(width));g.setAttribute('height',String(height));
  cell.setAttribute('style',`shape=${direction==='inout'?'doubleArrow':'singleArrow'};arrowWidth=1;arrowSize=0.18;apiShape=port;portDirection=${direction};direction=east;flipH=${flip?1:0};rotation=0;html=0;fillColor=#ffffff;strokeColor=default;whiteSpace=nowrap;overflow=hidden;align=center;verticalAlign=middle;labelPosition=center;verticalLabelPosition=middle;fontSize=12;spacing=2;`);
  for(const {e,pre,point} of anchors){
   const node=nodes.find(n=>n.getAttribute('id')===e.id),edge=mxCellPart(node);
   edge.setAttribute('style',mergeStyle(edge.getAttribute('style'),{[pre+'X']:flip?1-(point.x-x)/width:(point.x-x)/width,[pre+'Y']:(point.y+shiftY-y)/height,[pre+'Name']:null}));
  }
  Object.assign(p,{x,y,w:width,h:height,rotation:0,flipH:flip,flipV:false});
 }
}
