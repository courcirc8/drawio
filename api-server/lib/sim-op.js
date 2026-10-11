/**
 * sim-op.js — « point d'essai » (Eric, 2026-10-11): the operating point of a
 * drawn netlist computed by ngspice with SIMPLE models, shown on the drawing
 * (lib/sim-annotate.js, format drawio-sim-annotations/1 — the same layer the
 * Simulation session's bridge feeds, simulation/passerelle/INTERFACE.md).
 *
 * The deck is the netlist as drawn, made simulable:
 *   - a MOS / BJT / diode model the deck does not define gets a simple one
 *     (MOS level 1: VTO ±0.5 V, KP 200 / 80 µA/V², LAMBDA 0.05, GAMMA 0.4 ;
 *     BJT: IS 1e-16, BF 100, VAF 50 ; diode IS 1e-14);
 *   - a supply net no source drives (vdd, vcc, avdd…) gets VDD (1.8 V);
 *   - a net that only reaches gates / capacitors (an input left open) is
 *     biased at VDD / 2;
 *   - `.option rshunt` keeps a floating node from making the matrix singular.
 * Every assumption is listed in the summary box. Then `op`, `print all`,
 * `show all` in batch mode, and the results become the annotation JSON:
 * node voltages; per MOS Id, gm, gds, Vgs, Vds, vdsat and the region
 * (saturation |Vds| ≥ |vdsat|, linéaire, bloqué |Id| < 1 nA); per BJT Ic, Ib,
 * gm, Vbe, Vce and its region; per supply V, I, P.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const NGSPICE = process.env.NGSPICE || path.join(os.homedir(), 'ClaudeCode/simulation/opt/ngspice/bin/ngspice');
const SUPPLY = /^(a?v(dd|cc)d?|vpwr|vdda|dvdd|vcca|vdd!|vcc!)$/i;
const DEFAULT_VDD = 1.8;
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[a-zµ]*$/i;   // a SPICE number (with a scale suffix / unit)

const SIMPLE = {
  nmos: 'nmos (level=1 vto=0.5 kp=200u lambda=0.05 gamma=0.4 phi=0.7)',
  pmos: 'pmos (level=1 vto=-0.5 kp=80u lambda=0.05 gamma=0.4 phi=0.7)',
  npn: 'npn (is=1e-16 bf=100 vaf=50)',
  pnp: 'pnp (is=1e-16 bf=50 vaf=50)',
  d: 'd (is=1e-14)',
};

/** The device kind of a MOS / BJT / diode line: nmos | pmos | npn | pnp | d. */
export function kindOf(c) {
  const model = String(c.value || '').trim().split(/\s+/)[0] || '';
  if (c.prefix === 'D') return 'd';
  if (c.prefix === 'M') return /p/i.test(c.symbolModel || '') || /^p|pmos|pch|pfet|_p/i.test(model) ? 'pmos' : 'nmos';
  return /pnp/i.test(model) || /pnp/i.test(c.symbolModel || '') ? 'pnp' : 'npn';
}

/** The ngspice deck of a parsed netlist, made simulable with simple models; {deck, assumptions}. */
export function opDeck(parsed, { vdd = DEFAULT_VDD } = {}) {
  const comps = parsed.components, assumptions = [], lines = [`* point d'essai — modèles simples (drawio)`], defaults = new Set();
  const defined = new Set((parsed.models || []).map((m) => String(m.name || m).toLowerCase()));
  const needModels = new Map();
  for (const c of comps) {
    const nodes = c.fullNodes || c.nodes, toks = String(c.value || '').trim().split(/\s+/).filter(Boolean);
    if (c.prefix === 'M' || c.prefix === 'Q' || c.prefix === 'D') {
      const model = (toks[0] || (c.prefix === 'M' ? 'nmos' : c.prefix === 'Q' ? 'npn' : 'd')).toLowerCase();
      const kind = kindOf(c);
      if (!defined.has(model)) needModels.set(model, kind);
      // keep W / L / M / area parameters only (no PDK-specific keys)
      const params = toks.slice(1).filter((t) => /^(w|l|m|area|nf|ng)=/i.test(t)).map((t) => t.replace(/^ng=/i, 'm='));
      const n = c.prefix === 'M' ? nodes.slice(0, 4) : c.prefix === 'Q' ? nodes.slice(0, 3) : nodes.slice(0, 2);
      lines.push([c.ref, ...n, model, ...params].join(' '));
    } else if ('RCL'.includes(c.prefix)) {
      // a symbolic value (AnalogGenie: "R0", a {param}): a default, listed
      const v = String(c.value || '').trim().split(/\s+/)[0];
      const val = NUM.test(v) ? v : { R: '10k', C: '1p', L: '1n' }[c.prefix];
      if (val !== v) defaults.add({ R: 'R = 10 kΩ', C: 'C = 1 pF', L: 'L = 1 nH' }[c.prefix]);
      lines.push([c.ref, ...nodes.slice(0, 2), val].join(' '));
    } else if (c.prefix === 'V' || c.prefix === 'I') {
      // DC value: "dc X" / a number / a pulse's first level; else a default, listed
      const v = String(c.value || '').replace(/[()]/g, ' ').trim(), m = /(?:^|\s)dc\s+(\S+)/i.exec(v) || /^(\S+)/.exec(v), p = /pulse\s+(\S+)/i.exec(v);
      let val = m && NUM.test(m[1]) ? m[1] : p && NUM.test(p[1]) ? p[1] : null;
      if (val == null) { val = c.prefix === 'I' ? '10u' : nodes.some((n) => SUPPLY.test(n)) ? String(vdd) : String(vdd / 2); defaults.add(`${c.ref} = ${val.replace('.', ',')} ${c.prefix === 'I' ? 'A' : 'V'} (valeur absente)`); }
      lines.push([c.ref, ...nodes.slice(0, 2), 'dc', val].join(' '));
    } else if ('EGFH'.includes(c.prefix)) lines.push([c.ref, ...nodes, c.value].join(' '));
    else assumptions.push(`${c.ref} (${c.prefix}) laissé de côté`);
  }
  for (const [name, kind] of needModels) { lines.push(`.model ${name} ${SIMPLE[kind]}`); }
  if (needModels.size) assumptions.push(`modèles simples : ${[...new Set(needModels.values())].map((k) => ({ nmos: 'NMOS niveau 1 (VTO 0,5 V, KP 200 µA/V², λ 0,05)', pmos: 'PMOS niveau 1 (VTO −0,5 V, KP 80 µA/V², λ 0,05)', npn: 'NPN (IS 1e-16, BF 100)', pnp: 'PNP (IS 1e-16, BF 50)', d: 'diode (IS 1e-14)' }[k])).join(' ; ')}`);
  // supplies no source drives; inputs left open (only gates / capacitors)
  const nets = new Map();
  for (const c of comps) (c.fullNodes || c.nodes).forEach((n, i) => { if (n === '0') return; if (!nets.has(n)) nets.set(n, []); nets.get(n).push({ c, i }); });
  const driven = new Set(comps.filter((c) => c.prefix === 'V').flatMap((c) => c.nodes));
  for (const [n] of nets) if (SUPPLY.test(n) && !driven.has(n)) { lines.push(`Vop_${n} ${n} 0 ${vdd}`); driven.add(n); assumptions.push(`${n} alimenté à ${String(vdd).replace('.', ',')} V`); }
  // a bias-CURRENT input left open (IB, IBIAS, ISS, IREF, ITAIL): 20 µA, drawn out of the net
  // to ground when NMOS devices wait for it, into it when PMOS do
  for (const [n, ts] of nets) {
    if (driven.has(n) || !/^i_?(b|bias|ss|ref|tail)\w*$/i.test(n)) continue;
    const mos = ts.filter(({ c }) => c.prefix === 'M').map(({ c }) => kindOf(c)), p = mos.filter((k) => k === 'pmos').length > mos.length / 2;
    lines.push(p ? `Iop_${n} 0 ${n} dc 20u` : `Iop_${n} ${n} 0 dc 20u`); driven.add(n);
    assumptions.push(`entrée de courant ${n} : 20 µA ${p ? 'injectés' : 'tirés vers la masse'}`);
  }
  for (const [n, ts] of nets) {
    if (driven.has(n)) continue;
    // an input left open: only gates / capacitors, or a port (a net only one terminal reaches)
    const dcPath = ts.some(({ c, i }) => !(c.prefix === 'C' || (c.prefix === 'M' && i === 1)));
    if (!dcPath || ts.length === 1) { lines.push(`Vop_${n} ${n} 0 ${vdd / 2}`); driven.add(n); assumptions.push(`entrée ${n} polarisée à ${String(vdd / 2).replace('.', ',')} V`); }
  }
  if (defaults.size) assumptions.push(`valeurs absentes : ${[...defaults].join(', ')}`);
  lines.push('.option rshunt=1e12', '.control', 'op', 'print all', 'show all', 'quit', '.endc', '.end');
  return { deck: lines.join('\n') + '\n', assumptions };
}

/** Run ngspice in batch on a deck; its text output. */
export function runNgspice(deck) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-')), f = path.join(dir, 'op.cir');
  fs.writeFileSync(f, deck);
  try {
    let out = '';
    try { out = execFileSync(NGSPICE, ['-b', f], { cwd: dir, stdio: 'pipe', timeout: 60000 }).toString(); }
    catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Node voltages and device parameters from ngspice's `print all` / `show all`. */
export function parseOp(txt) {
  const nodes = {}, devs = {};
  for (const m of txt.matchAll(/^([\w.#:[\]+\-]+)\s+=\s+([-+\d.eE]+)\s*$/gm)) nodes[m[1].toLowerCase()] = Number(m[2]);
  for (const b of txt.split(/\n(?=\s*device\s)/).slice(1)) {
    const rows = b.split('\n').filter((r) => r.trim()).map((r) => r.trim().split(/\s+/));
    const names = rows[0].slice(1);
    for (const r of rows.slice(1)) {
      if (r.length !== names.length + 1) break;
      names.forEach((n, k) => { const v = Number(r[k + 1]); if (Number.isFinite(v)) (devs[n.toLowerCase()] ??= {})[r[0].toLowerCase()] = v; });
    }
  }
  return { nodes, devs };
}

/** The operating point of a parsed netlist as a drawio-sim-annotations/1 object. */
export function operatingPoint(parsed, opts = {}) {
  const { deck, assumptions } = opDeck(parsed, opts);
  const txt = runNgspice(deck), { nodes, devs } = parseOp(txt);
  if (!Object.keys(nodes).length) {
    const err = (txt.match(/^.*(error|singular|failed).*$/gim) || []).slice(0, 3).join(' ; ');
    throw Object.assign(new Error(`ngspice : pas de point de fonctionnement${err ? ' — ' + err : ''}`), { deck, output: txt.slice(-2000) });
  }
  const sim = { format: 'drawio-sim-annotations/1', generated: new Date().toISOString().slice(0, 19),
    circuit: { title: "point d'essai", source: 'drawio', drawing_netlist: null },
    simulator: { name: 'ngspice', version: (txt.match(/ngspice-(\d+)/) || [])[1] || '', corner: "point d'essai", temp_C: 27 },
    nodes: {}, devices: {}, supplies: {}, summary_extra: assumptions };
  const nets = new Set(parsed.components.flatMap((c) => c.fullNodes || c.nodes));
  for (const n of nets) { if (n === '0') continue; const v = nodes[String(n).toLowerCase()] ?? nodes[`v(${String(n).toLowerCase()})`]; if (v != null) sim.nodes[n] = { V: v }; }
  for (const c of parsed.components) {
    const d = devs[String(c.ref).toLowerCase()]; if (!d) continue;
    if (c.prefix === 'M') {
      const pm = kindOf(c) === 'pmos';
      const id = d.id ?? 0, vds = d.vds ?? 0, vdsat = d.vdsat;
      const region = Math.abs(id) < 1e-9 ? 'bloqué' : vdsat != null ? (Math.abs(vds) >= Math.abs(vdsat) ? 'saturation' : 'linéaire') : undefined;
      sim.devices[c.ref] = { sim_ref: c.ref, type: pm ? 'pmos' : 'nmos', Id: id, gm: d.gm, gds: d.gds, Vgs: d.vgs, Vds: vds, vdsat, ...(region ? { region } : {}) };
    } else if (c.prefix === 'Q') {
      const ic = d.ic ?? 0, vbe = d.vbe, vbc = d.vbc, pnp = (vbe ?? 0) < 0;
      const s = pnp ? -1 : 1, region = s * (vbe ?? 0) < 0.5 ? 'bloqué' : s * (vbc ?? -1) > 0.4 ? 'saturé' : 'actif direct';
      sim.devices[c.ref] = { sim_ref: c.ref, type: pnp ? 'pnp' : 'npn', Ic: ic, Ib: d.ib, gm: d.gm, Vbe: vbe, Vce: d.vce ?? ((vbe ?? 0) - (vbc ?? 0)), region };
    }
  }
  for (const c of parsed.components.filter((x) => x.prefix === 'V')) {
    const i = nodes[`${String(c.ref).toLowerCase()}#branch`], v = (sim.nodes[c.nodes[0]]?.V ?? 0) - (sim.nodes[c.nodes[1]]?.V ?? 0);
    if (i != null) sim.supplies[c.ref] = { V: v, I: -i, P: -i * v };
  }
  const notSat = Object.entries(sim.devices).filter(([, d]) => d.region && !['saturation', 'actif direct'].includes(d.region)).map(([r, d]) => `${r} ${d.region}`);
  if (notSat.length) sim.summary_extra = [...sim.summary_extra, `hors zone active : ${notSat.join(', ')}`];
  return { sim, deck, output: txt };
}
