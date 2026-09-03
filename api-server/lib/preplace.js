/**
 * preplace.js — seeded PRE-PLACEMENT from the frozen hand-drawn reference.
 *
 * WHY THIS EXISTS. place3 derives an axis from the netlist alone (BFS over the
 * signal chain), which is all a `.cir` can carry. The published RF reference
 * figures carry far more: the author's own column/row assignment, which parts
 * are vertical shunts and which are series, and where the two amplifier blocks
 * sit. That is INTENT, and the retirement note for the first drawio attempt
 * (Tools/custom_skills/drawio-schematic/RETIRED.md) names exactly this as the
 * remaining gap. When we already own the reference geometry, feeding it in as a
 * starting placement is strictly better than re-deriving a worse one.
 *
 * WHERE THE NUMBERS COME FROM. Not pixel-scraped from the SVG: the seeds under
 * api-server/seeds/ are generated from the frozen builders themselves —
 * `draw_matching_<band>.py::build_schematic().devices` gives every device its
 * exact `bbox` and its `pins` dict, so the centre is exact and the rotation is
 * derived from which pin axis actually spans (|dy| > |dx| => vertical).
 *
 * WHAT IT DOES NOT DO. It never touches topology: only x/y/rotation of cells
 * already committed by place3. The LVS round-trip therefore cannot change, and
 * routing is recomputed afterwards from the moved geometry.
 *
 * THREE STEPS, in this order:
 *  1. move every seeded ref onto its reference centre, with its reference
 *     rotation;
 *  2. LEGALIZE — the reference uses per-device short leads (2446 `C13` is
 *     40 px wide there), while the drawio stencil is a fixed 80 px; transplanted
 *     centres therefore genuinely overlap in a couple of places. Overlaps are
 *     separated along the axis of least penetration rather than accepted;
 *  3. CARRY the cells that have no seed — grounds, ports, junction dots, which
 *     place3 names by net and not by refdes — by the delta of the seeded cell
 *     they were nearest to. Without this a ground stub stays behind while its
 *     capacitor moves 400 px away and the router draws the whole sheet across.
 */
import { getCell, mxCellPart, parseStyle, formatStyle, allCells } from './model.js';
import { rotatedAabb } from './route.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = path.resolve(HERE, '../seeds');

/** Load `seeds/<name>.json`. Returns null when there is no seed for that name
 *  (the caller must fall back to plain place3, never fail). */
export function loadSeed(name) {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const p = path.join(SEED_DIR, name + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function listSeeds() {
  if (!fs.existsSync(SEED_DIR)) return [];
  return fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

const centreOf = (e) => ({ cx: e.x + e.w / 2, cy: e.y + e.h / 2 });

function setGeometry(model, id, x, y, rotation, flip) {
  const cell = getCell(model, id);
  if (cell == null) return false;
  const mx = mxCellPart(cell);
  const g = mx.getElementsByTagName('mxGeometry')[0];
  if (g == null) return false;
  g.setAttribute('x', String(Math.round(x)));
  g.setAttribute('y', String(Math.round(y)));
  if (rotation != null || flip != null) {
    const st = parseStyle(mx.getAttribute('style') || '');
    if (rotation != null) {
      if (rotation === 0) st.map.delete('rotation'); else st.map.set('rotation', String(rotation));
    }
    // `flipH` and NOT `rotation += 180` to swap a dipole's ends. mxGraph rotates
    // the LABEL with `rotation` (mxText shares the cell state's rotation), so a
    // half-turn rendered `C6 / 300 fF` upside down — caught by a visual review,
    // 2026-08-31. `flipH` is applied in mxShape's paint only; mxText is drawn
    // separately and stays upright. It swaps the ends just as well because a
    // 2-terminal stencil has its pins at fx=0 and fx=1, and mxGraph mirrors the
    // connection constraint alongside the shape (mxGraph.getConnectionPoint),
    // so exitX/entryX keep naming the same electrical pin.
    if (flip != null) {
      if (flip) st.map.set('flipH', '1'); else st.map.delete('flipH');
    }
    mx.setAttribute('style', formatStyle(st));
  }
  return true;
}

function overlap(a, b, margin) {
  const dx = Math.min(a.x + a.w + margin, b.x + b.w + margin) - Math.max(a.x - margin, b.x - margin);
  const dy = Math.min(a.y + a.h + margin, b.y + b.h + margin) - Math.max(a.y - margin, b.y - margin);
  return dx > 0 && dy > 0 ? { dx, dy } : null;
}

/**
 * Apply a seed to a placed model, in place.
 *
 * @param model    mxGraphModel element (page) already populated by place3
 * @param placed   Map ref -> {id,x,y,w,h,rotation} as place3 returns it
 * @returns {{moved:string[], missing:string[], unseeded:number, separations:number, placement:object}}
 */
export function applySeed(model, placed, seed, { margin = 8, passes = 60, scale = 1 } = {}) {
  const devices = (seed && seed.devices) || {};
  const entries = [...placed.entries()].map(([ref, e]) => ({ ref, e }));
  const seededRefs = new Set(Object.keys(devices).filter((r) => placed.has(r)));
  const missing = Object.keys(devices).filter((r) => !placed.has(r));
  if (seededRefs.size === 0) return { moved: [], missing, unseeded: entries.length, separations: 0 };

  // ---- 1. transplant. `before` keeps the pre-move centres: step 3 needs them
  //         to decide which seeded cell each free cell was attached to.
  const before = new Map(entries.map(({ ref, e }) => [ref, centreOf(e)]));
  const state = new Map(); // ref -> {x,y,w,h,rotation} working copy, all cells
  // `flip` MUST be seeded from what place3 already emitted (place3.js:287 sets
  // flipH=1 itself when it orients a dipole). Initialising it to false made the
  // commit pass DELETE place3's own flips -- measured 2026-08-31: 0 -> 4 DRC
  // errors and crossings 1 -> 9.
  for (const { ref, e } of entries) state.set(ref, { x: e.x, y: e.y, w: e.w, h: e.h, rotation: e.rotation || 0, flip: !!e.flipH });
  for (const ref of seededRefs) {
    const d = devices[ref], s = state.get(ref);
    s.rotation = d.rot || 0;
    // `scale` dilates the reference ARRANGEMENT without changing it. The
    // reference draws its refdes+value beside a short-lead symbol; the drawio
    // stencil is fixed-width and carries a two-line label, so a 1:1 transplant
    // leaves the router no corridor between rails and it threads wires through
    // component bodies. Dilating about the origin keeps every column/row
    // relationship exactly as the author drew it and only adds air.
    s.x = d.cx * scale - s.w / 2;
    s.y = d.cy * scale - s.h / 2;
  }

  // adjacency keeps the pin FRACTION on the far side of each wire, because that
  // is what a junction dot and a port actually have to sit on. id -> [{other,
  // fx, fy}] where (fx,fy) is the exit/entry fraction on `other`'s own cell.
  const adj = new Map();
  const push = (k, v) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(v); };
  for (const c of allCells(model)) {
    const mx = mxCellPart(c);
    if (mx.getAttribute('edge') !== '1') continue;
    const a = mx.getAttribute('source'), b = mx.getAttribute('target');
    if (!a || !b) continue;
    const st = parseStyle(mx.getAttribute('style') || '').map;
    const ex = st.has('exitX') ? { fx: parseFloat(st.get('exitX')), fy: parseFloat(st.get('exitY')) } : null;
    const en = st.has('entryX') ? { fx: parseFloat(st.get('entryX')), fy: parseFloat(st.get('entryY')) } : null;
    push(a, { other: b, pin: en, self: ex }); // from a: far pin = ENTRY on b, near = EXIT on a
    push(b, { other: a, pin: ex, self: en }); // from b: far pin = EXIT on a,  near = ENTRY on b
  }
  const idToRefEarly = new Map(entries.map(({ ref, e }) => [e.id, ref]));
  /** Absolute position of pin fraction (fx,fy) on a cell in its post-seed state. */
  const pinAbsOf = (st, fx, fy) => {
    const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
    const px = st.x + (st.flip ? 1 - fx : fx) * st.w, py = st.y + fy * st.h;
    const r = ((st.rotation || 0) * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r);
    return { x: cx + (px - cx) * c - (py - cy) * n, y: cy + (px - cx) * n + (py - cy) * c };
  };
  const kindOf = (e) => {
    const cell = getCell(model, e.id);
    const style = cell != null ? (mxCellPart(cell).getAttribute('style') || '') : '';
    if (style.includes('drawioApiJunction')) return 'junction';
    if (style.includes('apiShape=port')) return 'port';
    if (style.includes('signal_ground')) return 'ground';
    return 'other';
  };

  // ---- 2. legalize the seeded set only. The reference's short-lead devices
  //         are narrower than the fixed-width stencil, so a faithful centre
  //         transplant can collide; separate along the shallower axis.
  let separations = 0;
  const list = [...seededRefs];
  for (let pass = 0; pass < passes; pass++) {
    let hit = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = state.get(list[i]), B = state.get(list[j]);
        const ba = rotatedAabb({ ...A }), bb = rotatedAabb({ ...B });
        const ov = overlap(ba, bb, margin);
        if (ov == null) continue;
        hit = true; separations++;
        const push = Math.ceil((Math.min(ov.dx, ov.dy) + 2) / 2);
        if (ov.dx <= ov.dy) {
          const s = (ba.x + ba.w / 2) <= (bb.x + bb.w / 2) ? -1 : 1;
          A.x += s * push; B.x -= s * push;
        } else {
          const s = (ba.y + ba.h / 2) <= (bb.y + bb.h / 2) ? -1 : 1;
          A.y += s * push; B.y -= s * push;
        }
      }
    }
    if (!hit) break;
  }

  // ---- 2b. ORIENTATION. The seed records rotation (which axis a part lies on)
  //          but not WHICH END is which, and place3 does not orient a dipole by
  //          its nets the way place2 does. Result on 2446: C6's right pin faced
  //          away from the node it feeds and the router boxed the wire around
  //          the body — one `wrap-around` error, stable at every seed scale.
  //          Mirroring a 2-terminal passive is electrically free and changes no
  //          edge binding (flipH is a style key; the exit/entry fractions are
  //          untouched), so pick the orientation that puts each pin
  //          on the side its own destination is on. Cost is pin-to-PIN, not
  //          pin-to-centre: measured, pin-to-centre picks the wrong end because
  //          a long part's far centre dominates the sum.
  const linksOf = (ref) => (adj.get(placed.get(ref).id) || [])
    .map((l) => ({ r: idToRefEarly.get(l.other), pin: l.pin, self: l.self }))
    .filter((l) => l.r != null && l.pin != null && l.self != null);
  let flips = 0;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const ref of seededRefs) {
      const ls = linksOf(ref);
      if (ls.length < 2) continue;
      const st = state.get(ref);
      const cost = (flip) => {
        const probe = { ...st, flip };
        let t = 0;
        for (const l of ls) {
          const a = pinAbsOf(probe, l.self.fx, l.self.fy);
          const o = state.get(l.r);
          const b = o != null ? pinAbsOf(o, l.pin.fx, l.pin.fy)
            : { x: before.get(l.r).cx, y: before.get(l.r).cy };
          t += Math.hypot(a.x - b.x, a.y - b.y);
        }
        return t;
      };
      const cur = !!st.flip;
      if (cost(!cur) < cost(cur) - 1) { st.flip = !cur; changed = true; flips++; }
    }
    if (!changed) break;
  }

  // ---- 3. carry the unseeded cells (grounds / ports / junction dots), which
  //         place3 names by NET and not by refdes so no seed can name them.
  //
  //         Not by nearest-neighbour delta: that was the first cut and it is
  //         wrong as soon as a seeded part CHANGES ORIENTATION. 2446's C1 is
  //         horizontal in place3 and vertical in the reference; its ground stub
  //         sat to its right and must end up below it. So carry each free cell
  //         by the cell it is actually WIRED to, and rotate its offset by that
  //         anchor's own rotation change. The offset itself is never scaled — a
  //         stub length is a stub length, `scale` only dilates the arrangement.
  const idToRef = new Map(entries.map(({ ref, e }) => [e.id, ref]));
  const rotOf = (ref) => {
    const e = placed.get(ref);
    return ((state.get(ref).rotation || 0) - ((e && e.rotation) || 0) + 360) % 360;
  };
  /** The rotated-offset carry: keep this cell where it sat relative to the one
   *  seeded cell it is wired to, turning the offset with that cell's own
   *  rotation change. Correct for a LOCAL stub (a ground), wrong for anything
   *  that belongs to several pins at once. */
  const carry = (ref, wiredRefs) => {
    const b = before.get(ref);
    let anchor = null, bestD = Infinity;
    for (const r of (wiredRefs.length ? wiredRefs : [...seededRefs])) {
      const ab = before.get(r);
      const dd = (ab.cx - b.cx) ** 2 + (ab.cy - b.cy) ** 2;
      if (dd < bestD) { bestD = dd; anchor = r; }
    }
    if (anchor == null) return;
    const ab = before.get(anchor), as = state.get(anchor);
    let ox = b.cx - ab.cx, oy = b.cy - ab.cy;
    const dr = rotOf(anchor);
    if (dr === 90) { [ox, oy] = [-oy, ox]; }
    else if (dr === 180) { [ox, oy] = [-ox, -oy]; }
    else if (dr === 270) { [ox, oy] = [oy, -ox]; }
    const s = state.get(ref);
    s.x = (as.x + as.w / 2) + ox - s.w / 2;
    s.y = (as.y + as.h / 2) + oy - s.h / 2;
  };

  let unseeded = 0;
  const report = { junction: 0, port: 0, ground: 0, carried: 0 };
  for (const { ref, e } of entries) {
    if (seededRefs.has(ref)) continue;
    unseeded++;
    // every wire from this cell that lands on a SEEDED cell, with the pin
    // fraction it lands on
    const links = (adj.get(e.id) || [])
      .map((l) => ({ r: idToRef.get(l.other), pin: l.pin }))
      .filter((l) => l.r != null && seededRefs.has(l.r) && l.pin != null);
    const wiredRefs = [...new Set((adj.get(e.id) || []).map((l) => idToRef.get(l.other))
      .filter((r) => r != null && seededRefs.has(r)))];
    const kind = kindOf(e);
    const s = state.get(ref);

    // JUNCTION of >= 3 terminals: it IS the meeting point of those pins, so put
    // it at their centroid. This is the defect this whole pass exists for: the
    // Bp dot was carried by ONE of the three parts it joins and landed ~150 px
    // below the rail, which is what made C1's Bp pin wrap around its own body.
    // Below 3 terminals a centroid is a segment midpoint — a dot floating in the
    // middle of a plain wire, which is exactly what a dot must never mean — so
    // those keep the carry.
    if (kind === 'junction' && links.length >= 3) {
      const pins = links.map((l) => pinAbsOf(state.get(l.r), l.pin.fx, l.pin.fy));
      let c = { x: pins.reduce((a, p) => a + p.x, 0) / pins.length,
        y: pins.reduce((a, p) => a + p.y, 0) / pins.length };
      // The centroid of 3 pins can land INSIDE a fourth component. Measured on
      // 2446: J_n_pi1_out's centroid fell in C12's body and the router then had
      // to drive three wires through it (3 `through` errors where there had been
      // none). A dot sitting on one of its OWN pins is always legal and always
      // means the right thing, so fall back to the pin nearest the centroid
      // rather than nudging blindly into more open space.
      const bodies = [...seededRefs].map((r) => rotatedAabb({ ...state.get(r) }));
      const inside = (pt) => bodies.some((b) => pt.x > b.x - 2 && pt.x < b.x + b.w + 2 &&
        pt.y > b.y - 2 && pt.y < b.y + b.h + 2);
      if (inside(c)) {
        let best = null, bd = Infinity;
        for (const p of pins) {
          const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
          if (d < bd) { bd = d; best = p; }
        }
        c = best;
      }
      s.x = c.x - s.w / 2; s.y = c.y - s.h / 2;
      report.junction++; continue;
    }
    // PORT: a single external terminal. It belongs pushed OUTWARD from the pin
    // it taps, along that pin's own outward normal in the anchor's new
    // orientation — never at a centroid, which would drag it inward on top of
    // the parts it feeds.
    if (kind === 'port' && links.length === 1) {
      const l = links[0], as = state.get(l.r);
      const p = pinAbsOf(as, l.pin.fx, l.pin.fy);
      const cx = as.x + as.w / 2, cy = as.y + as.h / 2;
      let nx = p.x - cx, ny = p.y - cy;
      const n = Math.hypot(nx, ny) || 1;
      // keep the stub length place3 chose; only its DIRECTION is re-derived
      const stub = Math.max(28, Math.hypot(before.get(ref).cx - before.get(l.r).cx,
        before.get(ref).cy - before.get(l.r).cy) - Math.max(as.w, as.h) / 2);
      s.x = p.x + (nx / n) * stub - s.w / 2;
      s.y = p.y + (ny / n) * stub - s.h / 2;
      report.port++; continue;
    }
    // GROUND (and everything else): stays LOCAL to its one attachment. A ground
    // net is shared by every shunt on the sheet, so anything net-global would
    // collapse all ground stubs onto one point in the middle of the drawing.
    carry(ref, wiredRefs);
    if (kind === 'ground') report.ground++; else report.carried++;
  }

  // ---- commit to the XML and back into `placed`
  const moved = [];
  for (const { ref, e } of entries) {
    const s = state.get(ref);
    const rot = seededRefs.has(ref) ? s.rotation : null;
    const flip = seededRefs.has(ref) ? !!s.flip : null;
    if (flip != null) e.flipH = flip;
    if (setGeometry(model, e.id, s.x, s.y, rot, flip)) moved.push(ref);
    e.x = Math.round(s.x); e.y = Math.round(s.y);
    if (rot != null) e.rotation = rot;
  }
  return { moved, missing, unseeded, separations, flips, placement: report };
}
