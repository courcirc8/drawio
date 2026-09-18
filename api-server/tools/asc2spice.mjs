#!/usr/bin/env node
/**
 * asc2spice.mjs — LTspice `.asc` schematic -> flat SPICE netlist.
 *
 * Purpose: turn a public LTspice corpus (e.g. mick001/Circuits-LTSpice, the
 * benchmark of Schemato and Weave) into a HELD-OUT validation set for the
 * netlist -> schematic generator. None of these circuits were used to derive
 * the rules in training/RULES.md, so the error/beauty numbers they give are
 * the first honest measure of generalisation beyond benchmark/netlists30.
 *
 * Connectivity reconstruction follows the round-trip verifier of Weave
 * (senolgulgonul/weave, cli/verify.js, MIT): symbol pins are placed from the
 * per-symbol pin table (data/ltspice-symbols.json, extracted from the same
 * project), rotated by the R/M code, then wires, flags and pins are unioned
 * by coordinate; a wire is split at every interesting point lying on it.
 * Nothing here depends on LTspice itself.
 *
 * Usage:
 *   node tools/asc2spice.mjs <in.asc> [out.cir]
 *   node tools/asc2spice.mjs --corpus <dir-of-asc> <out-dir>   # + manifest.json
 *
 * Every circuit is classified in the manifest: `supported: true` when every
 * element maps to a prefix parseSpice() draws (R C L D V I Q M); otherwise
 * the unsupported instances (S, B, E/G, X op-amps, digital…) are listed and
 * the circuit is written anyway — the generator will skip those lines with
 * a warning, so such a circuit is only a PARTIAL test of the placer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMBOLS = JSON.parse(fs.readFileSync(path.join(HERE, '../data/ltspice-symbols.json'), 'utf8'));

/** Symbol name (lower-cased, backslashes normalised) -> SPICE prefix + hints. */
const SYMBOL_PREFIX = [
  [/^(res|res2)$/, 'R'],
  [/^(cap|cap2|polcap)$/, 'C'],
  [/^(ind|ind2)$/, 'L'],
  [/^voltage$/, 'V'],
  [/^current$/, 'I'],
  [/^(diode|zener|schottky|led|varactor)$/, 'D'],
  [/^(npn|npn2|npn3|npn4|lpnp)$/, 'Q'],
  [/^(pnp|pnp2|pnp3|pnp4)$/, 'Q'],
  [/^(nmos|pmos|nmos4|pmos4)$/, 'M'],
  [/^(njf|pjf)$/, 'J'],
  [/^(sw)$/, 'S'],
  [/^csw$/, 'W'],
  [/^bv$/, 'B'], [/^bi$/, 'B'],
  [/^e$/, 'E'], [/^g$/, 'G'], [/^f$/, 'F'], [/^h$/, 'H'],
  [/^(tline|ltline)$/, 'T'],
];
const DRAWABLE = new Set(['R', 'C', 'L', 'D', 'V', 'I', 'Q', 'M']);

function rot([x, y], code) {
  if (code[0] === 'M') x = -x;
  const k = parseInt(code.slice(1), 10);
  if (k === 0) return [x, y];
  if (k === 90) return [-y, x];
  if (k === 180) return [-x, -y];
  if (k === 270) return [y, -x];
  throw new Error('bad rotation code ' + code);
}

export function parseAsc(text) {
  const wires = [], flags = [], syms = [];
  let cur = null;
  for (const ln of String(text).split(/\r?\n/)) {
    const t = ln.trim().split(/\s+/);
    if (t[0] === 'WIRE') wires.push(t.slice(1, 5).map(Number));
    else if (t[0] === 'FLAG') flags.push({ x: +t[1], y: +t[2], name: t[3] });
    else if (t[0] === 'SYMBOL') { cur = { sym: t[1].replace(/\\\\/g, '\\'), x: +t[2], y: +t[3], rot: t[4] || 'R0' }; syms.push(cur); }
    else if (t[0] === 'SYMATTR' && cur) {
      if (t[1] === 'InstName') cur.name = t.slice(2).join(' ');
      if (t[1] === 'Value') cur.value = t.slice(2).join(' ');
      if (t[1] === 'SpiceModel') cur.spiceModel = t.slice(2).join(' ');
    }
  }
  return { wires, flags, syms };
}

class UF {
  constructor() { this.p = new Map(); }
  find(k) {
    if (!this.p.has(k)) this.p.set(k, k);
    let r = k;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(k) !== r) { const n = this.p.get(k); this.p.set(k, r); k = n; }
    return r;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}
const key = (p) => p[0] + ',' + p[1];
const onSeg = (p, w) => {
  const [x1, y1, x2, y2] = w;
  if (x1 === x2) return p[0] === x1 && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2);
  if (y1 === y2) return p[1] === y1 && p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2);
  return false;
};

function symKey(name) { return name.replace(/\\\\/g, '\\').toLowerCase(); }

function prefixOf(sym) {
  const k = symKey(sym).replace(/^.*\\/, '');
  for (const [re, p] of SYMBOL_PREFIX) if (re.test(k)) return p;
  if (/^opamps\\|^comparators\\/i.test(symKey(sym))) return 'X';
  if (/^(digital|misc|optos|contrib|special|powerproducts|filterproducts|adc|dac|references|switches)\\/i.test(symKey(sym))) return 'X';
  return null;
}

/**
 * Convert one .asc text into {spice, manifest}. Throws on an unknown symbol
 * without a pin table (we cannot know where its pins are).
 */
export function ascToSpice(text, { name = 'ltspice' } = {}) {
  const { wires, flags, syms } = parseAsc(text);
  const uf = new UF();
  const pts = new Set();
  const pinRecs = [];
  const unknown = [];
  for (const s of syms) {
    const S = SYMBOLS[s.sym];
    if (!S) { unknown.push(s.sym); continue; }
    S.pins.forEach((p, i) => {
      const rp = rot(p, s.rot);
      const abs = [s.x + rp[0], s.y + rp[1]];
      pinRecs.push({ sym: s, idx: i, pt: abs });
      pts.add(key(abs));
    });
  }
  for (const f of flags) pts.add(key([f.x, f.y]));
  for (const w of wires) { pts.add(key([w[0], w[1]])); pts.add(key([w[2], w[3]])); }
  const ptList = [...pts].map((k) => k.split(',').map(Number));
  for (const w of wires) {
    const on = ptList.filter((p) => onSeg(p, w));
    on.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let i = 1; i < on.length; i++) uf.union(key(on[i - 1]), key(on[i]));
  }
  // flag names: same-named flags are the SAME net across the sheet
  const groupName = new Map();
  const byName = new Map();
  for (const f of flags) {
    const g = uf.find(key([f.x, f.y]));
    const nm = f.name === '0' ? '0' : f.name;
    if (byName.has(nm)) uf.union(g, byName.get(nm)); else byName.set(nm, g);
  }
  for (const f of flags) groupName.set(uf.find(key([f.x, f.y])), f.name === '0' ? '0' : f.name);
  let anon = 0;
  const netOf = (pt) => {
    const g = uf.find(key(pt));
    if (groupName.has(g)) return groupName.get(g);
    const nm = 'n' + (++anon);
    groupName.set(g, nm);
    return nm;
  };
  // emit
  const lines = ['* ' + name + ' — converted from LTspice .asc by tools/asc2spice.mjs'];
  const unsupported = [];
  const seenRefs = new Set();
  const counters = {};
  for (const s of syms) {
    const S = SYMBOLS[s.sym];
    if (!S) continue;
    const prefix = prefixOf(s.sym);
    if (prefix == null) { unsupported.push(s.name + ':' + s.sym); continue; }
    let ref = s.name || (prefix + (++counters[prefix] || (counters[prefix] = 1)));
    ref = ref.replace(/\s+/g, '_');
    if (ref[0].toUpperCase() !== prefix) ref = prefix + '_' + ref;
    if (seenRefs.has(ref.toUpperCase())) ref = ref + '_' + (seenRefs.size + 1);
    seenRefs.add(ref.toUpperCase());
    const pins = pinRecs.filter((r) => r.sym === s).sort((a, b) => a.idx - b.idx).map((r) => netOf(r.pt));
    const k = symKey(s.sym).replace(/^.*\\/, '');
    let value = (s.value || '').trim();
    let line;
    if (prefix === 'Q') {
      // the symbol decides the polarity; parseSpice/place2 read it from the model name
      let model = value || (k.startsWith('pnp') ? 'PNP' : 'NPN');
      if (k.startsWith('pnp') && !/pnp/i.test(model)) model = 'PNP_' + model;
      if (k.startsWith('npn') && /pnp/i.test(model)) model = 'NPN_' + model;
      line = `${ref} ${pins[0]} ${pins[1]} ${pins[2]} ${model}`;
    } else if (prefix === 'M') {
      let model = value || (k.startsWith('pmos') ? 'PMOS' : 'NMOS');
      if (k.startsWith('pmos') && !/pmos|pfet|pch/i.test(model)) model = 'PMOS_' + model;
      if (k.startsWith('nmos') && /pmos|pfet|pch/i.test(model)) model = 'NMOS_' + model;
      const bulk = pins.length > 3 ? pins[3] : pins[2];
      line = `${ref} ${pins[0]} ${pins[1]} ${pins[2]} ${bulk} ${model}`;
    } else if (prefix === 'D') {
      const model = value || (k === 'zener' ? 'ZENER' : k === 'schottky' ? 'SCHOTTKY' : 'D');
      line = `${ref} ${pins[0]} ${pins[1]} ${model}`;
    } else if (prefix === 'V' || prefix === 'I') {
      line = `${ref} ${pins[0]} ${pins[1]} ${value || 'DC 0'}`;
    } else if (prefix === 'X') {
      line = `${ref} ${pins.join(' ')} ${(value || s.sym).replace(/\s+/g, '_')}`;
    } else {
      // LTspice tolerates a valueless R/L/C (the schematic is a drawing, not
      // yet a simulation); SPICE does not, and the extractor treats a
      // missing value as an extraction error. '?' keeps the line parseable
      // and visibly unvalued (professional-input-stage: R2/L1/L2/R4).
      line = `${ref} ${pins.join(' ')} ${value || '?'}`;
    }
    lines.push(line);
    if (!DRAWABLE.has(prefix)) unsupported.push(ref + ':' + s.sym);
  }
  lines.push('.end');
  const drawable = syms.filter((s) => SYMBOLS[s.sym] && DRAWABLE.has(prefixOf(s.sym) || '?')).length;
  const manifest = {
    name, elements: syms.length, drawable, unsupported, unknown,
    supported: unknown.length === 0 && unsupported.length === 0,
    symbols: [...new Set(syms.map((s) => s.sym))],
  };
  return { spice: lines.join('\n') + '\n', manifest };
}

/** LTspice writes .asc in the OS code page (Windows-1252: µ = 0xB5). Decode
 *  UTF-8 when valid, else Latin-1, and spell µ as the SPICE-safe "u". */
export function readAsc(file) {
  const buf = fs.readFileSync(file);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = buf.toString('latin1'); }
  return text.replace(/[µμ]/g, 'u');
}

function slug(p) {
  return path.basename(p, '.asc').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.toLowerCase().endsWith('.asc')) out.push(p);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === '--corpus') {
    const [, src, dst] = args;
    if (!src || !dst) { console.error('usage: asc2spice.mjs --corpus <asc-dir> <out-dir>'); process.exit(1); }
    fs.mkdirSync(dst, { recursive: true });
    const manifest = [];
    const used = new Set();
    for (const f of walk(src).sort()) {
      let name = slug(f);
      while (used.has(name)) name += '-2';
      used.add(name);
      try {
        const { spice, manifest: m } = ascToSpice(readAsc(f), { name });
        fs.writeFileSync(path.join(dst, name + '.cir'), spice);
        manifest.push({ ...m, source: path.relative(src, f) });
      } catch (e) {
        manifest.push({ name, source: path.relative(src, f), error: String(e.message || e) });
      }
    }
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const ok = manifest.filter((m) => m.supported).length;
    const err = manifest.filter((m) => m.error).length;
    console.log(`${manifest.length} circuits: ${ok} fully drawable, ${manifest.length - ok - err} partial, ${err} errors -> ${dst}`);
  } else {
    const [inp, out] = args;
    if (!inp) { console.error('usage: asc2spice.mjs <in.asc> [out.cir]'); process.exit(1); }
    const { spice, manifest } = ascToSpice(readAsc(inp), { name: slug(inp) });
    if (out) fs.writeFileSync(out, spice); else process.stdout.write(spice);
    console.error(JSON.stringify(manifest));
  }
}
