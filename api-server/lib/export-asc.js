/**
 * export-asc.js — LTspice `.asc` export of a drawio schematic.
 *
 * Purpose: make the generated drawings USABLE in a simulator, not only
 * viewable. The export is connectivity-exact and geometry-approximate:
 *
 *   - every component becomes an LTspice symbol (data/ltspice-symbols.json,
 *     the pin tables of Weave, MIT) placed at its drawio centre scaled to the
 *     16-unit LTspice grid, oriented like the drawing (vertical/horizontal
 *     two-terminals, transistor flips);
 *   - every pin receives a FLAG carrying its net name — LTspice unions
 *     same-named flags, so connectivity is carried by NAMES, not by wires.
 *     Wires are deliberately NOT emitted: the LTspice symbols have their own
 *     pin geometry, a wire copied from the drawio route would end away from
 *     the pin and read as an open. Named flags are the only encoding that is
 *     provably equivalent; a designer can then draw wires in LTspice with
 *     the nets already correct.
 *   - `verifyAsc()` re-parses the produced .asc with tools/asc2spice.mjs and
 *     runs strict LVS against the netlist extracted from the drawing, so the
 *     endpoint fails closed (409) instead of shipping a silently different
 *     circuit — the round-trip discipline of Weave applied to our own output.
 *
 * Hidden terminals (MOS bulk, switch control, op-amp supplies) become flags
 * on the hidden pins of the 4/5-pin LTspice symbol when one exists (nmos4,
 * sw, UniversalOpamp2) so nothing electrical is lost.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCells, cellInfo } from './model.js';
import { classify, identityOf, pinOrderFor } from './components.js';
import { extractNetlist, parseSpice } from './netlist.js';
import { compare } from './lvs.js';
import { ascToSpice } from '../tools/asc2spice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMBOLS = JSON.parse(fs.readFileSync(path.join(HERE, '../data/ltspice-symbols.json'), 'utf8'));
const GRID = 16;

/** drawio prefix (+model) -> LTspice symbol; pins in SPICE order (= symbols.json order). */
function symbolFor(c) {
  const model = String(c.value || '').toUpperCase();
  switch (c.prefix) {
    case 'R': return 'res';
    case 'C': return 'cap';
    case 'L': return 'ind';
    case 'V': return 'voltage';
    case 'I': return 'current';
    case 'D': return /ZENER/.test(model) ? 'zener' : /SCHOTTKY/.test(model) ? 'schottky' : 'diode';
    case 'Q': return (c.symbolModel === 'PNP' || /PNP/.test(model)) ? 'pnp' : 'npn';
    case 'M': return (c.symbolModel === 'PMOS' || /PMOS|PFET|PCH/.test(model)) ? (c.fullNodes.length === 4 ? 'pmos4' : 'pmos') : (c.fullNodes.length === 4 ? 'nmos4' : 'nmos');
    case 'J': return /PJF|PCH|P-CHANNEL/.test(model) ? 'pjf' : 'njf';
    case 'E': return 'e';
    case 'F': return 'f';
    case 'G': return 'g';
    case 'B': return /^I\s*=/.test(String(c.value || '')) ? 'bi' : 'bv';
    case 'S': return 'sw';
    // an ideal 3-pin op-amp was padded by parseSpice with private hidden
    // nets `<ref>.V+/.V-`; export it back as the 3-pin symbol
    case 'X': return (c.fullNodes.length === 5 && c.fullNodes[2] !== c.ref + '.V+') ? 'Opamps\\UniversalOpamp2' : 'Opamps\\opamp';
    default: return null;
  }
}

function rot([x, y], code) {
  if (code[0] === 'M') x = -x;
  const k = parseInt(code.slice(1), 10);
  if (k === 0) return [x, y];
  if (k === 90) return [-y, x];
  if (k === 180) return [-x, -y];
  return [y, -x];
}
const snap = (v) => Math.round(v / GRID) * GRID;

/** Orientation code from the drawing: two-terminals follow their pin axis,
 *  transistors follow flipH; everything else R0. */
function rotationFor(c, cell, sym) {
  const S = SYMBOLS[sym];
  const st = cell.style.map;
  const flipH = st.get('flipH') === '1';
  if (['res', 'cap', 'ind', 'diode', 'zener', 'schottky', 'voltage', 'current', 'bv', 'bi', 'f'].includes(sym)) {
    // LTspice draws these VERTICAL at R0 (pin 1 on top). In the drawing the
    // stencil is horizontal (pins W/E) unless rotated ±90.
    const r = ((parseFloat(st.get('rotation') || '0') % 360) + 360) % 360;
    const vertical = Math.abs(r - 90) < 1 || Math.abs(r - 270) < 1;
    if (vertical) return r > 180 ? 'R180' : 'R0';
    return flipH ? 'R270' : 'R90';
  }
  if (S && S.pins.length >= 3) return flipH ? 'M0' : 'R0';
  return 'R0';
}

/** Build the .asc text. Returns {asc, skipped:[…]}. */
export function toAsc(model, { scale = 0.8, title = null } = {}) {
  const extracted = extractNetlist(model);
  const byRef = new Map(extracted.components.map((c) => [String(c.ref).toUpperCase(), c]));
  const cells = new Map();
  for (const raw of allCells(model)) {
    const ci = cellInfo(raw);
    if (ci.kind !== 'vertex' || ci.x == null) continue;
    const cls = classify(ci);
    if (cls.role === 'component') cells.set(String(identityOf(ci)).toUpperCase(), { ci, cls });
  }
  const lines = ['Version 4'];
  const body = [];
  const skipped = [];
  let maxX = 0, maxY = 0;
  for (const c of extracted.components) {
    const entry = cells.get(String(c.ref).toUpperCase());
    const sym = symbolFor(c);
    if (!entry || !sym || !SYMBOLS[sym]) { skipped.push({ ref: c.ref, reason: sym ? 'no pin table for ' + sym : 'no LTspice symbol for prefix ' + c.prefix }); continue; }
    const S = SYMBOLS[sym];
    const { ci } = entry;
    const code = rotationFor(c, ci, sym);
    // place the symbol so that its bbox centre lands on the drawio centre
    const bc = [(S.bbox[0] + S.bbox[2]) / 2, (S.bbox[1] + S.bbox[3]) / 2];
    const rc = rot(bc, code);
    const cx = snap((ci.x + ci.w / 2) * scale), cy = snap((ci.y + ci.h / 2) * scale);
    const ox = snap(cx - rc[0]), oy = snap(cy - rc[1]);
    body.push(`SYMBOL ${sym} ${ox} ${oy} ${code}`);
    body.push(`SYMATTR InstName ${c.ref}`);
    if (c.value) body.push(`SYMATTR Value ${c.value}`);
    // one FLAG per pin, named after the net — the connectivity encoding
    const nets = sym === 'Opamps\\opamp' ? [c.fullNodes[0], c.fullNodes[1], c.fullNodes[4]] : c.fullNodes;
    S.pins.forEach((p, i) => {
      const net = nets[i];
      if (net == null || net === '?') return;
      const rp = rot(p, code);
      const px = ox + rp[0], py = oy + rp[1];
      body.push(`FLAG ${px} ${py} ${net === '0' ? '0' : net}`);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
    });
  }
  lines.push(`SHEET 1 ${Math.max(880, maxX + 200)} ${Math.max(680, maxY + 200)}`);
  if (title) lines.push(`TEXT 16 -48 Left 2 ;${title}`);
  lines.push(...body);
  return { asc: lines.join('\n') + '\n', skipped, extracted };
}

/** Round-trip proof: parse the .asc back and LVS it against the drawing's own netlist. */
export function verifyAsc(asc, extracted) {
  const { spice } = ascToSpice(asc, { name: 'roundtrip' });
  const back = parseSpice(spice);
  const golden = parseSpice(extracted.spice);
  // the drawing's netlist is the reference; the .asc must reproduce it
  const report = compare({ components: back.components, issues: [], namedNets: [] }, golden);
  return { match: report.match, report, spice };
}

/** Export + verify in one call; throws (409-style) on a failed round-trip. */
export function exportAsc(model, opts = {}) {
  const { asc, skipped, extracted } = toAsc(model, opts);
  const v = verifyAsc(asc, extracted);
  return { asc, skipped, verified: v.match, report: v.report };
}
