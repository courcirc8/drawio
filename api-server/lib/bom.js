/**
 * bom.js — bill of materials extraction.
 */
import { allCells, cellInfo } from './model.js';
import { classify, identityOf } from './components.js';

export function bom(model) {
  const rows = [];
  for (const c of allCells(model).map(cellInfo)) {
    if (c.kind !== 'vertex') continue;
    const cls = classify(c);
    if (cls.role !== 'component') continue;
    // Identity comes from the refdes attribute when present, never from the
    // mxCell id: draw.io reassigns ids on copy/paste, so a BOM keyed on the id
    // silently lists a duplicated part under a stale ref. Same for the value --
    // spice_value is the attribute a human can edit in the GUI's Edit Data.
    rows.push({ ref: identityOf(c), type: cls.mapping ? cls.mapping.label : (cls.shape ? cls.shape.name : 'unknown'),
      value: (c.attrs && c.attrs.spice_value) || c.value || '', shape: cls.shape ? cls.shape.key : null });
  }
  rows.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return rows;
}

export function bomCsv(rows) {
  const esc = (s) => /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
  return 'ref,type,value,shape\n' + rows.map((r) => [r.ref, r.type, r.value, r.shape].map(esc).join(',')).join('\n') + '\n';
}
