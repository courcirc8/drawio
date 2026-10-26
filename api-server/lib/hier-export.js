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
  // the tabs (Eric, 2026-10-26): document order, the parent = the first earlier page whose block links here
  pages.forEach((P, i) => {
    P.order = i;
    const up = pages.slice(0, i).find((Q) => Object.values(Q.cells).some((c) => c.page === P.name));
    P.parent = up ? up.name : null;
    P.depth = up ? up.depth + 1 : 0;
  });
  for (const P of pages) P.children = [...new Set(Object.values(P.cells).map((c) => c.page).filter((n) => n && pages.find((Q) => Q.name === n)?.parent === P.name))];
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

/** a self-contained HTML viewer of hierPages(): one tab per page in hierarchy order (indented by depth), the
 *  breadcrumb of the shown page, a click on a block box opens its page */
export function hierViewerHtml(hp, title = 'schematic') {
  const tabs = hp.pages.map((P) => `<button data-tab="${esc(P.name)}" style="margin-left:${P.depth * 12}px">${esc(P.name)}</button>`).join('');
  const views = hp.pages.map((P) => `<section data-page="${esc(P.name)}" data-parent="${esc(P.parent || '')}" hidden>${P.svg.replace(/^<\?xml[^>]*>/, '')}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;font:13px sans-serif}nav{display:flex;gap:4px;padding:6px;border-bottom:1px solid #ccc;flex-wrap:wrap}
nav button{border:1px solid #bbb;background:#f6f6f6;padding:3px 10px;cursor:pointer}nav button.on{background:#fff;border-bottom-color:#fff;font-weight:bold}
#crumb{padding:4px 8px;color:#555}#crumb a{cursor:pointer;color:#0645ad}</style></head><body>
<nav>${tabs}</nav><div id="crumb"></div><main>${views}</main><script>
const S=[...document.querySelectorAll('section')],B=[...document.querySelectorAll('nav button')];
function show(n){S.forEach(s=>s.hidden=s.dataset.page!==n);B.forEach(b=>b.classList.toggle('on',b.dataset.tab===n));
const path=[];for(let p=n;p;p=S.find(s=>s.dataset.page===p)?.dataset.parent)path.unshift(p);
const c=document.getElementById('crumb');c.textContent='';path.forEach((p,i)=>{if(i)c.append(' › ');const a=document.createElement('a');a.dataset.go=p;a.textContent=p;c.append(a);});}
document.addEventListener('click',e=>{const t=e.target.closest('[data-tab],[data-go],a[data-page]');if(!t)return;e.preventDefault();show(t.dataset.tab||t.dataset.go||t.dataset.page);});
show(S[0]?.dataset.page);</script></body></html>`;
}
