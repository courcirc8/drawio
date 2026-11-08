// layout extractions give one device per finger (DIFFCC 18, TIABIAS2 30): parallel identical devices are one
// device of multiplier m=N before drawing and on both sides of the LVS (lib/fingers.js, the merge key of
// layout3d's schema in local_AI, #468 + 965efff). Orchestrator, 07.11.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSpice, extractNetlist } from '../lib/netlist.js';
import { newDocument, getPage } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { importNetlistManuel } from '../lib/place-manuel.js';
import { mergeFingers } from '../lib/fingers.js';
import { compare } from '../lib/lvs.js';

const net = (s) => parseSpice(`* t\n${s}\n.end\n`);
const refs = (p) => p.components.map((c) => c.ref);

test('fingers: the merge key (drain/source unordered, gate, bulk, w, l, nf, ng, m; R unordered, C ordered)', () => {
  const p = mergeFingers(net([
    'XM1 d g s b sg13_lv_nmos w=1u l=0.13u ng=2',
    'XM2 s g d b sg13_lv_nmos w=1u l=0.13u ng=2',   // drain / source swapped: the same device
    'XM3 d g s b sg13_lv_nmos w=2u l=0.13u ng=2',   // another w
    'XM4 d g2 s b sg13_lv_nmos w=1u l=0.13u ng=2',  // another gate
    'XM5 d g s b sg13_lv_nmos w=1u l=0.13u ng=1',   // another ng
    'XM6 d g s b2 sg13_lv_nmos w=1u l=0.13u ng=2',  // another bulk
    'XM7 d g s b sg13_lv_pmos w=1u l=0.13u ng=2',   // another model
    'XR1 a b rhigh w=0.5u l=2u', 'XR2 b a rhigh w=0.5u l=2u',
    'XC1 t bt cap_cmim w=5u l=5u', 'XC2 bt t cap_cmim w=5u l=5u',
    'M8 x y z z nmos w=1u l=1u m=2', 'M9 x y z z nmos w=1u l=1u m=2',
  ].join('\n')));
  assert.deepEqual(refs(p), ['XM1', 'XM3', 'XM4', 'XM5', 'XM6', 'XM7', 'XR1', 'XC1', 'XC2', 'M8']);
  assert.deepEqual(p.merged, { XM1: ['XM1', 'XM2'], XR1: ['XR1', 'XR2'], M8: ['M8', 'M9'] });
  const by = Object.fromEntries(p.components.map((c) => [c.ref, c]));
  assert.match(by.XM1.value, /\bm=2$/); assert.equal(by.XM1.params.m, '2');
  assert.match(by.M8.value, /\bm=4\b/, 'the multipliers add up');
  assert.equal(mergeFingers(net('XM1 d g s b sg13_lv_nmos w=1u l=1u')).components.length, 1, 'nothing to merge: unchanged');
});

test('fingers: an extracted OTA (one device per finger, drain/source swapped) draws in manuel, LVS against the fingers', () => {
  const src = fs.readFileSync(new URL('./fixtures/fingers/ota_miller_fingers.sp', import.meta.url), 'utf8');
  const raw = withGroundAlias(parseSpice(src)), p = mergeFingers(raw);
  assert.equal(raw.components.length, 27);
  assert.equal(p.components.length, 10, 'the same 10 devices as the drawn OTA');
  const by = Object.fromEntries(p.components.map((c) => [c.ref, c]));
  assert.deepEqual(by.XM10_1.nodes, ['tail', 'vbp', 'vdd'], 'the drain and source most fingers have');
  assert.deepEqual(by.XM2_1.nodes.slice(0, 1), ['out']);
  assert.match(by.XM2_1.value, /m=7/);
  const page = getPage(newDocument());
  const r = importNetlistManuel(page, p);          // throws if its reading is not sure or its geometric LVS fails
  assert.ok(r.geo.ok);
  assert.deepEqual(r.frames, ['core']);
  // the drawing (10 devices, m=N) against the extracted netlist (27 fingers): the LVS reduces the fingers too
  const rep = compare(extractNetlist(page), raw);
  assert.ok(rep.match, JSON.stringify(rep).slice(0, 600));
  // and a drawing missing one finger's worth of multiplier does not match
  const wrong = parseSpice(src.replace(/^XM10_5 .*$/m, ''));
  assert.equal(compare(extractNetlist(page), withGroundAlias(wrong)).match, false);
});
