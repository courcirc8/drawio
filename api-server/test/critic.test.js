import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, getPage, normalizeOrigin } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { routePage } from '../lib/route.js';
import { buildPrompt, parseFindings, critique, RULES_DIGEST } from '../lib/critic.js';
import { findChrome, closeBrowser } from '../lib/render.js';

const CIR = 'V1 in 0 DC 1\nR1 in out 10k\nM1 vdd out 0 0 NMOS\nV2 vdd 0 1.8\n.end';

async function doc() {
  const d = newDocument(); const m = getPage(d);
  const p = importNetlist2(m, parseSpice(CIR));
  await routePage(m, p.wires, {}); normalizeOrigin(m);
  return { d, m };
}

test('critic: prompt lists every component with its refdes and the conventions', async () => {
  const { m } = await doc();
  const prompt = buildPrompt(m, { netlist: CIR });
  for (const ref of ['V1', 'R1', 'M1', 'V2']) assert.match(prompt, new RegExp('^' + ref + '\\t', 'm'));
  for (const r of RULES_DIGEST) assert.ok(prompt.includes(r));
  assert.ok(prompt.includes('R1 in out 10k'));
});

test('critic: parseFindings survives fences, prose and junk fields', () => {
  const r = parseFindings('Sure! ```json\n{"verdict":"needs-work","summary":"s","findings":[{"severity":"ERROR","rule":"Buried Port","message":"m","cells":["R1",42]},{"rule":"x"}]}\n```');
  assert.equal(r.verdict, 'needs-work');
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].severity, 'note');        // unknown severity casing -> note, never invented as error
  assert.equal(r.findings[0].rule, 'buried-port');
  assert.deepEqual(r.findings[0].cells, ['R1', '42']);
  assert.equal(r.findings[1].severity, 'note');
  assert.throws(() => parseFindings('no json here'));
});

test('critic: end-to-end with an injected backend — renders, prompts, validates cell ids', { skip: findChrome() ? false : 'no Chromium' }, async () => {
  const { d, m } = await doc();
  let seen = null;
  const backend = async ({ png, prompt }) => {
    seen = { png: png.length, prompt };
    return { text: JSON.stringify({ verdict: 'needs-work', summary: 'ok', findings: [
      { severity: 'error', rule: 'buried-port', message: 'x', cells: ['R1', 'NOPE'] },
      { severity: 'warning', rule: 'sprawl', message: 'y', cells: [] },
    ] }), model: 'mock' };
  };
  try {
    const r = await critique(d, m, { backend });
    assert.ok(seen.png > 1000, 'a real PNG was rendered');
    assert.ok(seen.prompt.includes('M1'));
    assert.equal(r.model, 'mock');
    assert.deepEqual(r.findings[0].cells, ['R1']);          // unknown id stripped…
    assert.deepEqual(r.unmatched, [{ rule: 'buried-port', cell: 'NOPE' }]); // …and reported
    assert.equal(r.findings[1].cells.length, 0);
  } finally { await closeBrowser(); }
});
