/**
 * export-qucs.js — netlist SPICE → Qucs-S `.sch` (step 4 of
 * docs/export-multi-outils.md), same method as lib/export-kicad.js.
 *
 * Qucs-S symbols are built into its C++ code (no symbol library): the port
 * positions below are FACTS read from ra3xdh/qucs_s (branch current,
 * qucs/components/*.cpp, GPL — positions only, no code copied):
 *   resistor.cpp:142, capacitor.cpp:118, inductor.cpp:34   (-30,0) (30,0)
 *   volt_dc.cpp:35, ampere_dc.cpp:37                        (30,0)=+ (-30,0)=−
 *   mosfet_sub.cpp:297                                      G(-30,0) D(0,-30) S(0,30) B(20,0)
 *   ground.cpp:31                                           (0,0)
 * Transform (component.cpp:991-999, on load): mirrorX (y → −y) first, then
 * `rotate` steps, each (x, y) → (y, −x). Qucs's grid is 10: one unit = one of ours.
 * Qucs joins wire ENDS: wires are cut at every connection point. Ground:
 * GND symbols; supplies, ports and labelled bulks: wire labels.
 * Checked by Qucs-S's own netlister (`qucs-s -n --ngspice`) + lib/lvs.js
 * (tools/qucs-check.mjs, deliverQucs).
 */
import { SPICE_MAP } from './components.js';
import { getPage } from './model.js';
import { autoPlace } from './auto.js';
import { toNeutral, checkNeutral, snapNeutral } from './neutral.js';
import { qualityGate } from './quality.js';
import { stencilFromPins, withStencilGeometry, fitOrientation } from './target-geometry.js';

export const qxform = ([x, y], rot, mirror) => {
  if (mirror) y = -y;
  for (let k = 0; k < (rot & 3); k++) [x, y] = [y, -x];
  return [x + 0, y + 0];
};
const ORIENTS = [0, 1, 2, 3].flatMap((r) => [0, 1].map((m) => ({ rot: r, mirror: m, f: (p) => qxform(p, r, m) })));

const P2 = { 0: [-30, 0], 1: [30, 0] }, PS = { 0: [30, 0], 1: [-30, 0] };
const MOS = { G: [-30, 0], D: [0, -30], S: [0, 30], B: [20, 0] };
const qs = (v) => `"${String(v ?? '').replace(/"/g, "'")}"`;
const valOf = (v, unit) => { const s = String(v ?? '').trim().split(/\s+/)[0]; return s ? s : unit; };

// mosfet_sub.cpp property list (47, in order): name, default, shown — W at 11, L at 12
const MOS_PROPS = [['Type', 'nfet', 1], ['Vt0', '1.0 V', 1], ['Kp', '2e-5', 1], ['Gamma', '0.0', 0], ['Phi', '0.6 V', 0], ['Lambda', '0.0', 1],
  ['Rd', '0.0 Ohm', 0], ['Rs', '0.0 Ohm', 0], ['Rg', '0.0 Ohm', 0], ['Is', '1e-14 A', 0], ['N', '1.0', 0], ['W', '1 um', 0], ['L', '1 um', 0],
  ['Ld', '0.0', 0], ['Tox', '0.1 um', 0], ['Cgso', '0.0', 0], ['Cgdo', '0.0', 0], ['Cgbo', '0.0', 0], ['Cbd', '0.0 F', 0], ['Cbs', '0.0 F', 0],
  ['Pb', '0.8 V', 0], ['Mj', '0.5', 0], ['Fc', '0.5', 0], ['Cjsw', '0.0', 0], ['Mjsw', '0.33', 0], ['Tt', '0.0 ps', 0], ['Nsub', '0.0', 0],
  ['Nss', '0.0', 0], ['Tpg', '0', 0], ['Uo', '600.0', 0], ['Rsh', '0.0', 0], ['Nrd', '1', 0], ['Nrs', '1', 0], ['Cj', '0.0', 0], ['Js', '0.0', 0],
  ['Ad', '0.0', 0], ['As', '0.0', 0], ['Pd', '0.0 m', 0], ['Ps', '0.0 m', 0], ['Kf', '0.0', 0], ['Af', '1.0', 0], ['Ffe', '1.0', 0],
  ['Temp', '26.85', 0], ['Tnom', '26.85', 0], ['Fwd', 'yes', 0], ['Rbody', '', 0], ['Sim', '', 0]];
const mosLine = (pmos, p) => MOS_PROPS.map(([n, d, sh]) => `${qs(n === 'Type' ? (pmos ? 'pfet' : 'nfet') : n === 'W' && p.w ? p.w : n === 'L' && p.l ? p.l : d)} ${sh}`).join(' ');

export const PROFILE = {
  [SPICE_MAP.R.shape]: { model: 'R', pinsAt: P2, pins: { in: '0', out: '1' }, native: [0, 0], thick: 20, pad: [0, 30, 0, 0], props: (c) => `${qs(valOf(c.value, '1k'))} 1 "26.85" 0 "0.0" 0 "0.0" 0 "26.85" 0 "european" 0` },
  [SPICE_MAP.C.shape]: { model: 'C', pinsAt: P2, pins: { in: '0', out: '1' }, native: [0, 0], thick: 40, pad: [0, 30, 0, 0], props: (c) => `${qs(valOf(c.value, '1p'))} 1 "" 0 "neutral" 0` },
  [SPICE_MAP.L.shape]: { model: 'L', pinsAt: P2, pins: { in: '0', out: '1' }, native: [0, 0], thick: 20, pad: [0, 30, 0, 0], props: (c) => `${qs(valOf(c.value, '1n'))} 1 "" 0` },
  [SPICE_MAP.V.shape]: { model: 'Vdc', pinsAt: PS, pins: { N: '0', S: '1' }, native: [1, 0], thick: 40, pad: [0, 0, 40, 0], props: (c) => `${qs(String(c.value || '0').replace(/^\s*dc\s+/i, '').split(/\s+/)[0])} 1` },
  [SPICE_MAP.I.shape]: { model: 'Idc', pinsAt: PS, pins: { N: '1', S: '0' }, native: [3, 0],   // (Qucs-S netlists an Idc port 1 first: SPICE n+ is port 1)
    thick: 40, pad: [0, 0, 40, 0], props: (c) => `${qs(String(c.value || '0').replace(/^\s*dc\s+/i, '').split(/\s+/)[0])} 1` },
  [SPICE_MAP.M.shape]: { model: 'MOSFET', pinsAt: MOS, pins: { NE: 'D', W: 'G', SE: 'S' }, bulk: 'B', gate: 'G', source: 'S', native: [0, 0], pad: [0, 0, 60, 0], props: (c) => mosLine(false, c.params) },
  // draw.io's pmos stencil has its SOURCE at NE: mirrored, Qucs's S is on top
  [SPICE_MAP.M.variants.PMOS]: { model: 'MOSFET', pinsAt: MOS, pins: { NE: 'S', W: 'G', SE: 'D' }, bulk: 'B', gate: 'G', source: 'S', native: [0, 1], pad: [0, 0, 60, 0], props: (c) => mosLine(true, c.params) },
};
function stencilOf(e) {
  return stencilFromPins(Object.fromEntries(Object.entries(e.pins).map(([d, s]) => [d, qxform(e.pinsAt[s], e.native[0], e.native[1])])), { thick: e.thick || 20, pad: e.pad });
}
export function withQucsGeometry(fn) {
  return withStencilGeometry(Object.fromEntries(Object.entries(PROFILE).map(([k, e]) => [k, stencilOf(e)])), fn);
}

const ORIGIN = 100;
/** The Qucs-S `.sch` text of a neutral schematic drawn in Qucs geometry. */
export function writeQucsSch(N, parsed) {
  const byRef = new Map(parsed.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const comps = [], segs = [], pinPts = [], warnings = [];
  const P = (p) => [Math.round(p[0] + ORIGIN), Math.round(p[1] + ORIGIN)];
  for (const w of N.wires) for (let k = 1; k < w.points.length; k++) segs.push({ a: w.points[k - 1], b: w.points[k], net: w.net });
  const taken = [...segs.map((x) => ({ p: x.a, q: x.b, net: x.net })),
    ...N.components.flatMap((d) => Object.values(d.pins).map((x) => ({ p: x.at, q: x.at, net: x.net }))),
    ...N.rails.map((r) => ({ p: r.at, q: r.at, net: r.net })), ...N.ports.map((t) => ({ p: t.at, q: t.at, net: t.net }))];
  const onSeg = (pt, a, b) => pt[0] >= Math.min(a[0], b[0]) - 0.5 && pt[0] <= Math.max(a[0], b[0]) + 0.5 && pt[1] >= Math.min(a[1], b[1]) - 0.5 && pt[1] <= Math.max(a[1], b[1]) + 0.5
    && Math.abs((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0])) < 0.5;
  const clash = (p, q, net) => taken.some((x) => String(x.net) !== String(net) && (onSeg(x.p, p, q) || onSeg(x.q, p, q) || onSeg(p, x.p, x.q) || onSeg(q, x.p, x.q)));
  const labels = [];   // {at, net}: a wire label on a wire ending there
  const gnd = (at) => comps.push(`  <GND * 1 ${P(at).join(' ')} 0 0 0 0>`);
  for (const c of N.components) {
    const e = PROFILE[c.symbol]; if (!e) throw new Error(`qucs: no symbol for ${c.ref} (${c.symbol})`);
    const drawn = Object.fromEntries(Object.entries(e.pins).filter(([d]) => c.pins[d]).map(([d, s]) => [s, c.pins[d].at]));
    const f = fitOrientation(e.pinsAt, drawn, ORIENTS);
    if (!f) throw new Error(`qucs: ${c.ref} — no orientation of ${e.model} matches its drawn pins`);
    const src = byRef.get(String(c.ref).toUpperCase()) || {};
    const params = Object.fromEntries([...String(src.value || '').matchAll(/\b([wl])\s*=\s*([^\s]+)/gi)].map((m) => [m[1].toLowerCase(), m[2]]));
    comps.push(`  <${e.model} ${c.ref} 1 ${P(f.at).join(' ')} 20 -26 ${f.orient.mirror} ${f.orient.rot} ${e.props({ value: c.spice.value || src.value, params })}>`);
    for (const p of Object.values(drawn)) pinPts.push(p);
    if (e.bulk) {
      const t = f.orient.f(e.pinsAt[e.bulk]), g = f.orient.f(e.pinsAt[e.gate]), s = f.orient.f(e.pinsAt[e.source]);
      const b = [f.at[0] + t[0], f.at[1] + t[1]], sAt = [f.at[0] + s[0], f.at[1] + s[1]], bnet = c.spice.hidden?.[3] ?? c.pins.SE?.net;
      if (taken.some((x) => String(x.net) !== String(bnet) && (onSeg(b, x.p, x.q)))) throw new Error(`qucs: a wire of another net touches the bulk pin of ${c.ref}`);
      pinPts.push(b);
      const out = Math.sign(t[0] - g[0]) || 1, len = [20, 40, 60].find((L) => !clash(b, [b[0] + out * L, b[1]], bnet));
      if (len == null) throw new Error(`qucs: no room for the bulk wire of ${c.ref}`);
      const end = [b[0] + out * len, b[1]];
      segs.push({ a: b, b: end, net: bnet }); taken.push({ p: b, q: end, net: bnet });
      const rail = N.rails.find((r) => String(r.net).toLowerCase() === String(bnet).toLowerCase());
      if (String(bnet) === '0' || rail?.kind === 'ground') gnd(end);
      else {
        labels.push({ at: end, net: rail ? rail.net : bnet });
        // an internal bulk net: the same label on a drawn wire of that net (else two nets)
        const sn = Object.entries(e.pins).find(([, v]) => v === e.source)?.[0];
        if (!rail && !N.ports.some((p) => String(p.net).toLowerCase() === String(bnet).toLowerCase())) {
          const w = N.wires.find((x) => String(x.net) === String(bnet));
          if (w) labels.push({ at: w.points[0], net: bnet }); else if (sn && String(c.pins[sn]?.net) === String(bnet)) labels.push({ at: sAt, net: bnet });
        }
      }
    }
  }
  const ends = new Set([...segs.flatMap((x) => [x.a.join(','), x.b.join(',')]), ...pinPts.map((p) => p.join(','))]);
  const seen = new Set();
  for (const r of N.rails) { const k = r.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); if (r.kind === 'ground') gnd(r.at); else labels.push({ at: r.at, net: r.net }); }
  const named = new Set();
  for (const t of N.ports) { const k = t.at.join(','); if (seen.has(k) || !ends.has(k)) continue; seen.add(k); labels.push({ at: t.at, net: t.net }); named.add(String(t.net).toLowerCase()); }
  // a port no wire reaches at its own point: its name on a drawn pin of its net
  for (const t of N.ports) {
    if (named.has(String(t.net).toLowerCase())) continue;
    const host = N.components.flatMap((d) => Object.values(d.pins)).find((p) => String(p.net).toLowerCase() === String(t.net).toLowerCase());
    if (host) { labels.push({ at: host.at, net: t.net }); named.add(String(t.net).toLowerCase()); }
  }
  // Qucs joins wire ENDS: cut every segment at each connection point inside it
  const points = [...new Set([...segs.flatMap((x) => [x.a, x.b]), ...pinPts, ...labels.map((l) => l.at)].map((p) => p.join(',')))].map((k) => k.split(',').map(Number));
  const inside = (p, a, b) => (a[0] === b[0] ? p[0] === a[0] && p[1] > Math.min(a[1], b[1]) && p[1] < Math.max(a[1], b[1]) : a[1] === b[1] && p[1] === a[1] && p[0] > Math.min(a[0], b[0]) && p[0] < Math.max(a[0], b[0]));
  const cut = [];
  for (const sg of segs) {
    const mids = points.filter((p) => inside(p, sg.a, sg.b)).sort((u, v) => Math.hypot(u[0] - sg.a[0], u[1] - sg.a[1]) - Math.hypot(v[0] - sg.a[0], v[1] - sg.a[1]));
    let a = sg.a; for (const m of [...mids, sg.b]) { cut.push({ a, b: m, net: sg.net, label: '' }); a = m; }
  }
  // a label goes on a wire ending at its point; with none, on a short stub from the point
  for (const l of labels) {
    const name = String(l.net) === '0' ? 'gnd' : String(l.net);
    const w = cut.find((x) => !x.label && ((x.a[0] === l.at[0] && x.a[1] === l.at[1]) || (x.b[0] === l.at[0] && x.b[1] === l.at[1])));
    if (w) { w.label = name; continue; }
    const dir = [[0, -10], [10, 0], [0, 10], [-10, 0]].find(([dx, dy]) => !clash(l.at, [l.at[0] + dx, l.at[1] + dy], l.net));
    if (!dir) { warnings.push(`no room for the label ${name}`); continue; }
    cut.push({ a: l.at, b: [l.at[0] + dir[0], l.at[1] + dir[1]], net: l.net, label: name });
  }
  const wires = cut.filter((x) => x.a[0] !== x.b[0] || x.a[1] !== x.b[1]).map((x) => {
    const [a, b] = [P(x.a), P(x.b)];
    return `  <${a[0]} ${a[1]} ${b[0]} ${b[1]} ${qs(x.label)} ${x.label ? `${a[0] + 10} ${a[1] - 20} 0` : '0 0 0'} "">`;
  });
  writeQucsSch.warnings = warnings;
  return `<Qucs Schematic 25.1.2>
<Properties>
  <View=0,0,1200,900,1,0,0>
  <Grid=10,10,1>
  <DataSet=*.dat>
  <DataDisplay=*.dpl>
  <OpenDisplay=0>
  <Script=*.m>
  <RunScript=0>
  <showFrame=0>
  <FrameText0=Title>
  <FrameText1=Drawn By:>
  <FrameText2=Date:>
  <FrameText3=Revision:>
</Properties>
<Symbol>
</Symbol>
<Components>
${comps.join('\n')}
</Components>
<Wires>
${wires.join('\n')}
</Wires>
<Diagrams>
</Diagrams>
<Paintings>
</Paintings>
`;
}

/** Netlist → {sch, neutral, label, gate, warnings}; the neutral LVS must pass. */
export async function exportQucs(parsed) {
  return withQucsGeometry(async () => {
    const r = await autoPlace(parsed), page = getPage(r.doc);
    const N = toNeutral(page, { target: { tool: 'qucs-s', unit: 'qucs', grid: 10 }, source: { engine: r.label } });
    const lvs = checkNeutral(N, parsed);
    if (!lvs.match) throw Object.assign(new Error('qucs: the neutral schematic does not redraw the deck'), { lvs });
    let G = null, lvsG = null;
    for (const g of [10, 5]) { G = snapNeutral(N, g); lvsG = checkNeutral(G, parsed); if (lvsG.match) break; }
    if (!lvsG.match) throw Object.assign(new Error('qucs: rounding to the grid merged two nets'), { lvs: lvsG });
    let gate = null; try { gate = qualityGate(page, parsed); } catch { /* unknown */ }
    G.source.gate = gate ? { pass: gate.pass, failed: Object.keys(gate.checks).filter((k) => !gate.checks[k].ok) } : null;
    G.source.lvs = true;
    const sch = writeQucsSch(G, parsed);
    return { sch, neutral: G, label: r.label, gate: G.source.gate, warnings: writeQucsSch.warnings };
  });
}
