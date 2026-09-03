/**
 * components.js — EDA mapping between SPICE element prefixes and drawio
 * electrical stencils (verified against the fork's stencil pin definitions).
 * pinOrder maps SPICE node order onto stencil pin names.
 */
import { getShape, getPin, loadCatalog, SYNTHETIC_SHAPE_STYLE_KEY } from './stencils.js';

export const SPICE_MAP = {
  R: { shape: 'mxgraph.electrical.resistors.resistor_2', pinOrder: ['in', 'out'], label: 'resistor' },
  C: { shape: 'mxgraph.electrical.capacitors.capacitor_1', pinOrder: ['in', 'out'], label: 'capacitor' },
  L: { shape: 'mxgraph.electrical.inductors.inductor_3', pinOrder: ['in', 'out'], label: 'inductor' },
  D: { shape: 'mxgraph.electrical.diodes.diode', pinOrder: ['in', 'out'], label: 'diode' },
  V: { shape: 'mxgraph.electrical.signal_sources.dc_source_3', pinOrder: ['N', 'S'], label: 'voltage source', vertical: true },
  I: { shape: 'mxgraph.electrical.signal_sources.current_source', pinOrder: ['N', 'S'], label: 'current source', vertical: true },
  // SPICE Q: collector base emitter [model] — NE=collector, W=base, SE=emitter
  Q: { shape: 'mxgraph.electrical.transistors.npn_transistor_1', pinOrder: ['NE', 'W', 'SE'], label: 'BJT',
       variants: { PNP: 'mxgraph.electrical.transistors.pnp_transistor_1' } },
  // SPICE M: drain gate source bulk model — NE=drain, W=gate, SE=source (bulk ignored)
  M: { shape: 'mxgraph.electrical.transistors.nmos', pinOrder: ['NE', 'W', 'SE'], label: 'MOSFET',
       variants: { PMOS: 'mxgraph.electrical.transistors.pmos' }, dropNodes: [3] },
  // SPICE G (VCCS, used for OTA symbols): out+ out- in+ in- gm — the single-ended
  // OTA symbol has no out- pin, so node 1 (out-) is dropped on both sides.
  G: { shape: 'mxgraph.electrical.abstract.ota_1', pinOrder: ['out', 'in+', 'in-'], dropNodes: [1], label: 'OTA (VCCS)' },
};

/**
 * The stencil pin names (NE/SE/W) are positional; visually verified renders
 * show the PMOS stencil is drawn SOURCE-UP (arrow at NE), so its SPICE pin
 * order differs from the NMOS stencil. Per-shape overrides win over the
 * prefix mapping.
 */
export const PIN_ORDER_OVERRIDES = {
  'mxgraph.electrical.transistors.pmos': ['SE', 'W', 'NE'],      // D=SE(bottom), G=W, S=NE(top)
  'mxgraph.electrical.transistors.pmos_bulk': ['SE', 'W', 'NE'],
};

/** Effective SPICE pin order for a classified component. */
export function pinOrderFor(cls) {
  if (cls.shape != null && PIN_ORDER_OVERRIDES[cls.shape.key] != null) return PIN_ORDER_OVERRIDES[cls.shape.key];
  return cls.mapping != null ? cls.mapping.pinOrder : null;
}

export const GROUND_SHAPE = 'mxgraph.electrical.signal_sources.signal_ground';
export const GROUND_PIN = 'N';

/**
 * Supply taps: single-pin symbols that NAME their net globally (all taps with
 * the same net name merge, like ground). Net name = cell value, else default.
 */
export const POWER_SHAPES = {
  'mxgraph.electrical.signal_sources.vdd': { pin: 'N', defaultNet: 'VDD' },
  'mxgraph.electrical.signal_sources.vss2': { pin: 'S', defaultNet: 'VSS' },
};

/**
 * Port markers: single-pin symbols that label their net (net = value || id).
 *
 * DEFECT (2026-08-28, api-hardening): both signal ports and ground used a
 * downward-pointing filled triangle (`equipotential` differs from
 * `signal_ground` only by a thin circle outline inside it) — indistinguishable
 * at normal reading size, so a differential amplifier output could be
 * misread as tied to ground. Fix: `port` — a SYNTHETIC shape (lib/stencils.js
 * SYNTHETIC_SHAPES, an open unfilled circle, plain mxGraph `ellipse`, no
 * stencil XML at all) — an open circle, the conventional "net terminal"
 * glyph, with nothing resembling ground's filled triangle. Round 2
 * (2026-08-28): the first attempt added a new <shape> to
 * signal_sources.xml, which violates this fork's sidecar invariant (nothing
 * outside api-server/ may diverge from upstream drawio); `port` moved to a
 * synthetic catalog entry instead — see shapeKeyOf() below for how it's
 * still recognized on read-back with no stencil registration.
 * `equipotential` is kept mapped here too (not removed) so any PRE-EXISTING
 * .drawio file that already used it as a port still round-trips through
 * netlist extraction; only the placers (place2.js/place3.js) were switched to
 * emit the new `port` shape for anything drawn from now on.
 */
export const PORT_SHAPES = {
  port: { pin: 'N' },
  'mxgraph.electrical.signal_sources.equipotential': { pin: 'N' },
};

/** shape key -> SPICE prefix (reverse map incl. variants). */
const reverse = new Map();
for (const [prefix, m] of Object.entries(SPICE_MAP)) {
  reverse.set(m.shape, prefix);
  for (const v of Object.values(m.variants || {})) reverse.set(v, prefix);
}

/**
 * The catalog key a cell's style resolves to — a real stencil (`shape=…`)
 * OR a synthetic shape (no `shape=` key at all; recognized instead by the
 * `apiShape=…` marker addVertex/stencils.js writes into the style, which
 * mxGraph itself just ignores as an unknown key — same trick the JCT
 * junction-dot style already uses with `drawioApiJunction=1`). Falling back
 * to the marker key, rather than matching the whole style string, means a
 * human editing an unrelated style property (fillColor, a drag/resize) in
 * the GUI does not break recognition on the next extraction.
 */
export function shapeKeyOf(cellInfo) {
  return cellInfo.style.map.get('shape') || cellInfo.style.map.get(SYNTHETIC_SHAPE_STYLE_KEY) || null;
}

/**
 * isJunctionCell(cellInfo) — the ONE shared predicate for "is this cell a
 * junction dot", covering both our own emitted markers (`drawioApiJunction`)
 * and a user-drawn native drawio `shape=waypoint` vertex (task B,
 * 2026-08-31). Before this, every consumer (check.js, annotate.js,
 * rewire.js, route.js, classify() below, and the Python tools/check.py +
 * tools/beauty.py) tested `style.map.has('drawioApiJunction')` directly, so
 * a hand-drawn waypoint junction (draw.io's own "insert waypoint" tool,
 * style `shape=waypoint;...;perimeter=centerPerimeter;...`) was invisible to
 * ERC/LVS/routing: its wires read back as unconnected single-terminal nets.
 * This predicate is for READING/classifying pre-existing cells only — the
 * emitters (place*.js JDOT style, route.js's junction-insertion) must keep
 * writing `drawioApiJunction=1` for anything the tool itself creates; do not
 * repoint an emitter at this function.
 */
export function isJunctionCell(cellInfo) {
  if (cellInfo == null || cellInfo.style == null) return false;
  const { map } = cellInfo.style;
  if (map.has('drawioApiJunction')) return true;
  return map.get('shape') === 'waypoint';
}

/**
 * Classify a vertex cell: {role: 'component'|'ground'|'junction'|'other',
 * prefix?, mapping?, shape?} — shape is the stencil catalog record.
 */
export function classify(cellInfo) {
  // ANNOTATION OPT-OUT (task 2, 2026-08-31): a cell carrying `apiAnnotation=1`
  // is inert BY DECLARATION, checked FIRST, before any shape lookup. Before
  // this, lib/annotate.js's decorative cells had to stay shapeless (no
  // `shape=`/`apiShape=` key at all) to fall through the `key == null` branch
  // below -- which blocked ever drawing a real amplifier symbol for the
  // PA/LNA blocks (they could only be an empty dashed rectangle, the
  // review's top-ranked defect: no amplifier geometry, so gain-stage
  // direction was absent). An annotation can now use ANY shape -- a real
  // stencil, or a core mxGraph shape like `triangle` -- and still be
  // structurally excluded here; connectivity() (netlist.js) inherits this
  // for free because every cell it inspects is classified through this same
  // function.
  if (cellInfo.style.map.has('apiAnnotation')) return { role: 'other' };
  const key = shapeKeyOf(cellInfo);
  if (isJunctionCell(cellInfo)) return { role: 'junction' };
  if (key == null) return { role: 'other' };
  if (POWER_SHAPES[key] != null) {
    const p = POWER_SHAPES[key];
    return { role: 'power', shape: getShape(key), pinName: p.pin,
      net: String(cellInfo.value || '').trim() || p.defaultNet };
  }
  if (PORT_SHAPES[key] != null) {
    return { role: 'port', shape: getShape(key), pinName: PORT_SHAPES[key].pin,
      net: String(cellInfo.value || '').trim() || String(cellInfo.id) };
  }
  if (key === GROUND_SHAPE || /ground|earth/.test(key)) {
    return { role: 'ground', shape: getShape(key) };
  }
  const shape = getShape(key);
  if (shape == null) return { role: 'other' };
  // T4: prefer the persisted refdes over the mxCell id for the id-shape
  // fallback (reverse.get(key) from the stencil already wins when it exists;
  // this only matters for an unmapped/custom shape relying on the id prefix).
  const prefix = reverse.get(key) || inferPrefix(identityOf(cellInfo));
  const mapping = prefix != null ? SPICE_MAP[prefix] : null;
  return { role: 'component', prefix, mapping, shape };
}

function inferPrefix(id) {
  const m = /^([A-Za-z])[0-9]/.exec(String(id || ''));
  return m != null && SPICE_MAP[m[1].toUpperCase()] != null ? m[1].toUpperCase() : null;
}

/**
 * T4: the SPICE identity of a cell — its `refdes` user-data attribute
 * (persisted on the wrapping <object>, see model.js addVertex) when present,
 * otherwise the mxCell/document id. A GUI rename edits the id-bearing node's
 * label, not this attribute, and a copy/paste reassigns the id but carries
 * the <object>'s attributes along unchanged — refdes survives both, the bare
 * id survives neither. Callers outside this module (netlist.js extraction,
 * bom.js) should use this instead of reading `.id` directly.
 */
export function identityOf(cellInfo) {
  return (cellInfo.refdes != null && cellInfo.refdes !== '') ? cellInfo.refdes : cellInfo.id;
}

// ------------------------------------------------------- value formatting

/** Engineering-unit word per SPICE prefix — only device classes that carry a
 *  physical value get reformatted; everything else (V/I/D/Q/M/G values, model
 *  names, "DC 5"-style sources) is left exactly as authored. */
// 'Ω' and not the ASCII 'ohm': the hand-drawn reference sheet writes `0 Ω`, and
// the whole point of matching this emitter to it is that a reader should not be
// able to tell which of the two produced a given sheet.
const VALUE_UNIT = { R: 'Ω', C: 'F', L: 'H' };

/** SI prefix per exponent-of-1000 bucket, from femto to tera. Keys are the
 *  exact integer exponent (always a multiple of 3, so a plain object lookup
 *  is exact — no floating-point comparison of magnitudes). */
const SI_PREFIX_BY_EXP = { '-15': 'f', '-12': 'p', '-9': 'n', '-6': 'u', '-3': 'm',
  '0': '', '3': 'k', '6': 'M', '9': 'G', '12': 'T' };

/** A bare SPICE float, optionally exponential — NOT "1k"/"DC 5"/a model name. */
const BARE_NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * Format a component's raw SPICE value into the VISIBLE label only, in
 * engineering units (e.g. `4.7e-11` -> `47 pF`, `3.6e-08` -> `36 nH`).
 *
 * DEFECT (2026-08-28, api-hardening): labels drawn straight from the SPICE
 * netlist read like `4.7e-11` / `3.6e-08`; the hand-drawn reference
 * schematics this tool is meant to reproduce read `47 pF` / `36 nH` — every
 * value on every sheet needed a mental x1e12 / x1e9 conversion. Fix: reformat
 * the mantissa into [1,1000) with the matching SI prefix, trimming trailing
 * zeros. This ONLY touches the drawn label — `spice_value` (read by
 * netlist.js:235 and bom.js in preference to the label) is untouched, so LVS
 * and the BOM keep comparing the original SPICE float.
 *
 * `0` USED to be rendered bare on the argument that a 0-ohm resistor is a
 * bridge/jumper and that "0 ohm" reads like an odd real value. Reversed
 * 2026-08-31: the hand-drawn 2446 reference — the sheet this emitter is being
 * measured against — writes `0 Ω` on exactly that part (R_ant0). A bare `0` is
 * also indistinguishable from an unfilled value, which is the worse ambiguity
 * of the two. The unit is `Ω`, not the ASCII `ohm`, for the same reason.
 */
export function formatComponentValue(prefix, rawValue) {
  const unit = VALUE_UNIT[prefix];
  const s = String(rawValue == null ? '' : rawValue).trim();
  if (unit == null || s === '' || !BARE_NUMBER_RE.test(s)) return s;
  const num = parseFloat(s);
  if (!Number.isFinite(num)) return s;
  // A zero-valued part is still a part, and its unit is the only thing that says
  // WHICH kind. Returning a bare '0' dropped the unit on R_ant0, the 0 ohm
  // bridge across the antenna node -- the reference sheet reads `0 Ω` and the
  // generated one read `0`, which is indistinguishable from an unfilled value.
  if (num === 0) return `0 ${unit}`;
  const sign = num < 0 ? '-' : '';
  const abs = Math.abs(num);
  let exp3 = Math.floor(Math.log10(abs) / 3) * 3;
  exp3 = Math.max(-15, Math.min(12, exp3));
  let mantissa = abs / Math.pow(10, exp3);
  // log10-derived exponent can leave the mantissa just outside [1,1000) at
  // the boundaries (float rounding, or the clamp above) — renormalize once.
  if (mantissa >= 1000 && exp3 < 12) { mantissa /= 1000; exp3 += 3; }
  else if (mantissa < 1 && exp3 > -15) { mantissa *= 1000; exp3 -= 3; }
  let mStr = mantissa.toPrecision(4);
  if (mStr.includes('.')) mStr = mStr.replace(/0+$/, '').replace(/\.$/, '');
  return `${sign}${mStr} ${SI_PREFIX_BY_EXP[String(exp3)] || ''}${unit}`;
}

/** Pins that carry connectivity for a classified component (SPICE pin order if known, else all). */
export function activePins(cls) {
  if (cls.role === 'ground') return [getPin(cls.shape.key, GROUND_PIN) || cls.shape.pins[0]].filter(Boolean);
  if (cls.role === 'power') {
    return [getPin(cls.shape.key, cls.pinName) || cls.shape.pins[0]].filter(Boolean);
  }
  if (cls.role === 'port') {
    // A port is single-terminal ELECTRICALLY but its terminal can be drawn on
    // any side: place3 picks the side facing the anchor, or the stub crosses
    // back through the glyph. Returning only PORT_SHAPES[key].pin ('N') made
    // erc.js measure every other exit against the north pin and report
    // anchor-off-pin -- 5 errors on the 915 sheet, 4 on 2446, for wires sitting
    // exactly on the perimeter. Offer every declared pin, the canonical one
    // first so anything that takes [0] is unchanged.
    const declared = getPin(cls.shape.key, cls.pinName);
    const all = cls.shape != null ? cls.shape.pins : [];
    return [declared, ...all.filter((p) => p !== declared)].filter(Boolean);
  }
  if (cls.mapping != null) {
    return pinOrderFor(cls).map((n) => getPin(cls.shape.key, n)).filter(Boolean);
  }
  return cls.shape != null ? cls.shape.pins : [];
}
