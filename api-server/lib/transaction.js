/** Restore the complete model on rejection or exception, including rerouted wires. */
export function restoreModel(model, snapshot) {
  for (const a of Array.from(model.attributes)) model.removeAttribute(a.name);
  for (const a of Array.from(snapshot.attributes)) model.setAttribute(a.name,a.value);
  while(model.firstChild) model.removeChild(model.firstChild);
  for(const child of Array.from(snapshot.childNodes)) model.appendChild(child.cloneNode(true));
}
export async function tryGeometry(model, operation, accept) {
  const snapshot=model.cloneNode(true);
  try { const result=await operation(); if(await accept(result))return {accepted:true,result};
    restoreModel(model,snapshot);return {accepted:false,result};
  } catch(e){restoreModel(model,snapshot);throw e;}
}
