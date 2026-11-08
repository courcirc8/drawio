/**
 * size-labels.js — every engine shows a transistor's W/L (µm), ng and ×m under its name, as the manuel engine
 * does (Orchestrator 08.11, MLOAD: v4:split and sa showed the name only). The text is lib/place-manuel.js's
 * annotation(); a name label (LBL_<ref>, plain text = the ref) gets a second, smaller line and grows around its
 * centre. Labels already carrying more than the ref are left alone (manuel, templates that annotate).
 */
import { allCells, cellInfo, updateCell } from './model.js';
import { annotation } from './place-manuel.js';

const TR = new Set(['M', 'Q', 'J']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function annotateSizes(model, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref), c]));
  let n = 0;
  for (const info of allCells(model).map(cellInfo)) {
    if (info.kind !== 'vertex' || !String(info.id).startsWith('LBL_')) continue;
    const ref = String(info.id).slice(4), c = byRef.get(ref);
    if (!c || String(info.value || '').trim() !== ref) continue;
    const isMos = c.prefix === 'M' || (c.prefix === 'X' && /mos|fet/i.test(c.model || ''));
    if (!isMos && !TR.has(c.prefix)) continue;
    const ann = annotation(c);
    if (!ann || !/\d\/\d|\d\.?\d*\/\d/.test(ann)) continue;     // W/L only, not a bare model name
    const w = Math.max(info.w || 0, Math.ceil(ann.length * 6.2) + 6), h = (info.h || 16) + 14;
    updateCell(model, info.id, {
      value: `<b>${esc(ref)}</b><br><font style="font-size:10px">${esc(ann)}</font>`,
      style: { html: '1', whiteSpace: 'wrap' },
      x: Math.round((info.x || 0) + (info.w || 0) / 2 - w / 2), y: Math.round((info.y || 0) - 7), w, h,
    });
    n++;
  }
  return n;
}
