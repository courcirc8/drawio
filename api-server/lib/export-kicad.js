/**
 * export-kicad.js — netlist SPICE → KiCad `.kicad_sch` (step 3 of
 * docs/export-multi-outils.md), same method as lib/export-xschem.js:
 *   1. placement in the geometry of KiCad's own symbols (Device:R/C/L,
 *      Simulation_SPICE:VDC/IDC/NMOS_Substrate/PMOS_Substrate, power:GND/VDD),
 *      read from the installed .kicad_sym libraries; 10 units = 1.27 mm (KiCad's
 *      50-mil grid), so a pin on our 10-grid is on KiCad's grid;
 *   2. the neutral schematic, checked by its own LVS, snapped to the grid;
 *   3. each part placed with the (angle, mirror) that puts every pin on its
 *      drawn pin; wires cut at every connection point (KiCad joins wire ENDS),
 *      junctions where three ends meet; bulks wired to their source when they
 *      share its net, else to a rail symbol or a label;
 *   4. checked by `kicad-cli sch export netlist` + lib/lvs.js
 *      (tools/kicad-check.mjs).
 * KiCad's transform (kicad-skip symbol.py, read, not copied — LGPL): mirror in
 * the symbol's frame (x: y → −y), rotate counter-clockwise there, then y down.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SPICE_MAP } from './components.js';
import { getPage } from './model.js';
import { autoPlace } from './auto.js';
import { toNeutral, checkNeutral, snapNeutral } from './neutral.js';
import { qualityGate } from './quality.js';
import { stencilFromPins, withStencilGeometry, fitOrientation } from './target-geometry.js';

export const KICAD_SYMBOLS = process.env.KICAD_SYMBOLS || (() => {
  const base = path.join(os.homedir(), '.local/share/flatpak/runtime/org.kicad.KiCad.Library.Symbols/x86_64/stable');
  try { const d = fs.readdirSync(base).find((x) => fs.existsSync(path.join(base, x, 'files/symbols/Device.kicad_sym'))); return d ? path.join(base, d, 'files/symbols') : null; } catch { return null; }
})();
export const MM = 1.27 / 10;   // mm per unit

const libCache = new Map();
/** The text of a top-level symbol of a .kicad_sym library. */
export function symbolBlock(lib, name) {
  const k = lib + ':' + name; if (libCache.has(k)) return libCache.get(k);
  const t = fs.readFileSync(path.join(KICAD_SYMBOLS, lib + '.kicad_sym'), 'utf8');
  const i = t.indexOf(`(symbol "${name}"`); if (i < 0) throw new Error(`kicad: no symbol ${lib}:${name}`);
  let depth = 0, j = i;
  for (; j < t.length; j++) { if (t[j] === '(') depth++; else if (t[j] === ')') { depth--; if (depth === 0) { j++; break; } } }
  const b = t.slice(i, j); libCache.set(k, b); return b;
}
/** Pins of a library symbol: {number: [x, y]} in mm, symbol frame (y up). */
export function kicadPins(lib, name) {
  const pins = {};
  for (const m of symbolBlock(lib, name).matchAll(/\(pin \w+ \w+\s*\(at ([-\d.]+) ([-\d.]+) \d+\)[\s\S]*?\(number "([^"]*)"/g)) pins[m[3]] = [Number(m[1]), Number(m[2])];
  return pins;
}

/** Symbol-frame point → schematic offset in units, for (angle, mirror). */
export const kxform = ([x, y], angle, mirror) => {
  if (mirror === 'x') y = -y;
  const r = (angle * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
  const rx = x * c - y * s, ry = x * s + y * c;
  return [rx / MM, -ry / MM];
};
const ORIENTS = [0, 90, 180, 270].flatMap((a) => [null, 'x'].map((m) => ({ angle: a, mirror: m, f: (p) => kxform(p, a, m) })));

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const PROFILE = {
  [SPICE_MAP.R.shape]: { lib: 'Device', sym: 'R', pins: { in: '1', out: '2' }, native: [90, null], thick: 20, pad: [0, 30, 0, 0] },
  [SPICE_MAP.C.shape]: { lib: 'Device', sym: 'C', pins: { in: '1', out: '2' }, native: [90, null], thick: 40, pad: [0, 30, 0, 0] },
  [SPICE_MAP.L.shape]: { lib: 'Device', sym: 'L', pins: { in: '1', out: '2' }, native: [90, null], thick: 20, pad: [0, 30, 0, 0] },
  [SPICE_MAP.V.shape]: { lib: 'Simulation_SPICE', sym: 'VDC', pins: { N: '1', S: '2' }, native: [0, null], thick: 40, pad: [0, 0, 40, 0] },
  [SPICE_MAP.I.shape]: { lib: 'Simulation_SPICE', sym: 'IDC', pins: { N: '1', S: '2' }, native: [0, null], thick: 40, pad: [0, 0, 40, 0] },
  [SPICE_MAP.M.shape]: { lib: 'Simulation_SPICE', sym: 'NMOS_Substrate', pins: { NE: '1', W: '2', SE: '3' }, bulk: '4', source: '3', gate: '2', native: [0, null], pad: [0, 0, 60, 0] },
  // draw.io's pmos stencil has its SOURCE at NE: KiCad's symbol mirrored (x) puts S on top
  [SPICE_MAP.M.variants.PMOS]: { lib: 'Simulation_SPICE', sym: 'PMOS_Substrate', pins: { NE: '3', W: '2', SE: '1' }, bulk: '4', source: '3', gate: '2', native: [0, 'x'], pad: [0, 0, 60, 0] },
};
const pinsPx = (e) => kicadPins(e.lib, e.sym);

function stencilOf(e) {
  const sp = pinsPx(e);
  return stencilFromPins(Object.fromEntries(Object.entries(e.pins).map(([d, s]) => [d, kxform(sp[s], e.native[0], e.native[1])])), { thick: e.thick || 20, pad: e.pad });
}
export function withKicadGeometry(fn) {
  return withStencilGeometry(Object.fromEntries(Object.entries(PROFILE).map(([k, e]) => [k, stencilOf(e)])), fn);
}

const uid = () => crypto.randomUUID();
const mm = (v) => String(Math.round(v * MM * 10000) / 10000);
const ORIGIN = 200;   // units added to every coordinate (positive sheet coordinates)

/** The `.kicad_sch` text of a neutral schematic drawn in KiCad geometry. */
export function writeKicadSch(N, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const root = uid(), libs = new Map(), out = [];
  const X = (p) => mm(p[0] + ORIGIN), Y = (p) => mm(p[1] + ORIGIN);
  const useLib = (lib, sym) => { const id = `${lib}:${sym}`; if (!libs.has(id)) libs.set(id, symbolBlock(lib, sym).replace(`(symbol "${sym}"`, `(symbol "${id}"`)); return id; };
  let pwr = 0;
  const effects = (hide) => `(effects (font (size 1.27 1.27))${hide ? ' (hide yes)' : ''})`;
  // texts left-aligned beside the part, past the symbol (dx: the symbol's half width + a step)
  // a part lying horizontally (a two-pin part at 90 / 270): its texts centred above and under it
  const inst = (libId, at, angle, mirror, ref, value, pinNums, dx = 30, lying = false) => {
    const rAt = lying ? [at[0], at[1] - 20] : [at[0] + dx, at[1] - 10], vAt = lying ? [at[0], at[1] + 20] : [at[0] + dx, at[1] + 10];
    const just = lying ? '' : ` (justify ${dx < 0 ? 'right' : 'left'})`;
    out.push(`  (symbol (lib_id ${q(libId)}) (at ${X(at)} ${Y(at)} ${angle})${mirror ? ` (mirror ${mirror})` : ''} (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid ${q(uid())})
    (property "Reference" ${q(ref)} (at ${X(rAt)} ${Y(rAt)} 0) (effects (font (size 1.27 1.27))${just}${ref.startsWith('#') ? ' (hide yes)' : ''}))
    (property "Value" ${q(value)} (at ${X(vAt)} ${Y(vAt)} 0) (effects (font (size 1.27 1.27))${just}${value === ref ? ' (hide yes)' : ''}))
    (property "Footprint" "" (at ${X(at)} ${Y(at)} 0) ${effects(true)})
    (property "Datasheet" "" (at ${X(at)} ${Y(at)} 0) ${effects(true)})
${pinNums.map((n) => `    (pin ${q(n)} (uuid ${q(uid())}))`).join('\n')}
    (instances (project "drawio" (path ${q('/' + root)} (reference ${q(ref)}) (unit 1))))
  )`);
  };
  const segs = [], pinPts = [], warnings = [];
  for (const w of N.wires) for (let k = 1; k < w.points.length; k++) segs.push({ a: w.points[k - 1], b: w.points[k], net: w.net });
  const labels = [];
  // what is drawn, by net: a bulk stub must touch nothing of another net
  const taken = [...segs.map((x) => ({ p: x.a, q: x.b, net: x.net })),
    ...N.components.flatMap((d) => Object.values(d.pins).map((x) => ({ p: x.at, q: x.at, net: x.net }))),
    ...N.rails.map((r) => ({ p: r.at, q: r.at, net: r.net })), ...N.ports.map((t) => ({ p: t.at, q: t.at, net: t.net }))];
  const onSeg = (pt, a, b) => pt[0] >= Math.min(a[0], b[0]) - 0.5 && pt[0] <= Math.max(a[0], b[0]) + 0.5 && pt[1] >= Math.min(a[1], b[1]) - 0.5 && pt[1] <= Math.max(a[1], b[1]) + 0.5
    && Math.abs((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])) < 0.5;
  const clash = (p, q2, net) => taken.some((x) => String(x.net) !== String(net) && (onSeg(x.p, p, q2) || onSeg(x.q, p, q2) || onSeg(p, x.p, x.q) || onSeg(q2, x.p, x.q)));
  const power = (net, at, kind) => { const id = useLib('power', kind === 'ground' ? 'GND' : 'VDD'); inst(id, at, 0, null, `#PWR0${++pwr}`, kind === 'ground' ? 'GND' : String(net), ['1']); };
  const portNets = new Set(N.ports.map((t) => String(t.net).toLowerCase()));
  for (const c of N.components) {
    const e = PROFILE[c.symbol]; if (!e) throw new Error(`kicad: no symbol for ${c.ref} (${c.symbol})`);
    const sp = pinsPx(e), drawn = Object.fromEntries(Object.entries(e.pins).filter(([d]) => c.pins[d]).map(([d, s]) => [s, c.pins[d].at]));
    const f = fitOrientation(sp, drawn, ORIENTS);
    if (!f) throw new Error(`kicad: ${c.ref} — no orientation of ${e.lib}:${e.sym} matches its drawn pins`);
    const src = byRef.get(String(c.ref).toUpperCase()) || {};
    const gx = e.gate ? f.orient.f(sp[e.gate])[0] : -1, side = gx > 0 ? -1 : 1;   // texts on the side away from the gate
    const dx = side * (e.bulk ? 60 : 30);
    inst(useLib(e.lib, e.sym), f.at, f.orient.angle, f.orient.mirror, c.ref, String(c.spice.value || src.value || ''), Object.keys(sp), dx, !e.bulk && Object.keys(sp).length === 2 && f.orient.angle % 180 === 90);
    for (const p of Object.values(drawn)) pinPts.push({ at: p });
    if (e.bulk) {
      const t = f.orient.f(sp[e.bulk]), s = f.orient.f(sp[e.source]), g = f.orient.f(sp[e.gate]);
      const b = [f.at[0] + t[0], f.at[1] + t[1]], sAt = [f.at[0] + s[0], f.at[1] + s[1]], bnet = c.spice.hidden?.[3] ?? c.pins.SE?.net;
      const snet = Object.entries(e.pins).find(([, v]) => v === e.source)?.[0];
      pinPts.push({ at: b });
      // a wire of another net running OVER the bulk pin (KiCad's bulk sits on the
      // source's row): KiCad joins a pin to a wire END only, so the bulk gets its
      // label on the pin and the wire is not cut there (checked by kicad-cli + LVS);
      // reported, as it reads ambiguously
      // a wire of another net with an END (or a bend) on the bulk pin: KiCad would join them — refused
      if (taken.some((x) => String(x.net) !== String(bnet) && ((x.p[0] === b[0] && x.p[1] === b[1]) || (x.q[0] === b[0] && x.q[1] === b[1]))))
        throw new Error(`kicad: a wire of another net ends on the bulk pin of ${c.ref}`);
      if (clash(b, b, bnet)) {
        labels.push({ at: b, net: bnet, angle: Math.sign(t[0] - g[0]) > 0 ? 0 : 180, noCut: true });
        warnings.push(`${c.ref}: bulk label on a wire of another net crossing the bulk pin`);
        continue;
      }
      if (snet && String(c.pins[snet]?.net) === String(bnet) && !clash(b, sAt, bnet)) { segs.push({ a: b, b: sAt, net: bnet, bulk: true }); taken.push({ p: b, q: sAt, net: bnet }); }   // bulk tied to its source
      else {
        // a stub away from the gate, touching nothing of another net; else the label on the pin itself
        const out1 = Math.sign(t[0] - g[0]) || 1;
        const len = [20, 40, 60, 80].find((L) => !clash(b, [b[0] + out1 * L, b[1]], bnet));
        const end = len == null ? b : [b[0] + out1 * len, b[1]];
        if (len != null) { segs.push({ a: b, b: end, net: bnet, bulk: true }); taken.push({ p: b, q: end, net: bnet }); }
        const rail = N.rails.find((r) => String(r.net).toLowerCase() === String(bnet).toLowerCase());
        if (String(bnet) === '0' || rail?.kind === 'ground') power('0', end, 'ground');
        else if (rail) power(rail.net, end, 'supply');
        else labels.push({ at: end, net: bnet, angle: out1 > 0 ? 0 : 180 });
        if (!rail && String(bnet) !== '0' && !portNets.has(String(bnet).toLowerCase())) {
          // an internal bulk net: the same label on a drawn pin of that net (else two nets)
          const host = N.components.flatMap((d) => Object.values(d.pins)).find((p) => String(p.net) === String(bnet));
          if (host) labels.push({ at: host.at, net: bnet, angle: 0 });
        }
      }
    }
  }
  // rails (only where a wire or pin reaches them) and ports
  const ends = new Set([...segs.flatMap((s) => [s.a.join(','), s.b.join(',')]), ...pinPts.map((p) => p.at.join(','))]);
  const seen = new Set();
  for (const r of N.rails) { const k = r.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); power(r.net, r.at, r.kind); }
  for (const t of N.ports) { const k = t.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); labels.push({ at: t.at, net: t.net, angle: 0 }); }
  // KiCad joins wire ENDS: cut every segment at each connection point lying inside it
  const noCut = new Set(labels.filter((l) => l.noCut).map((l) => l.at.join(',')));
  const points = [...new Set([...segs.flatMap((s) => [s.a, s.b]), ...pinPts.map((p) => p.at), ...labels.map((l) => l.at)].map((p) => p.join(',')))].filter((k) => !noCut.has(k)).map((k) => k.split(',').map(Number));
  const inside = (p, a, b) => (a[0] === b[0] ? p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1]) : a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));
  const cut = [];
  for (const s of segs) {
    const mids = points.filter((p) => inside(p, s.a, s.b)).sort((u, v) => Math.hypot(u[0] - s.a[0], u[1] - s.a[1]) - Math.hypot(v[0] - s.a[0], v[1] - s.a[1]));
    let a = s.a; for (const m of [...mids, s.b]) { cut.push({ a, b: m, net: s.net }); a = m; }
  }
  for (const s of cut) out.push(`  (wire (pts (xy ${X(s.a)} ${Y(s.a)}) (xy ${X(s.b)} ${Y(s.b)})) (stroke (width 0) (type default)) (uuid ${q(uid())}))`);
  // junctions where three or more ends meet
  const deg = new Map(); for (const s of cut) for (const p of [s.a, s.b]) deg.set(p.join(','), (deg.get(p.join(',')) || 0) + 1);
  for (const p of pinPts) { const k = p.at.join(','); if (deg.has(k)) deg.set(k, deg.get(k) + 1); }
  for (const [k, n] of deg) if (n >= 3) { const p = k.split(',').map(Number); out.push(`  (junction (at ${X(p)} ${Y(p)}) (diameter 0) (color 0 0 0 0) (uuid ${q(uid())}))`); }
  for (const l of labels) out.push(`  (label ${q(String(l.net) === '0' ? 'GND' : l.net)} (at ${X(l.at)} ${Y(l.at)} ${l.angle}) (effects (font (size 1.27 1.27)) (justify ${l.angle === 180 ? 'right' : 'left'} bottom)) (uuid ${q(uid())}))`);
  writeKicadSch.warnings = warnings;
  return `(kicad_sch (version 20231120) (generator "drawio-api") (uuid ${q(root)}) (paper "A3")
  (lib_symbols
${[...libs.values()].map((b) => '    ' + b.replace(/\n/g, '\n    ')).join('\n')}
  )
${out.join('\n')}
  (sheet_instances (path "/" (page "1")))
)
`;
}

/** Netlist → {sch, neutral, label, gate}; the neutral LVS must pass. */
export async function exportKicad(parsed) {
  if (!KICAD_SYMBOLS) throw new Error('kicad: symbol libraries not found (KICAD_SYMBOLS)');
  return withKicadGeometry(async () => {
    const r = await autoPlace(parsed), page = getPage(r.doc);
    const N = toNeutral(page, { target: { tool: 'kicad', unit: '1.27mm/10', grid: 10 }, source: { engine: r.label } });
    const lvs = checkNeutral(N, parsed);
    if (!lvs.match) throw Object.assign(new Error('kicad: the neutral schematic does not redraw the deck'), { lvs });
    let G = null, lvsG = null;
    for (const g of [10, 5]) { G = snapNeutral(N, g); lvsG = checkNeutral(G, parsed); if (lvsG.match) break; }
    if (!lvsG.match) throw Object.assign(new Error('kicad: rounding to the grid merged two nets'), { lvs: lvsG });
    let gate = null; try { gate = qualityGate(page, parsed); } catch { /* unknown */ }
    G.source.gate = gate ? { pass: gate.pass, failed: Object.keys(gate.checks).filter((k) => !gate.checks[k].ok) } : null;
    G.source.lvs = true;
    const sch = writeKicadSch(G, parsed);
    return { sch, neutral: G, label: r.label, gate: G.source.gate, warnings: writeKicadSch.warnings };
  });
}
