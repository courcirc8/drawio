import test from 'node:test';
import assert from 'node:assert/strict';
import { ascToSpice, parseAsc } from '../tools/asc2spice.mjs';
import { parseSpice } from '../lib/netlist.js';

// A hand-written LTspice sheet: V1 -> R1 -> node "out" -> C1 -> ground, with
// the ground given twice as two separate FLAG 0 (LTspice semantics: same
// name = same net) and R1 rotated R90 so the pin rotation path is exercised.
//
// Symbol pin tables (data/ltspice-symbols.json):
//   voltage pins [0,16] (+) and [0,96] (-)      res pins [16,16],[16,96]
//   cap pins [16,0],[16,64]
// R90 maps [x,y] -> [-y,x]: res pins become [-16,16] and [-96,16].
const ASC = `Version 4
SHEET 1 880 680
WIRE 0 16 0 -32
WIRE 0 -32 96 -32
WIRE 96 -32 96 16
WIRE 176 16 240 16
WIRE 240 16 240 32
WIRE 240 96 240 128
WIRE 0 96 0 128
FLAG 0 128 0
FLAG 240 128 0
FLAG 240 16 out
SYMBOL voltage 0 0 R0
SYMATTR InstName V1
SYMATTR Value 5
SYMBOL res 192 0 R90
SYMATTR InstName R1
SYMATTR Value 10k
SYMBOL cap 224 32 R0
SYMATTR InstName C1
SYMATTR Value 100n
SYMBOL pnp 400 0 R0
SYMATTR InstName Q1
SYMATTR Value 2N3906
`;

test('asc2spice: parseAsc reads wires, flags and symbol attributes', () => {
  const a = parseAsc(ASC);
  assert.equal(a.wires.length, 7);
  assert.deepEqual(a.flags.map((f) => f.name), ['0', '0', 'out']);
  assert.equal(a.syms.length, 4);
  assert.equal(a.syms[1].rot, 'R90');
  assert.equal(a.syms[2].value, '100n');
});

test('asc2spice: connectivity is rebuilt by coordinate and named by flags', () => {
  const { spice, manifest } = ascToSpice(ASC, { name: 't' });
  const p = parseSpice(spice);
  const byRef = Object.fromEntries(p.components.map((c) => [c.ref, c]));
  // V1: + on the wire to R1's second (rotated, x=96) pin: an anonymous net;
  // - on ground
  assert.equal(byRef.V1.nodes[1], '0');
  assert.equal(byRef.V1.nodes[0], byRef.R1.nodes[1]);
  assert.notEqual(byRef.V1.nodes[0], '0');
  // R1 first pin (rotated to x=176) lands on the "out" flag, as does C1's top pin
  assert.equal(byRef.R1.nodes[0], 'out');
  assert.equal(byRef.C1.nodes[0], 'out');
  assert.equal(byRef.C1.nodes[1], '0');
  assert.equal(byRef.C1.value, '100n');
  // a PNP symbol must be recognisable as PNP from the model name alone
  assert.match(byRef.Q1.model, /pnp/i);
  assert.equal(manifest.supported, true);
  assert.equal(manifest.drawable, 4);
});

test('asc2spice: unsupported elements are written but flagged as partial', () => {
  const asc = ASC + 'SYMBOL sw 600 0 R0\nSYMATTR InstName S1\nSYMATTR Value MYSW\n';
  const { spice, manifest } = ascToSpice(asc, { name: 't' });
  assert.equal(manifest.supported, false);
  assert.deepEqual(manifest.unsupported, ['S1:sw']);
  assert.match(spice, /^S1 /m);
  // parseSpice skips it with a warning rather than failing
  const p = parseSpice(spice);
  assert.ok(p.warnings.some((w) => /unsupported element/.test(w)));
  assert.equal(p.components.length, 4);
});

test('asc2spice: an unknown symbol (no pin table) is reported, never guessed', () => {
  const asc = ASC + 'SYMBOL Gain 600 0 R0\nSYMATTR InstName U1\n';
  const { manifest } = ascToSpice(asc, { name: 't' });
  assert.deepEqual(manifest.unknown, ['Gain']);
  assert.equal(manifest.supported, false);
});
