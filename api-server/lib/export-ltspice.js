/**
 * export-ltspice.js — netlist SPICE → LTspice `.asc` WITH WIRES (step 4 of
 * docs/export-multi-outils.md). Replaces, for the skill, lib/export-asc.js's
 * flags-only encoding (one named flag per pin: a connection by name, which
 * Eric's rules refuse for drawings).
 *
 * Same method as the other targets: placement in the geometry of LTspice's own
 * symbols (pin tables data/ltspice-symbols.json — Weave, MIT, already in the
 * repository; 16 LTspice units = 10 of ours, LTspice's grid), the neutral
 * schematic and its LVS, each part placed with the (rotation, mirror) that puts
 * every pin on its drawn pin, real wires. Ground: FLAG 0; supplies and ports:
 * named flags (a rail is a name in every tool); bulks: a short wire to a
 * ground flag or a named flag.
 * LTspice's transform (as tools/asc2spice.mjs reads it): mirror x → −x, then
 * R90 (x, y) → (−y, x). LTspice joins a pin lying ON a wire: a bulk pin crossed
 * by another net is refused.
 * Checked by tools/asc2spice.mjs (independent reader of the .asc) + lib/lvs.js:
 * LTspice itself is not installed here (deliverLtspice, tools/ltspice-check.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPICE_MAP } from './components.js';
import { getPage } from './model.js';
import { autoPlace } from './auto.js';
import { toNeutral, checkNeutral, snapNeutral } from './neutral.js';
import { qualityGate } from './quality.js';
import { stencilFromPins, withStencilGeometry, fitOrientation } from './target-geometry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LT = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'ltspice-symbols.json'), 'utf8'));
export const K = 1.6;   // LTspice units per unit
const pinsOf = (sym) => Object.fromEntries(LT[sym].ord.map((n, i) => [String(n), LT[sym].pins[i]]));

/** LTspice orientation code → (symbol-frame point → offset in units). */
export const lxform = ([x, y], code) => {
  if (code[0] === 'M') x = -x;
  const k = parseInt(code.slice(1), 10);
  const r = k === 0 ? [x, y] : k === 90 ? [-y, x] : k === 180 ? [-x, -y] : [y, -x];
  return [r[0] / K + 0, r[1] / K + 0];
};
const ORIENTS = ['R0', 'R90', 'R180', 'R270', 'M0', 'M90', 'M180', 'M270'].map((c) => ({ code: c, f: (p) => lxform(p, c) }));

export const PROFILE = {
  [SPICE_MAP.R.shape]: { sym: 'res', pins: { in: '1', out: '2' }, native: 'R270', thick: 20, pad: [0, 30, 0, 0] },
  [SPICE_MAP.C.shape]: { sym: 'cap', pins: { in: '1', out: '2' }, native: 'R270', thick: 40, pad: [0, 30, 0, 0] },
  [SPICE_MAP.L.shape]: { sym: 'ind', pins: { in: '1', out: '2' }, native: 'R270', thick: 20, pad: [0, 30, 0, 0] },
  [SPICE_MAP.V.shape]: { sym: 'voltage', pins: { N: '1', S: '2' }, native: 'R0', thick: 40, pad: [0, 0, 40, 0] },
  [SPICE_MAP.I.shape]: { sym: 'current', pins: { N: '1', S: '2' }, native: 'R0', thick: 40, pad: [0, 0, 40, 0] },
  [SPICE_MAP.M.shape]: { sym: 'nmos4', pins: { NE: '1', W: '2', SE: '3' }, bulk: '4', gate: '2', native: 'R0', pad: [0, 0, 60, 0] },
  // draw.io's pmos stencil has its SOURCE at NE: LTspice's pmos4 mirrored vertically (M180)
  [SPICE_MAP.M.variants.PMOS]: { sym: 'pmos4', pins: { NE: '3', W: '2', SE: '1' }, bulk: '4', gate: '2', native: 'M180', pad: [0, 0, 60, 0] },
};
function stencilOf(e) {
  const sp = pinsOf(e.sym);
  return stencilFromPins(Object.fromEntries(Object.entries(e.pins).map(([d, s]) => [d, lxform(sp[s], e.native)])), { thick: e.thick || 20, pad: e.pad });
}
export function withLtspiceGeometry(fn) {
  return withStencilGeometry(Object.fromEntries(Object.entries(PROFILE).map(([k, e]) => [k, stencilOf(e)])), fn);
}

const ORIGIN = 100;
/** The `.asc` text of a neutral schematic drawn in LTspice geometry. */
export function writeAsc(N, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const L = (p) => [Math.round((p[0] + ORIGIN) * K), Math.round((p[1] + ORIGIN) * K)];
  const syms = [], flags = [], segs = [];
  for (const w of N.wires) for (let k = 1; k < w.points.length; k++) segs.push({ a: w.points[k - 1], b: w.points[k], net: w.net });
  const taken = [...segs.map((x) => ({ p: x.a, q: x.b, net: x.net })),
    ...N.components.flatMap((d) => Object.values(d.pins).map((x) => ({ p: x.at, q: x.at, net: x.net }))),
    ...N.rails.map((r) => ({ p: r.at, q: r.at, net: r.net })), ...N.ports.map((t) => ({ p: t.at, q: t.at, net: t.net }))];
  const onSeg = (pt, a, b) => pt[0] >= Math.min(a[0], b[0]) - 0.5 && pt[0] <= Math.max(a[0], b[0]) + 0.5 && pt[1] >= Math.min(a[1], b[1]) - 0.5 && pt[1] <= Math.max(a[1], b[1]) + 0.5
    && Math.abs((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])) < 0.5;
  const clash = (p, q, net) => taken.some((x) => String(x.net) !== String(net) && (onSeg(x.p, p, q) || onSeg(x.q, p, q) || onSeg(p, x.p, x.q) || onSeg(q, x.p, x.q)));
  // an unnamed net of the drawing is called n1, n2…: a flag with that name would merge, by name,
  // with the net the reader (and LTspice) names n1, n2… itself — renamed with a suffix
  const flagName = (net) => (String(net) === '0' ? '0' : /^n\d+$/i.test(String(net)) ? `${net}_b` : String(net));
  const flag = (at, net) => flags.push(`FLAG ${L(at).join(' ')} ${flagName(net)}`);
  const pinPts = [];
  for (const c of N.components) {
    const e = PROFILE[c.symbol]; if (!e) throw new Error(`ltspice: no symbol for ${c.ref} (${c.symbol})`);
    const sp = pinsOf(e.sym), drawn = Object.fromEntries(Object.entries(e.pins).filter(([d]) => c.pins[d]).map(([d, s]) => [s, c.pins[d].at]));
    const f = fitOrientation(sp, drawn, ORIENTS);
    if (!f) throw new Error(`ltspice: ${c.ref} — no orientation of ${e.sym} matches its drawn pins`);
    const src = byRef.get(String(c.ref).toUpperCase()) || {};
    const val = String(c.spice.value || src.value || '').trim();
    const lines = [`SYMBOL ${e.sym} ${L(f.at).join(' ')} ${f.orient.code}`, `SYMATTR InstName ${c.ref}`];
    if (e.bulk) {
      const [model, ...rest] = val.split(/\s+/);
      lines.push(`SYMATTR Value ${model || (e.sym === 'pmos4' ? 'pmos' : 'nmos')}`); if (rest.length) lines.push(`SYMATTR Value2 ${rest.join(' ')}`);
    } else lines.push(`SYMATTR Value ${val.replace(/^\s*dc\s+/i, '') || '0'}`);
    syms.push(lines.join('\n'));
    for (const p of Object.values(drawn)) pinPts.push(p);
    if (e.bulk) {
      const t = f.orient.f(sp[e.bulk]), g = f.orient.f(sp[e.gate]);
      const b = [f.at[0] + t[0], f.at[1] + t[1]], bnet = c.spice.hidden?.[3] ?? c.pins.SE?.net;
      if (taken.some((x) => String(x.net) !== String(bnet) && onSeg(b, x.p, x.q))) throw new Error(`ltspice: a wire of another net touches the bulk pin of ${c.ref}`);
      pinPts.push(b);
      const out = Math.sign(t[0] - g[0]) || 1, len = [20, 40, 60, 80].find((Ln) => !clash(b, [b[0] + out * Ln, b[1]], bnet));
      if (len == null) throw new Error(`ltspice: no room for the bulk wire of ${c.ref}`);
      const end = [b[0] + out * len, b[1]];
      segs.push({ a: b, b: end, net: bnet }); taken.push({ p: b, q: end, net: bnet });
      const rail = N.rails.find((r) => String(r.net).toLowerCase() === String(bnet).toLowerCase());
      flag(end, String(bnet) === '0' || rail?.kind === 'ground' ? '0' : rail ? rail.net : bnet);
      if (!rail && String(bnet) !== '0' && !N.ports.some((p) => String(p.net).toLowerCase() === String(bnet).toLowerCase())) {
        // an internal bulk net: the same flag on a drawn point of that net (else two nets)
        const host = N.components.flatMap((d) => Object.values(d.pins)).find((p) => String(p.net) === String(bnet));
        if (host) flag(host.at, bnet);
      }
    }
  }
  const ends = new Set([...segs.flatMap((x) => [x.a.join(','), x.b.join(',')]), ...pinPts.map((p) => p.join(','))]);
  const seen = new Set();
  for (const r of N.rails) { const k = r.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); flag(r.at, r.kind === 'ground' ? '0' : r.net); }
  const named = new Set();
  for (const t of N.ports) { const k = t.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); flag(t.at, t.net); named.add(String(t.net).toLowerCase()); }
  // a port whose own point no wire reaches (the drawing joined it elsewhere, e.g. around an X):
  // its name on a drawn pin of its net
  for (const t of N.ports) {
    if (named.has(String(t.net).toLowerCase())) continue;
    const host = N.components.flatMap((d) => Object.values(d.pins)).find((p) => String(p.net).toLowerCase() === String(t.net).toLowerCase());
    if (host) { flag(host.at, t.net); named.add(String(t.net).toLowerCase()); }
  }
  const wires = segs.filter((x) => x.a[0] !== x.b[0] || x.a[1] !== x.b[1]).map((x) => `WIRE ${L(x.a).join(' ')} ${L(x.b).join(' ')}`);
  return ['Version 4', 'SHEET 1 1600 1200', ...wires, ...flags, ...syms].join('\n') + '\n';
}

/** Netlist → {asc, neutral, label, gate}; the neutral LVS must pass. */
export async function exportLtspice(parsed) {
  return withLtspiceGeometry(async () => {
    const r = await autoPlace(parsed), page = getPage(r.doc);
    const N = toNeutral(page, { target: { tool: 'ltspice', unit: 'ltspice/1.6', grid: 10 }, source: { engine: r.label } });
    const lvs = checkNeutral(N, parsed);
    if (!lvs.match) throw Object.assign(new Error('ltspice: the neutral schematic does not redraw the deck'), { lvs });
    let G = null, lvsG = null;
    for (const g of [10, 5]) { G = snapNeutral(N, g); lvsG = checkNeutral(G, parsed); if (lvsG.match) break; }
    if (!lvsG.match) throw Object.assign(new Error('ltspice: rounding to the grid merged two nets'), { lvs: lvsG });
    let gate = null; try { gate = qualityGate(page, parsed); } catch { /* unknown */ }
    G.source.gate = gate ? { pass: gate.pass, failed: Object.keys(gate.checks).filter((k) => !gate.checks[k].ok) } : null;
    G.source.lvs = true;
    return { asc: writeAsc(G, parsed), neutral: G, label: r.label, gate: G.source.gate };
  });
}
