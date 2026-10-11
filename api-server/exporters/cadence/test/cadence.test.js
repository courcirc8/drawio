// exporters/cadence: neutral → Virtuoso plan → Python (skillbridge) / SKILL,
// checked without Virtuoso: the plan alone redraws the deck, the generated
// Python compiles and runs on a fake Virtuoso (test/fake), the generated SKILL
// runs in a small SKILL interpreter on the same fake, nothing reaches the
// network, and the 5 reference circuits stay PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSpice } from '../../../lib/netlist.js';
import { exportCadence, checkPlan, cadNet, toSkill } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake');
const DECKS = ['ota5t', 'miller', 'lna-cascode', 'cml-comparator', 'vco-lc'];
const deck = (d) => parseSpice(fs.readFileSync(path.join(HERE, 'decks', d + '.sp'), 'utf8'));
const cache = new Map();
const exp = async (d) => { if (!cache.has(d)) cache.set(d, await exportCadence(deck(d))); return cache.get(d); };

/** Run a generated script (python or skill) on the fake Virtuoso; returns { code, report }. */
function runFake(kind, text, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
  const file = path.join(dir, kind === 'python' ? 'x.py' : 'x.il');
  fs.writeFileSync(file, text);
  const r = spawnSync('python3', [path.join(FAKE, 'run_fake.py'), kind, file, '--report', path.join(dir, 'r.txt'), ...args],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PYTHONPATH: FAKE } });
  const report = fs.existsSync(path.join(dir, 'r.txt')) ? fs.readFileSync(path.join(dir, 'r.txt'), 'utf8') : '';
  return { code: r.status, report, out: r.stdout + r.stderr };
}

test('cadence: net names (ground → gnd!, Virtuoso netN kept apart, unsafe chars)', () => {
  assert.equal(cadNet('0'), 'gnd!');
  assert.equal(cadNet('net3'), 'net3_d');
  assert.equal(cadNet('a#b'), 'a_b');
  assert.equal(cadNet('out<1>'), 'out<1>');
});

test('cadence: SKILL literals', () => {
  assert.equal(toSkill({ a: [1, 2], b: 'x"y', c: [], d: null }), 'cadxD(list("a" list(1.0 2.0) "b" "x\\"y" "c" nil "d" nil))');
  assert.equal(toSkill([[0, -1.5], [-2, 3]]), 'list(list(0.0 (-1.5)) list((-2.0) 3.0))');
});

for (const d of DECKS) {
  test(`cadence: ${d} — the plan alone redraws the deck, instances and nets match the neutral`, async () => {
    const r = await exp(d), p = deck(d);
    assert.deepEqual(r.check, { opens: 0, shorts: 0, groundWrong: 0, portsWrong: 0 });
    assert.deepEqual(r.plan.components.map((c) => c.ref).sort(), r.neutral.components.map((c) => c.ref).sort());
    assert.deepEqual(r.plan.components.map((c) => c.ref).sort(), p.components.map((c) => c.ref).sort());
    const nodes = new Set(p.components.flatMap((c) => c.fullNodes || c.nodes));
    assert.equal(new Set(r.plan.expected.terminals.map((t) => t.node)).size, nodes.size);
    // every coordinate on Virtuoso's grid
    const g = r.plan.grid, on = (v) => Math.abs(v / g - Math.round(v / g)) < 1e-9;
    for (const w of r.plan.wires) for (const q of w.points) assert.ok(on(q[0]) && on(q[1]));
    // no parameter invented: every value comes from the deck line
    for (const c of r.plan.components) for (const v of Object.values(c.params.kv)) assert.ok(p.components.find((x) => x.ref === c.ref).value.includes(v));
  });
}

test('cadence: a cut wire is caught by the plan check', async () => {
  const r = structuredClone((await exp('ota5t')).plan);
  const i = r.wires.findIndex((w) => w.net !== '0');
  r.wires.splice(i, 1);
  const c = checkPlan(r);
  assert.ok(c.opens + c.shorts + c.portsWrong > 0);
});

test('cadence: the Python script compiles and imports nothing that reaches the network', async () => {
  const r = await exp('miller'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
  const f = path.join(dir, 'x.py'); fs.writeFileSync(f, r.python);
  execFileSync('python3', ['-m', 'py_compile', f]);
  const imports = execFileSync('python3', ['-c', `import ast,sys\nt=ast.parse(open(sys.argv[1]).read())\nprint(' '.join(sorted({(n.module if isinstance(n, ast.ImportFrom) else a.name).split('.')[0] for n in ast.walk(t) if isinstance(n,(ast.Import,ast.ImportFrom)) for a in n.names})))`, f], { encoding: 'utf8' }).trim().split(' ');
  assert.deepEqual(imports, ['argparse', 'hashlib', 'json', 'skillbridge', 'sys']);
  assert.doesNotMatch(r.python, /socket|urllib|http|requests|subprocess|os\.system/);
});

test('cadence: the SKILL file is balanced and calls nothing outside the schematic API', async () => {
  const r = await exp('miller');
  let depth = 0, inStr = false, inCom = false;
  for (let i = 0; i < r.skill.length; i++) {
    const ch = r.skill[i];
    if (inCom) { if (ch === '\n') inCom = false; continue; }
    if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
    if (ch === ';') inCom = true; else if (ch === '"') inStr = true;
    else if (ch === '(') depth++; else if (ch === ')') { depth--; assert.ok(depth >= 0); }
  }
  assert.equal(depth, 0); assert.equal(inStr, false);
  assert.doesNotMatch(r.skill, /ipcBeginProcess|ipcSkillProcess|system\(|sh\(|shell\(|socket|http/);
});

for (const d of DECKS) {
  test(`cadence: ${d} — Python on the fake Virtuoso: PASS, counts only in the report`, async () => {
    const r = await exp(d);
    const { code, report, out } = runFake('python', r.python);
    assert.equal(code, 0, out);
    assert.match(report, /^result: PASS$/m);
    assert.match(report, new RegExp(`^instances: expected ${r.plan.components.length}, created ${r.plan.components.length}$`, 'm'));
    assert.match(report, /^opens: 0, shorts: 0, ground wrong: 0$/m);
    // confidentiality: no library, cell or instance name in the report
    assert.doesNotMatch(report, /analogLib|nmos4|pmos4|basic|iopin|work\b|M1\b/);
  });
  test(`cadence: ${d} — SKILL on the fake Virtuoso: same result as Python`, async () => {
    const r = await exp(d);
    const py = runFake('python', r.python), il = runFake('skill', r.skill);
    assert.equal(il.code, 0, il.out);
    const body = (t) => t.split('\n').filter((l) => !/^cadence-export report/.test(l)).join('\n');
    assert.equal(body(il.report), body(py.report));
  });
}

test('cadence: a local map overrides the symbols (a foundry-like NMOS), names stay out of the report', async () => {
  const r = await exp('ota5t');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
  const map = path.join(dir, 'my.map');
  fs.writeFileSync(map, 'model.nmos = fdry\nfdry.lib = SECRETPDK\nfdry.cell = nch_secret\nfdry.terms = d g s b\nfdry.param.w = w\nfdry.param.l = l\n');
  for (const kind of ['python', 'skill']) {
    const x = runFake(kind, kind === 'python' ? r.python : r.skill, ['--map', map, '--fake-secret-pdk']);
    assert.equal(x.code, 0, x.out);
    assert.match(x.report, /^result: PASS$/m);
    assert.doesNotMatch(x.report, /SECRETPDK|nch_secret|fdry/);
  }
});

test('cadence: an existing schematic is not overwritten without --overwrite', async () => {
  const r = await exp('ota5t');
  const x = runFake('python', r.python, ['--existing']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /already exists/);
});

test('cadence: a symbol whose terminals disagree with the map makes the report FAIL', async () => {
  const r = await exp('ota5t');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-')), map = path.join(dir, 'bad.map');
  fs.writeFileSync(map, 'nmos.terms = X G S B\n');
  const x = runFake('python', r.python, ['--map', map]);
  assert.notEqual(x.code, 0);
  assert.match(x.report, /^result: FAIL$/m);
});

test('cadence: a wire missing from the plan makes the run FAIL (Python and SKILL): the self-check bites', async () => {
  const { writePython, writeSkill } = await import('../index.js');
  const plan = structuredClone((await exp('miller')).plan);
  plan.wires.splice(plan.wires.findIndex((w) => w.net !== '0'), 1);
  for (const [kind, text] of [['python', writePython(plan)], ['skill', writeSkill(plan)]]) {
    const x = runFake(kind, text);
    assert.notEqual(x.code, 0, kind);
    assert.match(x.report, /^result: FAIL$/m);
    assert.match(x.report, /^opens: [1-9]/m);
  }
});

test('cadence: the fake Virtuoso and the SKILL interpreter pass their own tests', () => {
  const r = spawnSync('python3', ['-m', 'pytest', '-q', path.join(FAKE, 'tests')], { encoding: 'utf8', cwd: FAKE, env: { ...process.env, PYTHONPATH: FAKE } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('cadence: a local profile written at the user\'s site makes a second pass place on the real pins', async () => {
  const p = deck('miller'), first = await exp('miller');
  const profiles = {};
  for (const kind of ['python', 'skill']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-')), prof = path.join(dir, 'p.json');
    const x = runFake(kind, kind === 'python' ? first.python : first.skill, ['--write-profile', prof]);
    assert.equal(x.code, 0, x.out);
    profiles[kind] = JSON.parse(fs.readFileSync(prof, 'utf8'));
    assert.equal(profiles[kind].format, 'cadence-profile/1');
    assert.deepEqual(Object.keys(profiles[kind].symbols).sort(), ['cap', 'nmos', 'pmos', 'vsrc']);
    assert.doesNotMatch(fs.readFileSync(prof, 'utf8'), /analogLib|nmos4/);   // roles only, no library names
  }
  assert.deepEqual(profiles.skill, profiles.python);
  const second = await exportCadence(p, { profile: profiles.python });
  const stubs = (r) => Number(/stubs (\d+)/.exec(r)[1]);
  const before = runFake('python', first.python), after = runFake('python', second.python), afterIl = runFake('skill', second.skill);
  assert.match(after.report, /^result: PASS$/m);
  assert.match(afterIl.report, /^result: PASS$/m);
  assert.ok(stubs(after.report) < stubs(before.report) / 2, `${stubs(before.report)} → ${stubs(after.report)} stubs`);
});
