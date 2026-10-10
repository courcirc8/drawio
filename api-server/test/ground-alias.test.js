import test from 'node:test';
import assert from 'node:assert/strict';
import { groundAlias, withGroundAlias } from '../lib/ground-alias.js';
import { parseSpice } from '../lib/netlist.js';
import { compare } from '../lib/lvs.js';

test('a lone ground spelling is the ground; never with 0 or a second spelling', () => {
  assert.equal(groundAlias(['vss', 'out', 'vdd']), 'vss');
  assert.equal(groundAlias(['VGND', 'VPWR', 'a']), 'VGND');
  assert.equal(groundAlias(['vss', 'VSS', 'x']), 'vss');            // one spelling, two cases
  assert.equal(groundAlias(['0', 'vss', 'vdd']), null);              // split supply: VSS may be negative
  assert.equal(groundAlias(['avss', 'dvss']), null);                 // two grounds: left as written
  assert.equal(groundAlias(['vdd', 'out']), null);
});

test('placers see the alias renamed 0; the deck is untouched', () => {
  const p = parseSpice('M1 out in vss vss nmos\nR1 vdd out 1k\n.end');
  const q = withGroundAlias(p);
  assert.deepEqual(q.components[0].nodes.slice(0, 3), ['out', 'in', '0']);
  assert.equal(p.components[0].nodes[2], 'vss');
  assert.equal(withGroundAlias(parseSpice('R1 a 0 1k\nR2 a vss 1k\n.end')).components[1].nodes[1], 'vss');
});

test('LVS: a ground symbol (net 0) matches the deck that says VSS, on either side', () => {
  const deck = parseSpice('M1 out in vss vss nmos\nR1 vdd out 1k\n.end');
  const drawn = withGroundAlias(deck);
  assert.equal(compare(drawn, deck).match, true);
  assert.equal(compare(deck, drawn).match, true);
  // with a real 0 net, VSS stays its own net: a drawing that merged them fails
  const split = parseSpice('M1 out in vss vss nmos\nR1 vdd out 1k\nV1 vss 0 -1\n.end');
  const r0 = (n) => (n === 'vss' ? '0' : n);
  const merged = { ...split, components: split.components.map((c) => ({ ...c, nodes: c.nodes.map(r0), ...(c.fullNodes ? { fullNodes: c.fullNodes.map(r0) } : {}) })) };
  assert.equal(compare(merged, split).match, false);
});
