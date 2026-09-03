/**
 * annotate.js — post-route ANNOTATION LAYER: zone colours, value-label
 * suffixes, free-text callouts, and decorative amplifier blocks, driven by
 * the `annotations` key of a seed sidecar (seeds/<name>.json — the same file
 * lib/preplace.js reads for seeded pre-placement).
 *
 * WHY A SEPARATE MODULE, AND WHY IT RUNS LAST. The seed already carries
 * `devices` (cx/cy/rot — placement intent, consumed by preplace.js BEFORE
 * routing). `annotations` is a second, independent kind of intent: colour,
 * text and decoration that the netlist itself cannot carry at all. It is
 * applied by server.js strictly AFTER route.routePage() has produced the
 * final wire geometry, for one load-bearing reason: route.js derives its
 * libavoid obstacle list from whatever vertices exist in the model AT ROUTE
 * TIME (route.js's `rebuildRoutes`, `const vertices = cells.filter((c) =>
 * c.kind === 'vertex' && c.x != null)` — no shape/role filter at all, EVERY
 * vertex is an obstacle). An annotation cell added before routing would
 * therefore become a routing obstacle and could visibly degrade route
 * quality (more crossings/bends) even though it carries no electrical
 * meaning. Adding it after routing means the router never sees it — it
 * cannot move a single wire.
 *
 * INERTNESS (the hard constraint: drawing == netlist). Every cell this
 * module adds carries an explicit `apiAnnotation=1` marker in its style.
 * components.js::classify() checks that marker FIRST, before it ever looks
 * at `shape=`/`apiShape=`, and returns {role: 'other'} immediately when it
 * is present. netlist.js::connectivity() then DROPS any vertex whose
 * classify().role is not one of 'junction'/'ground'/'power'/'port'/
 * 'component' — the `else continue;` in its per-cell loop — so the cell is
 * never added to `termInfo`, never becomes a wire endpoint candidate, and
 * never joins a net. lvs.compare() and bom.js both work off connectivity()'s
 * output, so an annotation cell is invisible to LVS and the BOM the same
 * way.
 *
 * WHY A MARKER AND NOT "NO SHAPE KEY" (corrected 2026-08-31). The first cut
 * of this module relied on annotation cells staying SHAPELESS — no `shape=`
 * key at all — so they fell through classify()'s `key == null` branch by
 * accident rather than by declaration. That accident BLOCKED ever drawing a
 * real amplifier symbol for the PA/LNA blocks: the top-ranked defect in an
 * independent visual review was that they carried no amplifier geometry
 * whatsoever (just an empty dashed rectangle), because giving them a shape
 * would have made classify() treat them as an unmapped *component* instead
 * of inert decoration. `apiAnnotation=1` decouples the two: an annotation
 * cell can now use ANY shape — a real stencil, or a core mxGraph shape like
 * `triangle` for the amplifier symbol — and still be structurally excluded,
 * because inertness is declared, not inferred from what the cell looks like.
 *
 * DRC SAFETY (a SEPARATE concern from electrical inertness). tools/check.py
 * (the `through`/`edge-hug`/`comp-overlap` rules) and lib/check.js's own
 * `comps` filter — the JS/Python DRC checkers that inspect a vertex WITHOUT
 * going through classify()/connectivity() — both now key off the same
 * `apiAnnotation` marker (an `is_annotation` flag alongside their existing
 * `is_text` one) to exclude annotation cells from body-obstacle rules
 * entirely, the same way a `text;`-styled label always was. Free-text
 * callouts still get nudged clear of real wires/components for readability
 * (computeGeometry + findClearSpot, below) even though nothing now DEPENDS
 * on that for correctness; the PA/LNA blocks do NOT get this nudge (see
 * their own comment below — they are deliberately sized to enclose their
 * zone's real components).
 */
import { allCells, cellInfo, addVertex, mergeStyle, mxCellPart, getCell } from './model.js';
import { pinAbs } from './route.js';
import { isJunctionCell } from './components.js';

// ---- geometry helpers (through-rule equivalents of lib/check.js, kept
//      local: check.js's own versions are module-private) -----------------

function aabbOf(v) {
  const t = ((v.rotation || 0) * Math.PI) / 180;
  const w = Math.abs(v.w * Math.cos(t)) + Math.abs(v.h * Math.sin(t));
  const h = Math.abs(v.w * Math.sin(t)) + Math.abs(v.h * Math.cos(t));
  return { x: v.x + v.w / 2 - w / 2, y: v.y + v.h / 2 - h / 2, w, h };
}

function segIntersectsRect(p, q, r) {
  const inside = (pt) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inter = (a, b, c, e) => {
    const d1 = d(c, e, a), d2 = d(c, e, b), d3 = d(a, b, c), d4 = d(a, b, e);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  const corners = [
    [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
    [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
    [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
    [{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }],
  ];
  return corners.some(([a, b]) => inter(p, q, a, b));
}

function rectsOverlap(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x &&
         a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

/** Snapshot of the routed model's wire polylines + existing component AABBs,
 *  taken ONCE before any annotation cell is added (see module docstring). */
function computeGeometry(model) {
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const wires = cells.filter((c) => c.kind === 'edge' && c.source != null && c.target != null);
  const comps = cells.filter((c) => c.kind === 'vertex' && c.x != null && !isJunctionCell(c));
  const anchor = (edge, pref, cell) => {
    const X = edge.style.map.get(pref + 'X'), Y = edge.style.map.get(pref + 'Y');
    if (X != null && Y != null) return pinAbs(cell, { x: parseFloat(X), y: parseFloat(Y) });
    return { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
  };
  const polys = [];
  for (const w of wires) {
    const src = byId.get(w.source), tgt = byId.get(w.target);
    if (src == null || tgt == null || src.x == null || tgt.x == null) continue;
    polys.push([anchor(w, 'exit', src), ...(w.points || []), anchor(w, 'entry', tgt)]);
  }
  // Les ETIQUETTES des composants, pas seulement leurs corps.
  //
  // DEFECT (2026-08-31) : `isClear()` ne connaissait que les fils et les corps,
  // si bien que l'annotation « LNA » s'est posee sur l'etiquette « L7 / 11 nH »
  // (check.py : `label-overlap`). Un texte pose sur un autre texte est le pire
  // des chevauchements — deux valeurs qui fusionnent en une chaine illisible —
  // et c'etait le seul obstacle que la recherche de place ne voyait pas.
  //
  // La boite est estimee a ~7,2 px par caractere sur la ligne la plus longue,
  // 16 px de haut par ligne, posee SOUS le corps (ou au-dessus si
  // `verticalLabelPosition=top`).
  //
  // LIMITE CONNUE, MESUREE (2026-08-31) — vraie pour un composant DROIT, fausse
  // pour un composant TOURNE, et il y a trois modeles en desaccord :
  //   * `tools/check.py::label_box()` place l'etiquette sous la boite BRUTE ;
  //     pour L7 (x=301 y=550 w=60 h=5, rotation=90) cela donne (331, 565) ;
  //   * ce code-ci la place sous la boite TOURNEE, soit (331, 592) ;
  //   * mxGraph, seul juge, l'imprime en (293, 544) — releve dans le SVG exporte
  //     (`padding-top:544px; margin-left:293px` sur le foreignObject).
  // Aucun des deux modeles ne predit le rendu. Consequence a garder en tete :
  // les avertissements `label-overlap` et `label-on-wire` sont peu fiables DANS
  // LES DEUX SENS des qu'un composant tourne est implique. Ajouter les
  // etiquettes comme obstacles reste un progres net (il n'y en avait aucun),
  // mais ce n'est pas une garantie tant que les trois modeles ne sont pas
  // reconcilies sur une mesure du rendu, ce qui reste a faire.
  const labels = [];
  for (const c of comps) {
    const txt = String(c.value || '');
    if (!txt) continue;
    const lines = txt.split('\n');
    const lw = 7.2 * Math.max(...lines.map((l) => l.length)) + 6;
    const lh = 16 * lines.length;
    const box = aabbOf(c);
    const cx = box.x + box.w / 2;
    const cy = c.style.map.get('verticalLabelPosition') === 'top'
      ? box.y - lh / 2 - 2 : box.y + box.h + lh / 2 + 2;
    labels.push({ x: cx - lw / 2, y: cy - lh / 2, w: lw, h: lh });
  }
  return { polys, boxes: comps.map(aabbOf).concat(labels) };
}

function isClear(geom, rect) {
  for (const poly of geom.polys) {
    for (let i = 0; i + 1 < poly.length; i++) {
      if (segIntersectsRect(poly[i], poly[i + 1], rect)) return false;
    }
  }
  for (const b of geom.boxes) {
    if (rectsOverlap(rect, b, 2)) return false;
  }
  return true;
}

/** Points on the ring of radius `ring*step` around the origin, offset-only. */
function ringOffsets(ring, step) {
  if (ring === 0) return [[0, 0]];
  const n = 8 * ring;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n;
    pts.push([Math.cos(ang) * ring * step, Math.sin(ang) * ring * step]);
  }
  return pts;
}

/** Find a top-left (x,y) for a w x h box centred near (cx,cy) that clears
 *  every routed wire segment and every existing component AABB. Expands
 *  outward in rings until it finds one, or gives up after `maxRing` and
 *  returns the original spot flagged `blocked: true`. */
function findClearSpot(geom, cx, cy, w, h, { maxRing = 14, step = null } = {}) {
  const ringStep = step ?? Math.max(w, h) / 2 + 8;
  for (let ring = 0; ring <= maxRing; ring++) {
    for (const [dx, dy] of ringOffsets(ring, ringStep)) {
      const x = cx + dx - w / 2, y = cy + dy - h / 2;
      // inflate by 3px, matching check.js's own `through` margin, so a
      // spot that is merely TANGENT to a wire/body still counts as clear
      const rect = { x: x - 3, y: y - 3, w: w + 6, h: h + 6 };
      if (isClear(geom, rect)) return { x, y, blocked: false };
    }
  }
  return { x: cx - w / 2, y: cy - h / 2, blocked: true };
}

// ---- anchor resolution (task 1, 2026-08-31) --------------------------------

/** Union of two axis-aligned rects (each {x,y,w,h}). */
function unionRect(a, b) {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Resolve an anchor — a cell refdes/id, OR a zone name from
 * `ann.zones[].name` — to its ACTUAL placed bounding box, read from the
 * model at annotate time (i.e. AFTER place3 + preplace + routing have all
 * run). This is the fix for the measured defect: the previous seed schema
 * carried a RAW cx/cy in the hand-drawn reference's own coordinate space,
 * which is not where the placer puts anything, so a caption could drift
 * arbitrarily far from what it names (measured: ~200px in blank canvas for
 * the ANT/50Ω caption). An anchor resolved from the live model cannot drift
 * — it moves exactly when the thing it names moves.
 *
 * A zone anchor is the UNION of its member cells' AABBs (rotation-aware, via
 * aabbOf); a cell anchor is that one cell's own AABB. Returns null — never a
 * stale fallback position — when the anchor names neither a known zone nor
 * an existing, placed cell, so the caller can report it in `warnings`.
 */
function resolveAnchorBox(model, zonesByName, anchor) {
  const refs = zonesByName.get(anchor);
  if (refs != null) {
    let box = null;
    for (const ref of refs) {
      const cell = getCell(model, ref);
      if (cell == null) continue;
      const info = cellInfo(cell);
      if (info.x == null) continue;
      const b = aabbOf(info);
      box = box == null ? b : unionRect(box, b);
    }
    return box;
  }
  const cell = getCell(model, anchor);
  if (cell == null) return null;
  const info = cellInfo(cell);
  if (info.x == null) return null;
  return aabbOf(info);
}

/** The point on a resolved box's perimeter (or centre) for a `side` hint. */
function sideOf(box, side) {
  switch (side) {
    case 'left': return { x: box.x, y: box.y + box.h / 2 };
    case 'right': return { x: box.x + box.w, y: box.y + box.h / 2 };
    case 'top': return { x: box.x + box.w / 2, y: box.y };
    case 'bottom': return { x: box.x + box.w / 2, y: box.y + box.h };
    default: return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }
}

/**
 * Apply the `annotations` block of a seed to an already-placed, already-
 * ROUTED model. Returns a small report; never throws on a missing/malformed
 * entry — it warns and skips, the same "degrade to a warning" contract
 * lib/preplace.js uses for an unknown seed name.
 */
export function applyAnnotations(model, seed, { scale = 1 } = {}) {
  const ann = seed && seed.annotations;
  const report = { zones: 0, suffixes: 0, texts: 0, blocks: 0, warnings: [] };
  if (ann == null) return report;

  // Name -> member refs, for anchor/block resolution below (task 1). A zone
  // without a `name` (an older seed) simply cannot be used as an anchor —
  // its colouring still applies from the loop right below, unaffected.
  const zonesByName = new Map();
  for (const z of ann.zones || []) {
    if (z.name != null) zonesByName.set(z.name, z.refs || []);
  }

  // ---- 1. zone colours: patch strokeColor on the already-placed component
  //         cell's OWN style. No new geometry, so no DRC/routing exposure.
  for (const z of ann.zones || []) {
    for (const ref of z.refs || []) {
      const cell = getCell(model, ref);
      if (cell == null) { report.warnings.push(`annotate: zone ref not found: ${ref}`); continue; }
      const mx = mxCellPart(cell);
      mx.setAttribute('style', mergeStyle(mx.getAttribute('style') || '', { strokeColor: z.color }));
      report.zones++;
    }
  }

  // ---- 2. value-label suffixes: append to the LAST line of the drawn
  //         label only (labelFor() in place3.js emits "REF\nVALUE"); the
  //         object's `spice_value` data attribute (LVS/BOM source of truth)
  //         is untouched, matching formatComponentValue's own contract.
  for (const [ref, suffix] of Object.entries(ann.value_suffix || {})) {
    const cell = getCell(model, ref);
    if (cell == null) { report.warnings.push(`annotate: value_suffix ref not found: ${ref}`); continue; }
    if (cell.nodeName !== 'object') {
      report.warnings.push(`annotate: ${ref} has no editable label (bare mxCell, not an <object>)`);
      continue;
    }
    const label = cell.getAttribute('label') || '';
    const lines = label.split('\n');
    lines[lines.length - 1] = `${lines[lines.length - 1]} ${suffix}`.trim();
    cell.setAttribute('label', lines.join('\n'));
    report.suffixes++;
  }

  // geometry snapshot AFTER zones/suffixes (style/label-only, no geometry
  // change) but BEFORE any text/block cell is added.
  const geom = computeGeometry(model);

  // ---- 3. free-text callouts, ANCHORED (task 1) to a cell or a zone rather
  //         than to a raw reference-space cx/cy — see resolveAnchorBox()'s
  //         docstring for why. `apiAnnotation=1` (task 2) is the declared
  //         inertness marker; `text;` stays FIRST in the style string so
  //         tools/check.py's `is_text`/`style.startswith('text;')` detection
  //         (and the JS equivalent) still recognizes these as labels too.
  for (const t of ann.texts || []) {
    if (t.anchor == null) { report.warnings.push(`annotate: text "${t.text}" has no anchor`); continue; }
    const box = resolveAnchorBox(model, zonesByName, t.anchor);
    if (box == null) { report.warnings.push(`annotate: text "${t.text}" anchor not found: ${t.anchor}`); continue; }
    const pt = sideOf(box, t.side);
    const cx = pt.x + (t.dx || 0) * scale, cy = pt.y + (t.dy || 0) * scale;
    const w = t.w || Math.max(26, 6.2 * String(t.text).length);
    const h = t.h || (t.size || 11) + 8;
    const spot = findClearSpot(geom, cx, cy, w, h);
    if (spot.blocked) {
      report.warnings.push(`annotate: text "${t.text}" found no clear spot within the search ring; placed at its literal (anchored) position`);
    }
    const bold = (t.weight || 0) >= 700 ? 1 : 0;
    const style = `text;apiAnnotation=1;html=1;align=${t.align || 'center'};verticalAlign=middle;whiteSpace=wrap;` +
      `rounded=0;fillColor=none;strokeColor=none;fontColor=${t.color || '#444444'};` +
      `fontSize=${t.size || 11};fontStyle=${bold};`;
    addVertex(model, { style, x: spot.x, y: spot.y, w, h, value: t.text });
    report.texts++;
  }

  // ---- 4. PA/LNA amplifier blocks (task 2): a real amplifier triangle
  //         (flat input edge on the left, apex on the output side — this
  //         layout runs its signal chains left to right, see place3.js's own
  //         model docstring), not an empty dashed rectangle. The rectangle
  //         itself (task 1) is the UNION of the zone's member components'
  //         placed AABBs, padded — a box computed from its own members can
  //         never enclose the wrong parts, unlike the old absolute cx/cy/w/h.
  //
  //         NO findClearSpot() nudge here, unlike the text callouts above:
  //         a block is BY DESIGN meant to enclose its own zone's real
  //         components, so "clear of every component" is the wrong test for
  //         it. DRC safety does not depend on the nudge either way any more
  //         — `apiAnnotation=1` (task 2) makes tools/check.py's `through`/
  //         `edge-hug`/`comp-overlap` rules and lib/check.js's equivalent
  //         skip this cell entirely, the same way they already skip a
  //         `text;` label.
  for (const b of ann.blocks || []) {
    if (b.zone == null) { report.warnings.push(`annotate: block "${b.label || ''}" has no zone`); continue; }
    const refs = zonesByName.get(b.zone);
    if (refs == null) { report.warnings.push(`annotate: block "${b.label || ''}" zone not found: ${b.zone}`); continue; }
    let box = null;
    const missingRefs = [];
    for (const ref of refs) {
      const cell = getCell(model, ref);
      const info = cell != null ? cellInfo(cell) : null;
      if (info == null || info.x == null) { missingRefs.push(ref); continue; }
      const rect = aabbOf(info);
      box = box == null ? rect : unionRect(box, rect);
    }
    if (box == null) {
      report.warnings.push(`annotate: block "${b.label || ''}" zone "${b.zone}" has no placed member`);
      continue;
    }
    if (missingRefs.length) {
      report.warnings.push(`annotate: block "${b.label || ''}" zone "${b.zone}" missing member(s): ${missingRefs.join(',')}`);
    }
    const pad = (b.pad != null ? b.pad : 20) * scale;
    const x = box.x - pad, y = box.y - pad, w = box.w + 2 * pad, h = box.h + 2 * pad;
    const style = `shape=triangle;direction=east;apiAnnotation=1;whiteSpace=wrap;html=1;` +
      `fillColor=none;strokeColor=${b.color || '#888888'};dashed=1;` +
      `verticalAlign=top;align=center;fontColor=${b.color || '#888888'};`;
    addVertex(model, { style, x, y, w, h, value: b.label || '' });
    report.blocks++;
  }

  return report;
}
