// REVIEW r4 (4): the three #78 fixes, each with a test that fails on its mutant.
//  E3b  a rail jog steps past the size labels (lib/rails.js, `outs`)
//  Ee   an undo restores fresh clones every time (lib/straighten.js, keepState)
//  R1   the placer wires a redrawn rail leaves clashing are re-routed (rerouteClashes), and a re-route is kept only
//       when the QUALITY GATE fails no more checks, not on the checker count alone
// Netlists, MIT, copied with provenance from the openpdk bank (/AI/datasets/netlists/bank, manifest licence MIT):
//  - Jianxun/iic-osic-tools-project-template, ota_5t.spice (MIT)
//  - RoyceRichmond/Mosbious_2025_Spikcore, refractory_layout.spice (MIT)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpice } from '../lib/netlist.js';
import { getPage, allCells, cellInfo, serialize } from '../lib/model.js';
import { withGroundAlias } from '../lib/ground-alias.js';
import { orientSupplies } from '../lib/supply-orient.js';
import { trial } from '../lib/auto.js';
import { polylineOf } from '../lib/route.js';
import { keepState, rerouteClashes, fixDots, checkerErrors } from '../lib/straighten.js';
import { drawRails } from '../lib/rails.js';


// Jianxun/iic-osic-tools-project-template, ota_5t.spice (MIT)
const JIANXUN_OTA5T = `* ota_5t
M1 net2 i_bias vss vss NMOS
M2 i_bias i_bias vss vss NMOS
M3 net1 in_p net2 vss NMOS
M4 out in_n net2 vss NMOS
M5 out net1 vdd vdd PMOS
M6 net1 net1 vdd vdd PMOS
M7 vss vss vss vss NMOS
M8 vdd vdd vdd vdd PMOS
.end
`;
// RoyceRichmond/Mosbious_2025_Spikcore, refractory_layout.spice (MIT)
const REFRACTORY = `* refractory_layout
M1 Xota_1stage_0.m3_n314_178# Xota_1stage_0.m3_n314_178# vdd vdd PMOS
M2 vrefrac Xota_1stage_0.m3_n314_178# vdd vdd PMOS
M3 vrefrac ota_1stage_0/vn Xota_1stage_0.m3_n530_n14# vss NMOS
M4 Xota_1stage_0.m3_n314_178# ota_1stage_0/vp Xota_1stage_0.m3_n530_n14# vss NMOS
M5 vdd vdd Xota_1stage_0.m3_n1200_n476# vss NMOS
M6 vss Xota_1stage_0.m3_n1200_n476# Xota_1stage_0.m3_n1200_n476# vss NMOS
M7 Xota_1stage_0.m3_n530_n14# Xota_1stage_0.m3_n1200_n476# vss vss NMOS
M8 vspike_down vspike_down ota_1stage_0/vn vss NMOS
M9 ota_1stage_0/vn ota_1stage_0/vn vrefrac vss NMOS
M10 vneg vneg ota_1stage_0/vp vss NMOS
M11 vss ota_1stage_0/vp ota_1stage_0/vp vss NMOS
.end
`;
const parsed = (t) => orientSupplies(withGroundAlias(parseSpice(t))).parsed;

// E3b: M7 (d = g = s = b = vss) has its drain on its left side, beside its own "M7" label. A 20 px jog runs
// through that label; the fix steps past it and the wire stays a rail wire. Mutant (outs = [20] only): no jog
// fits, the wire falls back to the router (no drawioApiTemplate) and runs through M7's body column.
test('E3b (r4): M7\'s drain reaches the ground rail by a jog past its size label', async () => {
  const t = await trial(parsed(JIANXUN_OTA5T), 'ota', null, {}, {});
  const cs = allCells(getPage(t.doc)).map(cellInfo), by = new Map(cs.map((c) => [c.id, c]));
  const m7 = cs.find((c) => c.kind === 'vertex' && c.refdes === 'M7');
  const gnd = new Set(cs.filter((c) => c.kind === 'vertex' && /signal_ground|signal_sources\.(gnd|vss)/.test(c.styleRaw || '')).map((c) => c.id));
  assert.ok(m7 && gnd.size, 'M7 and a ground symbol drawn');
  const lbl = cs.find((c) => c.id === 'LBL_M7');
  assert.ok(lbl, 'M7 has a size label');
  const tw = Math.max(lbl.w, 7 * String(lbl.value).length), al = lbl.style.map.get('align') || 'center';
  const tx = al === 'right' ? lbl.x + lbl.w - tw : al === 'left' ? lbl.x : lbl.x + lbl.w / 2 - tw / 2;
  const toGnd = cs.filter((c) => c.kind === 'edge' && ((c.source === m7.id && gnd.has(c.target)) || (c.target === m7.id && gnd.has(c.source))));
  assert.ok(toGnd.length >= 3, 'source, bulk and drain of M7 wired to the ground');
  // every one of them (source, bulk, drain: the drain is the one that needs the jog) is a rail wire
  const notRail = toGnd.filter((e) => !/drawioApiTemplate=1/.test(e.styleRaw || '')).map((e) => e.id);
  assert.deepEqual(notRail, [], 'every wire from M7 to the ground is a rail wire');
  for (const e of toGnd) {
    const pl = polylineOf(e, by) || [];
    const vx = pl.slice(1).filter((p, i) => p.x === pl[i].x).map((p) => p.x);
    assert.ok(vx.some((x) => x < tx - 1 || x > tx + tw + 1), `the jog leaves the label [${tx}, ${tx + tw}]: ${JSON.stringify(pl)}`);
  }
});

// Ee: restore() twice after edits gives the state kept both times (the snapshot's own nodes never handed out).
// Mutant (restore appends the snapshot's nodes): the second restore gives back the edited node.
test('Ee (r4): keepState restores fresh clones every time', async () => {
  const t = await trial(parsed(JIANXUN_OTA5T), 'ota', null, {}, {});
  const m = getPage(t.doc), before = serialize(t.doc);
  const k = keepState(m);
  const edit = () => { const c = allCells(m).find((n) => n.getAttribute('vertex') === '1'); c.setAttribute('value', 'EDITED'); };
  edit(); assert.notEqual(serialize(t.doc), before);
  k.restore(); assert.equal(serialize(t.doc), before, 'first restore');
  edit(); k.restore(); assert.equal(serialize(t.doc), before, 'second restore, after the restored drawing was edited');
});

// R1: refractory_layout as an OTA. After the rails, placer wires lie on each other; re-routed, the checker counts
// 3 errors and the gate 2 failed checks (without the re-route: 5 and 3).
test('R1 (r4): refractory_layout: the clashes a rail leaves are re-routed', async () => {
  const p = parsed(REFRACTORY);
  const t = await trial(p, 'ota', null, {}, {});
  assert.ok(Number.isFinite(t.errs), 'drawn, LVS clean');
  assert.ok(t.errs <= 3, `checker errors ${t.errs} (5 without the re-route)`);
  assert.ok(t.gateFails <= 2, `gate fails ${t.gateFails} (3 without the re-route)`);
});

// R1, criterion: a re-route that lowers the checker count but makes the gate worse is undone. Same page, two
// gates: a neutral one keeps the re-route, a worsening one gets the drawing back unchanged.
test('R1 (r4): rerouteClashes keeps a re-route only when the quality gate is no worse', async () => {
  const p = parsed(REFRACTORY);
  process.env.AUTO_RAILS = 'off';
  let t; try { t = await trial(p, 'ota', null, {}, {}); } finally { delete process.env.AUTO_RAILS; }
  const m = getPage(t.doc);
  const seen = [];
  await drawRails(m, { errorCount: checkerErrors, fixDots, reroute: async (x) => {
    const kept = keepState(x), before = serialize(t.doc);
    let calls = 0;
    const worse = await rerouteClashes(x, fixDots, { gate: () => calls++ });   // 0 before, 1 after: worse
    seen.push({ worse, same: serialize(t.doc) === before, calls });
    kept.restore();
    const neutral = await rerouteClashes(x, fixDots, { gate: () => 0 });
    seen.push({ neutral });
    return neutral;
  } });
  assert.equal(seen.length, 2, 'the rails were redrawn and the re-route tried');
  assert.ok(seen[1].neutral > 0, `a re-route the checker likes exists here: ${JSON.stringify(seen)}`);
  assert.equal(seen[0].worse, 0, 'a worse gate: nothing re-routed');
  assert.equal(seen[0].same, true, 'a worse gate: drawing unchanged');
  assert.equal(seen[0].calls, 2, 'the gate judged before and after');
});
