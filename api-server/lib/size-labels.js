/**
 * size-labels.js — every engine shows a transistor's W/L (µm), ng and ×m under its name, as the manuel engine
 * does (Orchestrator 08.11, MLOAD: v4:split and sa showed the name only). The text is lib/place-manuel.js's
 * annotation(); a name label (LBL_<ref>, plain text = the ref) gets a second, smaller line and grows around its
 * centre. Labels already carrying more than the ref are left alone (manuel, templates that annotate).
 */
import { allCells, cellInfo, updateCell } from './model.js';
import { annotation } from './place-manuel.js';

const TR = new Set(['M', 'Q', 'J']);
// a name label: LBL_<ref>, or B<n>_LBL_<ref> when v4 draws in blocks (review r3, B1)
const LBL = /^(?:B\d+_)?LBL_(.+)$/;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function annotateSizes(model, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref), c]));
  let n = 0;
  const cells = allCells(model).map(cellInfo);
  for (const info of cells) {
    const lm = LBL.exec(String(info.id));
    if (info.kind !== 'vertex' || !lm) continue;
    const ref = lm[1], c = byRef.get(ref);
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
  // engines that draw no name label (v1 and elk show the raw SPICE value under the symbol, v3 the ref and that
  // value; review r2, N2): the symbol's own label becomes the name and the W/L line. `spice_value` stays the
  // value the LVS reads (lib/netlist.js), so only the drawn text changes.
  const named = new Set(cells.map((c) => LBL.exec(String(c.id))?.[1]).filter(Boolean));
  for (const info of cells) {
    if (info.kind !== 'vertex' || !info.refdes || named.has(String(info.refdes)) || /noLabel=1/.test(info.styleRaw || '')) continue;
    if (info.attrs?.spice_value == null) continue;
    const ref = String(info.refdes), c = byRef.get(ref);
    if (!c || !(c.prefix === 'M' || (c.prefix === 'X' && /mos|fet/i.test(c.model || '')))) continue;
    const ann = annotation(c);
    if (!ann || !/\d\/\d|\d\.?\d*\/\d/.test(ann)) continue;
    updateCell(model, info.id, { value: `<b>${esc(ref)}</b><br><font style="font-size:10px">${esc(ann)}</font>`, style: { html: '1' } });
    n++;
  }
  return n;
}
