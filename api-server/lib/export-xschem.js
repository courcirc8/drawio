/**
 * export-xschem.js — netlist SPICE → xschem `.sch` with the IHP SG13G2 kit
 * (step 2 of docs/export-multi-outils.md).
 *
 *   1. PLACEMENT IN THE TARGET'S GEOMETRY: while auto draws, the stencils of
 *      the parts get the size and pin positions of their xschem symbols, read
 *      from the symbol files themselves (pins = `B 5` boxes on layer 5);
 *      1 xschem unit = 1 px, xschem's grid is 10.
 *   2. The drawn page becomes the neutral schematic (lib/neutral.js), checked
 *      by its own LVS before anything is written.
 *   3. Each part becomes a `C {symbol} x y rot flip {props}` line: the (rot,
 *      flip) among the 8 that puts EVERY pin of the symbol on the drawn pin is
 *      searched (none → refused); wires become `N` segments; ground / supply
 *      symbols, ports and MOS bulks become gnd / vdd / lab_pin symbols.
 *   4. The caller checks the file with xschem's own netlister + lib/lvs.js
 *      (tools/xschem-check.mjs): a file that does not redraw the deck is never
 *      delivered.
 * xschem transform (src/xschem.h ROTATION macro, read, not copied — GPL):
 * mirror x first, then rot 1 = (x, y) → (−y, x), 2 = (−x, −y), 3 = (y, −x).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getShape } from './stencils.js';
import { SPICE_MAP } from './components.js';
import { getPage } from './model.js';
import { autoPlace } from './auto.js';
import { toNeutral, checkNeutral, snapNeutral } from './neutral.js';
import { qualityGate } from './quality.js';

const SIM = process.env.SIM_ROOT || '/home/courcirc8/ClaudeCode/simulation';
export const IHP_XSCHEM = process.env.IHP_XSCHEM || `${SIM}/references/IHP-GmbH_IHP-Open-PDK/ihp-sg13g2/libs.tech/xschem`;
export const XSCHEM_DEVICES = process.env.XSCHEM_DEVICES || `${SIM}/opt/xschem/share/xschem/xschem_library/devices`;

/** Pins of an xschem symbol: {name: [x, y]} (centre of each layer-5 box). */
export function readSymbolPins(file) {
  const pins = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^B 5 (\S+) (\S+) (\S+) (\S+) \{[^}]*?name=([^\s}]+)/.exec(line);
    if (m) pins[m[5]] = [(Number(m[1]) + Number(m[3])) / 2, (Number(m[2]) + Number(m[4])) / 2];
  }
  return pins;
}

export const xform = ([x, y], rot, flip) => {
  const fx = flip ? -x : x;
  return [[fx, y], [-y, fx], [-fx, -y], [y, -fx]][rot & 3];
};

// drawio stencil → xschem symbol; pin map (drawio pin → symbol pin); the
// (rot, flip) of the symbol that matches the stencil's NATIVE orientation;
// the box (thickness across the pins); the instance properties
const devs = (s) => path.join(XSCHEM_DEVICES, s), ihp = (s) => path.join(IHP_XSCHEM, 'sg13g2_pr', s);
// a property value inside a `{…}` block: braces and backslashes escaped (xschem syntax)
const fmt = (v) => String(v ?? '').trim().replace(/[\\{}]/g, (m) => '\\' + m);
const mosProps = (c) => { const p = c.params || {}; return `name=${c.ref}\nl=${fmt(p.l || '0.13u')}\nw=${fmt(p.w || '1u')}\nng=1\nm=${fmt(p.m || '1')}\nmodel=${c.pmos ? 'sg13_lv_pmos' : 'sg13_lv_nmos'}\nspiceprefix=X`; };
export const PROFILE = {
  [SPICE_MAP.R.shape]: { sym: 'res.sym', file: devs('res.sym'), pins: { in: 'P', out: 'M' }, native: [3, 0], thick: 20, props: (c) => `name=${c.ref}\nvalue=${fmt(c.value) || '1k'}\nm=1` },
  [SPICE_MAP.C.shape]: { sym: 'capa.sym', file: devs('capa.sym'), pins: { in: 'p', out: 'm' }, native: [3, 0], thick: 40, props: (c) => `name=${c.ref}\nvalue=${fmt(c.value) || '1p'}\nm=1` },
  [SPICE_MAP.L.shape]: { sym: 'ind.sym', file: devs('ind.sym'), pins: { in: 'p', out: 'm' }, native: [3, 0], thick: 20, props: (c) => `name=${c.ref}\nvalue=${fmt(c.value) || '1n'}\nm=1` },
  [SPICE_MAP.V.shape]: { sym: 'vsource.sym', file: devs('vsource.sym'), pins: { N: 'p', S: 'm' }, native: [0, 0], thick: 40, props: (c) => `name=${c.ref}\nvalue="${fmt(c.value) || '0'}"` },
  [SPICE_MAP.I.shape]: { sym: 'isource.sym', file: devs('isource.sym'), pins: { N: 'p', S: 'm' }, native: [0, 0], thick: 40, props: (c) => `name=${c.ref}\nvalue="${fmt(c.value) || '0'}"` },
  [SPICE_MAP.M.shape]: { sym: 'sg13g2_pr/sg13_lv_nmos.sym', file: ihp('sg13_lv_nmos.sym'), pins: { NE: 'D', W: 'G', SE: 'S' }, bulk: 'B', native: [0, 0], props: mosProps },
  // PMOS: draw.io's pmos stencil has its SOURCE at NE and its drain at SE (pinOrderFor)
  [SPICE_MAP.M.variants.PMOS]: { sym: 'sg13g2_pr/sg13_lv_pmos.sym', file: ihp('sg13_lv_pmos.sym'), pins: { NE: 'S', W: 'G', SE: 'D' }, bulk: 'B', native: [0, 0], props: (c) => mosProps({ ...c, pmos: true }) },
};

/** Stencil geometry (w, h, relative pins) of a profile entry, in its native orientation. */
function stencilOf(e) {
  const sp = readSymbolPins(e.file);
  const pts = Object.fromEntries(Object.entries(e.pins).map(([d, s]) => [d, xform(sp[s], e.native[0], e.native[1])]));
  const xs = Object.values(pts).map((p) => p[0]), ys = Object.values(pts).map((p) => p[1]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // a two-pin part has no width across its pins: give it its body's thickness
  if (x1 - x0 < 1) { x0 -= (e.thick || 20) / 2; x1 += (e.thick || 20) / 2; }
  if (y1 - y0 < 1) { y0 -= (e.thick || 20) / 2; y1 += (e.thick || 20) / 2; }
  const w = x1 - x0, h = y1 - y0;
  return { w, h, pins: Object.entries(pts).map(([name, p]) => ({ name, x: (p[0] - x0) / w, y: (p[1] - y0) / h })) };
}

let lock = Promise.resolve();
/** Run fn with the stencils of the profiled parts given their xschem geometry (serialised: the catalog is shared). */
export function withXschemGeometry(fn) {
  const run = lock.then(async () => {
    const saved = [];
    try {
      for (const [key, e] of Object.entries(PROFILE)) {
        const s = getShape(key); if (!s) continue;
        saved.push([s, { w: s.w, h: s.h, pins: s.pins }]);
        Object.assign(s, stencilOf(e));
      }
      return await fn();
    } finally { for (const [s, g] of saved) Object.assign(s, g); }
  });
  lock = run.catch(() => {});
  return run;
}

/** The (rot, flip, origin) placing every pin of a symbol on its drawn pin, or null. */
function fit(symPins, drawn) {
  const names = Object.keys(drawn);
  for (let rot = 0; rot < 4; rot++) for (const flip of [0, 1]) {
    const [n0] = names, t0 = xform(symPins[n0], rot, flip), o = [drawn[n0][0] - t0[0], drawn[n0][1] - t0[1]];
    if (names.every((n) => { const t = xform(symPins[n], rot, flip); return Math.abs(o[0] + t[0] - drawn[n][0]) < 0.6 && Math.abs(o[1] + t[1] - drawn[n][1]) < 0.6; })) return { rot, flip, at: o };
  }
  return null;
}

const num = (v) => (Math.round(v * 100) / 100).toString();
// xschem names unlabelled nets net1, net2…: a deck net spelled like that, put
// on a label, would be merged by name with one of them — renamed with a suffix
const netName = (n) => (n === '0' ? 'GND' : /^#?net\d+$/i.test(String(n)) ? `${n}_d` : String(n));

/** The `.sch` text of a neutral schematic drawn in xschem geometry; throws on a part it cannot place exactly. */
export function writeSch(N, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const lines = ['v {xschem version=3.4.8RC file_version=1.3}', 'G {}', 'K {}', 'V {}', 'S {}', 'E {}'];
  const C = (sym, at, rot, flip, props) => lines.push(`C {${sym}} ${num(at[0])} ${num(at[1])} ${rot} ${flip} {${props}}`);
  let lab = 0;
  // a lab_pin writes its text to the LEFT of its pin (flip 1: to the right):
  // the text goes away from the wire reaching the label, or the given side
  const segs = N.wires.flatMap((w) => w.points.slice(1).map((b, k) => [w.points[k], b]));
  const awayFlip = (at) => { const s = segs.find(([a, b]) => (a[0] === at[0] && a[1] === at[1]) || (b[0] === at[0] && b[1] === at[1])); if (!s) return 0; const o = s[0][0] === at[0] && s[0][1] === at[1] ? s[1] : s[0]; return o[0] < at[0] ? 1 : 0; };
  const label = (at, net, flip = awayFlip(at)) => C('lab_pin.sym', at, 0, flip, `name=l${++lab} sig_type=std_logic lab=${netName(net)}`);
  const pinPts = [], bulks = [];
  // what is already drawn, by net: a bulk stub must touch none of another net
  const taken = [...N.wires.flatMap((w) => w.points.slice(1).map((q, k) => ({ p: w.points[k], q, net: w.net }))),
    ...N.components.flatMap((c) => Object.values(c.pins).map((x) => ({ p: x.at, q: x.at, net: x.net }))),
    ...N.rails.map((r) => ({ p: r.at, q: r.at, net: r.net })), ...N.ports.map((t) => ({ p: t.at, q: t.at, net: t.net }))];
  const onSeg = (pt, a, b) => pt[0] >= Math.min(a[0], b[0]) - 0.5 && pt[0] <= Math.max(a[0], b[0]) + 0.5 && pt[1] >= Math.min(a[1], b[1]) - 0.5 && pt[1] <= Math.max(a[1], b[1]) + 0.5
    && Math.abs((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])) < 0.5;
  const overlap = (a, b, c, d) => onSeg(c, a, b) || onSeg(d, a, b) || onSeg(a, c, d) || onSeg(b, c, d);
  const clash = (p, q, net) => taken.some((x) => String(x.net) !== String(net) && overlap(p, q, x.p, x.q));
  for (const c of N.components) {
    const e = PROFILE[c.symbol];
    if (!e) throw new Error(`xschem: no symbol for ${c.ref} (${c.symbol})`);
    const sp = readSymbolPins(e.file);
    const drawn = Object.fromEntries(Object.entries(e.pins).filter(([d]) => c.pins[d]).map(([d, s]) => [s, c.pins[d].at]));
    const f = fit(sp, drawn);
    if (!f) throw new Error(`xschem: ${c.ref} — no orientation of ${e.sym} matches its drawn pins`);
    const src = byRef.get(String(c.ref).toUpperCase()) || {};
    // W / L / M of a MOS line ("nmos W=2u L=0.13u")
    const params = Object.fromEntries([...String(src.value || '').matchAll(/\b([wlm])\s*=\s*([^\s]+)/gi)].map((m) => [m[1].toLowerCase(), m[2]]));
    C(e.sym, f.at, f.rot, f.flip, e.props({ ref: c.ref, value: c.spice.value || src.value, params }));
    for (const p of Object.values(drawn)) pinPts.push(p.join(','));
    // the bulk: a label with its net, on the symbol's bulk pin
    // the bulk, as the IHP schematics draw it (sg13g2_tests/dc_lv_nmos.sch):
    // a short wire outward from B, then the ground / supply symbol when the
    // bulk is on a rail, else a label (text outward)
    if (e.bulk) {
      const t = xform(sp[e.bulk], f.rot, f.flip), bnet = c.spice.hidden?.[3] ?? c.pins.SE?.net;
      const b = [f.at[0] + t[0], f.at[1] + t[1]], out = t[0] >= 0 ? 1 : -1;
      const rail = N.rails.find((r) => r.net === bnet), gnd = bnet === '0' || rail?.kind === 'ground';
      // first free stub (no point or wire of another net on it): outward, then inward, longer
      let done = false;
      for (const side of [out, -out]) for (const len of [60, 80, 100, 40]) {
        if (done) break;
        const end = [b[0] + side * len, b[1]], tip = gnd ? [end[0], end[1] + 30] : rail ? [end[0], end[1] - 30] : end;
        const path = [[b, end], ...(tip !== end ? [[end, tip]] : [])];
        if (path.some(([p, q]) => clash(p, q, bnet))) continue;
        bulks.push({ net: bnet, points: tip !== end ? [b, end, tip] : [b, end] }); taken.push(...path.map(([p, q]) => ({ p, q, net: bnet })));
        if (gnd) C('gnd.sym', tip, 0, 0, `name=g${++lab} lab=GND`);
        else if (rail) C('vdd.sym', tip, 0, 0, `name=v${++lab} lab=${netName(rail.net)}`);
        else label(end, bnet, side > 0 ? 1 : 0);
        done = true;
      }
      if (!done) label(b, bnet, out > 0 ? 1 : 0);   // (no free stub: the label on the bulk pin itself)
    }
  }
  for (const w of [...N.wires, ...bulks]) for (let k = 1; k < w.points.length; k++) {
    const a = w.points[k - 1], b = w.points[k];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    lines.push(`N ${num(a[0])} ${num(a[1])} ${num(b[0])} ${num(b[1])} {lab=${netName(w.net ?? '')}}`);
  }
  const ends = new Set([...N.wires.flatMap((w) => [w.points[0].join(','), w.points.at(-1).join(',')]), ...pinPts]);
  const seen = new Set();
  for (const r of N.rails) {
    const k = r.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k);
    if (r.kind === 'ground') C('gnd.sym', r.at, 0, 0, `name=g${++lab} lab=GND`);
    else C('vdd.sym', r.at, 0, 0, `name=v${++lab} lab=${netName(r.net)}`);
  }
  for (const t of N.ports) { const k = t.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); label(t.at, t.net); }
  return lines.join('\n') + '\n';
}

/** Netlist → {sch, neutral, label, lvs}; the neutral LVS must pass. */
export async function exportXschem(parsed) {
  return withXschemGeometry(async () => {
    const r = await autoPlace(parsed), page = getPage(r.doc);
    const N = toNeutral(page, { target: { tool: 'xschem', unit: 'xschem', grid: 10, pdk: 'ihp-sg13g2' }, source: { engine: r.label } });
    const lvs = checkNeutral(N, parsed);
    if (!lvs.match) throw Object.assign(new Error('xschem: the neutral schematic does not redraw the deck'), { lvs });
    // on xschem's grid (10); when rounding merges two wires 5 units apart,
    // the half grid (5) — reported in target.grid — else refused
    let G = null, lvsG = null;
    for (const g of [10, 5]) { G = snapNeutral(N, g); lvsG = checkNeutral(G, parsed); if (lvsG.match) break; }
    if (!lvsG.match) throw Object.assign(new Error('xschem: rounding to the grid merged two nets'), { lvs: lvsG });
    // Eric's rules in the TARGET geometry: the quality gate on the page drawn with xschem's symbols
    let gate = null; try { gate = qualityGate(page, parsed); } catch { /* reported as unknown */ }
    G.source.gate = gate ? { pass: gate.pass, failed: Object.keys(gate.checks).filter((k) => !gate.checks[k].ok) } : null;
    G.source.lvs = true;
    return { sch: writeSch(G, parsed), neutral: G, label: r.label, gate: G.source.gate, doc: r.doc };
  });
}
