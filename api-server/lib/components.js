/**
 * components.js — EDA mapping between SPICE element prefixes and drawio
 * electrical stencils (verified against the fork's stencil pin definitions).
 * pinOrder maps SPICE node order onto stencil pin names.
 */
import { getShape, getPin, loadCatalog } from './stencils.js';

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

/** Port markers: single-pin symbols that label their net (net = value || id). */
export const PORT_SHAPES = {
  'mxgraph.electrical.signal_sources.equipotential': { pin: 'N' },
};

/** shape key -> SPICE prefix (reverse map incl. variants). */
const reverse = new Map();
for (const [prefix, m] of Object.entries(SPICE_MAP)) {
  reverse.set(m.shape, prefix);
  for (const v of Object.values(m.variants || {})) reverse.set(v, prefix);
}

export function shapeKeyOf(cellInfo) {
  const s = cellInfo.style.map.get('shape');
  return s || null;
}

/**
 * Classify a vertex cell: {role: 'component'|'ground'|'junction'|'other',
 * prefix?, mapping?, shape?} — shape is the stencil catalog record.
 */
export function classify(cellInfo) {
  const key = shapeKeyOf(cellInfo);
  if (cellInfo.style.map.has('drawioApiJunction')) return { role: 'junction' };
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
  const prefix = reverse.get(key) || inferPrefix(cellInfo.id);
  const mapping = prefix != null ? SPICE_MAP[prefix] : null;
  return { role: 'component', prefix, mapping, shape };
}

function inferPrefix(id) {
  const m = /^([A-Za-z])[0-9]/.exec(String(id || ''));
  return m != null && SPICE_MAP[m[1].toUpperCase()] != null ? m[1].toUpperCase() : null;
}

/** Pins that carry connectivity for a classified component (SPICE pin order if known, else all). */
export function activePins(cls) {
  if (cls.role === 'ground') return [getPin(cls.shape.key, GROUND_PIN) || cls.shape.pins[0]].filter(Boolean);
  if (cls.role === 'power' || cls.role === 'port') {
    return [getPin(cls.shape.key, cls.pinName) || cls.shape.pins[0]].filter(Boolean);
  }
  if (cls.mapping != null) {
    return pinOrderFor(cls).map((n) => getPin(cls.shape.key, n)).filter(Boolean);
  }
  return cls.shape != null ? cls.shape.pins : [];
}
