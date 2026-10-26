/**
 * hier-export.js — D5 (PLAN-HIERARCHIE §3.2, 2026-10-26): every page of a
 * hierarchical drawing (lib/hier.js) as an SVG plus the geometry of its cells
 * in that SVG's units, so analog-design (calques.py) can lay its overlays page
 * by page: `map` (flattened ref -> {page, cell}) tells which page and cell
 * carry a device of the flattened netlist. Every block of a page gets a
 * transparent clickable area linking to the SVG of its own page (D4: the same
 * link as the `data:page/id` link of the .drawio).
 */
import { allCells, cellInfo } from './model.js';
import { exportDocument } from './render.js';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** pages: [{ name, id, svg, mapping, cells: { cellId: { x, y, w, h, ref?, block? } } }] (SVG units);
 *  `map` when given: { flatRef: { page, cell, x, y, w, h } } in the units of that page's SVG */
export async function hierPages(doc, map = null, opts = {}) {
  const dias = Array.from(doc.getElementsByTagName('diagram'));
  const nameOf = new Map(dias.map((d) => [d.getAttribute('id'), d.getAttribute('name')]));
  const pages = [];
  for (const dia of dias) {
    const name = dia.getAttribute('name'), id = dia.getAttribute('id');
    const m = Array.from(dia.childNodes).find((n) => n.nodeName === 'mxGraphModel');
    const out = await exportDocument(doc, m, { format: 'svg', pageId: id, scale: opts.scale ?? 1, border: opts.border ?? 10 });
    const { scale: s, tx, ty } = out.mapping;
    const cells = {};
    const links = [];
    for (const c of allCells(m).map(cellInfo)) {
      if (c.kind !== 'vertex' || c.x == null) continue;
      const box = { x: (c.x + tx) * s, y: (c.y + ty) * s, w: c.w * s, h: c.h * s };
      const ref = c.refdes || null;
      const block = c.style.map.get('apiBlock') === '1' ? decodeURIComponent(c.style.map.get('apiBlockDef') || '') : null;
      if (!ref && !block) continue;
      cells[c.id] = { ...box, ...(ref ? { ref } : {}), ...(block ? { block } : {}) };
      const link = block ? /^data:page\/id,(.*)$/.exec(c.attrs?.link || '') : null;
      const target = link ? nameOf.get(link[1]) : null;
      if (target) { cells[c.id].page = target; links.push(`<a xlink:href="${esc(target)}.svg" data-page="${esc(target)}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="transparent" stroke="none"><title>${esc(target)}</title></rect></a>`); }
    }
    let svg = out.buffer.toString('utf8');
    if (links.length) svg = svg.replace(/<\/svg>\s*$/, `<g data-drawio-api="block-links">${links.join('')}</g></svg>`);
    pages.push({ name, id, svg, mapping: out.mapping, cells });
  }
  let flat = null;
  if (map) {
    flat = {};
    for (const [ref, p] of Object.entries(map)) {
      const P = pages.find((q) => q.name === p.page);
      const hit = P && Object.entries(P.cells).find(([id, c]) => String(c.ref || id).toUpperCase() === String(p.cell).toUpperCase());
      flat[ref] = { page: p.page, cell: p.cell, ...(hit ? { x: hit[1].x, y: hit[1].y, w: hit[1].w, h: hit[1].h } : {}) };
    }
  }
  return { pages, ...(flat ? { map: flat } : {}) };
}
