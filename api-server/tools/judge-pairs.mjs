#!/usr/bin/env node
/**
 * judge-pairs.mjs — pairwise READABILITY judgement of two drawings of the same
 * netlist by the local multimodal model (Ornith, OpenAI-compatible, :30010).
 *
 * WHY (2026-10-03): engine=auto picks the drawing with the fewest check.py-like
 * errors, and on a 30-part bandgap it picked a scatter of islands over the
 * branch-column drawing a designer would choose (crossings 40 vs 18, wire
 * length x2). The rule checker is not a readability measure. This tool asks a
 * vision model, in BOTH orders (position bias cancels), which drawing is
 * closer to how a textbook draws the circuit; it only judges, never moves
 * anything. Our own renders only: no corpus image is sent.
 *
 * Usage: node tools/judge-pairs.mjs --a v2 --b auto --out FILE [--split tune] [--per-family 15] [--families f1,f2]
 *   engines: v2 | v4 | auto | auto-old (no sa, check.js referee) | sa
 * Output: one JSON line per circuit {id, family, a, b, ab, ba, firstAB, prefers}
 * (prefers 'same' when both engines drew the same picture: not asked), and a
 * summary: order consistency, preference per family.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { newDocument, getPage, normalizeOrigin } from '../lib/model.js';
import { parseSpice } from '../lib/netlist.js';
import { importNetlist2 } from '../lib/place2.js';
import { importNetlist4 } from '../lib/place4.js';
import { routePage } from '../lib/route.js';
import { importNetlistSA } from '../lib/place-sa.js';
import { autoPlace } from '../lib/auto.js';
import { exportDocument } from '../lib/render.js';
import { assertNotSealed, bankExclusions } from '../lib/sealed.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BANK = arg('--bank', '/AI/datasets/netlists/bank');
const JUDGE_URL = process.env.JUDGE_URL || 'http://127.0.0.1:30010/v1/chat/completions';
const MODEL = process.env.JUDGE_MODEL || 'ornith-1.5-35b';
const [EA, EB] = [arg('--a', 'v2'), arg('--b', 'auto')];
const OUT = arg('--out', '/tmp/judge-pairs.jsonl');
const PER = Number(arg('--per-family', 15));
const FAMS = arg('--families', null)?.split(',');
const SPLIT = arg('--split', 'tune');
const SEALED = JSON.parse(fs.readFileSync(new URL('../benchmark/sealed-50.json', import.meta.url), 'utf8'));
const famOf = (r) => ((r.family === 'adc' || r.family === 'dac') ? 'data-converter' : r.family);
const splitOf = (r) => { if (SEALED.holdoutFamilies.includes(famOf(r))) return 'holdout-family'; const h = parseInt(crypto.createHash('sha1').update(r.id).digest('hex').slice(0, 8), 16) / 0xffffffff; return h < 0.6 ? 'tune' : 'test'; };

const PROMPT = 'Two drawings of the SAME analog circuit. Which one would an analog IC designer find more readable, closer to how a textbook draws this circuit (signal flow left to right, supply on top and ground at the bottom, current branches as columns, matched devices side by side and symmetric, short wires, few crossings, nothing scattered)? Answer JSON only: {"better": "A" or "B", "confidence": 0..1, "why": "one sentence"}.';

async function draw(parsed, engine) {
  let doc = newDocument(); const m = getPage(doc);
  if (engine === 'auto') doc = (await autoPlace(parsed)).doc;
  else if (engine === 'auto-old') {   // auto as it was before 2026-10-07: no sa candidate, check.js referee
    const keep = [process.env.AUTO_SA, process.env.AUTO_JUDGE];
    process.env.AUTO_SA = '0'; process.env.AUTO_JUDGE = 'js';
    try { doc = (await autoPlace(parsed)).doc; } finally { [process.env.AUTO_SA, process.env.AUTO_JUDGE] = keep; if (keep[0] === undefined) delete process.env.AUTO_SA; if (keep[1] === undefined) delete process.env.AUTO_JUDGE; }
  }
  else if (engine === 'v2') { const p = importNetlist2(m, parsed); await routePage(m, p.wires, {}); normalizeOrigin(m); }
  else if (engine === 'sa') await importNetlistSA(m, parsed);
  else await importNetlist4(m, parsed);
  const png = await exportDocument(doc, getPage(doc), { format: 'png', scale: 1 });
  return png.buffer.toString('base64');   // exportDocument -> {buffer, contentType}
}
async function ask(a, b) {
  const content = [{ type: 'text', text: PROMPT }, { type: 'text', text: 'Drawing A:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + a } },
    { type: 'text', text: 'Drawing B:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b } }];
  const r = await fetch(JUDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 200, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content }] }) });
  if (!r.ok) throw new Error(`judge HTTP ${r.status}`);   // a judge outage is a failure, not an inconsistent answer
  const j = await r.json();
  const m = (j.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { better: null };
}

const ex = bankExclusions(BANK);
// every manifest of the bank (manifest-openpdk.jsonl too: its circuits crashed the run)
const man = new Map(fs.readdirSync(BANK).filter((f) => /^manifest.*\.jsonl$/.test(f))
  .flatMap((f) => fs.readFileSync(`${BANK}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).map((r) => [r.id, r]));
const inv = fs.readFileSync(`${BANK}/inventory.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => r.usable && !r.duplicateOf && !ex.has(r.id) && !r.familyWeak && r.family !== 'misc' && splitOf(r) === SPLIT && (!FAMS || FAMS.includes(famOf(r))));
const byFam = new Map();
for (const r of inv) { const f = famOf(r); if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(r); }
const pick = [...byFam.values()].flatMap((l) => l.sort((a, b) => (crypto.createHash('sha1').update(a.id).digest('hex') < crypto.createHash('sha1').update(b.id).digest('hex') ? -1 : 1)).slice(0, PER));
const fd = fs.openSync(OUT, 'w');
for (const r of pick) {
  const text = fs.readFileSync(man.get(r.id).file, 'utf8');
  const row = { id: r.id, family: famOf(r), parts: r.parts, a: EA, b: EB };
  try {
    assertNotSealed(text, r.id, { family: r.family });
    const parsed = parseSpice(text);
    const [pa, pb] = [await draw(parsed, EA), await draw(parsed, EB)];
    if (pa === pb) { row.prefers = 'same'; fs.writeSync(fd, JSON.stringify(row) + '\n'); continue; }   // both engines drew the same picture
    // both orders, the first one drawn at random per circuit (seeded by the id)
    row.firstAB = parseInt(crypto.createHash('sha1').update('order:' + r.id).digest('hex').slice(0, 2), 16) < 128;
    if (row.firstAB) { row.ab = (await ask(pa, pb)).better; row.ba = (await ask(pb, pa)).better; }
    else { row.ba = (await ask(pb, pa)).better; row.ab = (await ask(pa, pb)).better; }   // ab: A = EA ; ba: A = EB
    const vA = row.ab === 'A' ? EA : row.ab === 'B' ? EB : null, vB = row.ba === 'A' ? EB : row.ba === 'B' ? EA : null;
    row.prefers = vA && vA === vB ? vA : 'inconsistent';
  } catch (e) { row.failed = String(e.message || e).slice(0, 120); }
  fs.writeSync(fd, JSON.stringify(row) + '\n');
}
fs.closeSync(fd);
const all = fs.readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const same = all.filter((r) => r.prefers === 'same').length;
console.log(`${all.length} circuits: ${same} identical drawings, ${all.filter((r) => r.failed).length} failed`);
const rows = all.filter((r) => !r.failed && r.prefers !== 'same');
const fam = {};
for (const r of rows) { const f = (fam[r.family] ||= { n: 0, [EA]: 0, [EB]: 0, inconsistent: 0 }); f.n++; f[r.prefers]++; }
const cons = rows.filter((r) => r.prefers !== 'inconsistent').length;
console.log(`${rows.length} pairs, order-consistent ${cons} (${(100 * cons / rows.length).toFixed(0)} %): prefers ${EA} ${rows.filter((r) => r.prefers === EA).length}, ${EB} ${rows.filter((r) => r.prefers === EB).length}`);
for (const [f, v] of Object.entries(fam).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${f.padEnd(13)} n=${v.n}  ${EA} ${v[EA]}  ${EB} ${v[EB]}  inconsistent ${v.inconsistent}`);
process.exit(0);
