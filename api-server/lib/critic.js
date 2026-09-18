/**
 * critic.js — visual critique of a rendered schematic by a multimodal model.
 *
 * WHY (rule 59, RAPPORT-HERMES): « zéro erreur checker » ≠ publiable. The
 * geometry judge (tools/check.py) cannot see buried ports, OUTP/OUTM
 * asymmetries, a folded cascode that reads as a pile of parts. EEschematic
 * (arXiv 2510.17002) showed that a vision model looking at the RENDER and
 * returning structured defects is exploitable. This module does exactly and
 * only that:
 *
 *   - it is a JUDGE, never a generator (Schemato: an LLM emitting geometry
 *     collapses past five components) — findings are opinions attached to
 *     existing refdes, nothing here moves a cell;
 *   - it is OPT-IN (POST /documents/:id/critique, tools/critique.mjs) and
 *     never on the optimizer's path: one call per finalist would cost more
 *     than the whole search, and a stochastic judge inside a search loop is
 *     the noise the fast-score bug of rule 61 taught us to fear;
 *   - findings are validated: a `cells` entry that names no refdes/id of the
 *     document is dropped into `unmatched`, so the caller can never be sent
 *     to a component that does not exist.
 *
 * Backends (env or per-call `backend`):
 *   - 'anthropic' (default when ANTHROPIC_API_KEY / an `ant auth` profile
 *     resolves): official SDK, structured JSON output. CRITIC_MODEL overrides
 *     the model (default claude-opus-5).
 *   - 'openai': any OpenAI-compatible /v1/chat/completions endpoint with
 *     vision (CRITIC_URL, CRITIC_MODEL, CRITIC_API_KEY) — for the local
 *     Qwen-VL / SGLang / Ollama setups this project already uses; JSON is
 *     requested by prompt and parsed defensively.
 *   - a function `(payload) => Promise<{text}>` injected by tests.
 */
import { allCells, cellInfo } from './model.js';
import { classify, identityOf } from './components.js';
import { exportDocument } from './render.js';

export const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['publishable', 'needs-work', 'unreadable'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning', 'note'] },
          rule: { type: 'string' },
          message: { type: 'string' },
          cells: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'rule', 'message', 'cells'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
  additionalProperties: false,
};

/** The conventions the drawing is judged against — a digest of training/RULES.md,
 *  phrased as what a meticulous analogue designer expects to SEE. */
export const RULES_DIGEST = [
  'Conduction flows top to bottom: supply taps at the top, grounds at the bottom, transistor stacks vertical and x-aligned.',
  'Inputs enter from the left, outputs leave to the right; a named port must be visible and not buried inside a structure.',
  'Differential pairs sit on the same row, mirrored, gates outward, tail centred below; current-mirror members share one row with a straight gate bus.',
  'Every wire is orthogonal except the deliberate X of a cross-coupled pair; no wire crosses a component body; no two different nets overlap or touch.',
  'A junction dot exists exactly where three or more conductors meet, never on a plain corner or a two-way pass-through.',
  'Labels are horizontal, never struck by a wire, never overlapping another label; each net name appears once.',
  'Feedback elements (Miller cap, shunt-feedback R) sit in a lane between rows, not inside a stack; a diode-connected device hugs its node.',
  'The sheet breathes: no crowding, no sprawl, balanced ink; symmetry of the circuit is symmetry of the drawing (OUTP/OUTM at the same height).',
];

function inventory(model) {
  const out = [];
  for (const raw of allCells(model)) {
    const c = cellInfo(raw);
    if (c.kind !== 'vertex' || c.x == null) continue;
    const cls = classify(c);
    if (cls.role === 'component') out.push({ id: identityOf(c), kind: cls.prefix || '?', value: String(c.value || '').trim(), x: Math.round(c.x), y: Math.round(c.y) });
    else if (cls.role === 'port' || cls.role === 'power') out.push({ id: c.id, kind: cls.role, net: cls.net, x: Math.round(c.x), y: Math.round(c.y) });
  }
  return out;
}

export function buildPrompt(model, { netlist = null } = {}) {
  const inv = inventory(model);
  const lines = inv.map((i) => `${i.id}\t${i.kind}${i.net ? ' net=' + i.net : ''}${i.value ? ' ' + i.value : ''}\t(${i.x},${i.y})`);
  return [
    'You are a meticulous analogue IC designer reviewing an automatically drawn schematic before publication.',
    'Judge ONLY what the picture shows. Do not redraw, do not propose coordinates. Report defects a reader would notice, worst first.',
    'Conventions expected:',
    ...RULES_DIGEST.map((r) => '- ' + r),
    '',
    'Components on the sheet (id, kind, value, top-left in diagram units). Use these exact ids in `cells`; use [] when a finding is global:',
    ...lines,
    ...(netlist ? ['', 'Reference SPICE netlist (connectivity is already verified electrically; judge readability only):', netlist] : []),
    '',
    'Answer with JSON only: {verdict, summary, findings:[{severity, rule, message, cells}]}. `rule` is a short kebab-case tag (e.g. buried-port, asymmetric-outputs, crowded, sprawl, unreadable-label, wrong-flow).',
  ].join('\n');
}

async function anthropicBackend({ png, prompt, model }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create({
    model: model || process.env.CRITIC_MODEL || 'claude-opus-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      { type: 'text', text: prompt },
    ] }],
    output_config: { format: { type: 'json_schema', schema: FINDING_SCHEMA } },
  });
  if (response.stop_reason === 'refusal') throw new Error('critic refused: ' + JSON.stringify(response.stop_details || {}));
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, model: response.model, usage: response.usage };
}

async function openaiBackend({ png, prompt, model }) {
  const base = (process.env.CRITIC_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CRITIC_API_KEY) headers.Authorization = 'Bearer ' + process.env.CRITIC_API_KEY;
  const body = JSON.stringify({
    model: model || process.env.CRITIC_MODEL || 'qwen2.5-vl',
    temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
      { type: 'text', text: prompt },
    ] }],
  });
  // node:http rather than fetch(): undici's 300 s headers timeout is shorter
  // than a cold local 30B vision model (measured: Qwen3.6-vision on Ollama
  // needs > 5 min to load and answer). CRITIC_TIMEOUT_MS defaults to 30 min.
  const timeoutMs = parseInt(process.env.CRITIC_TIMEOUT_MS || '', 10) || 30 * 60 * 1000;
  const { default: http } = await import(base.startsWith('https:') ? 'node:https' : 'node:http');
  const text = await new Promise((resolve, reject) => {
    const req = http.request(base, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve(data) : reject(new Error(`critic backend ${base} -> HTTP ${res.statusCode}: ${data.slice(0, 200)}`)));
    });
    req.on('timeout', () => { req.destroy(new Error(`critic backend timeout after ${timeoutMs} ms`)); });
    req.on('error', reject);
    req.end(body);
  });
  const j = JSON.parse(text);
  return { text: j.choices?.[0]?.message?.content || '', model: j.model, usage: j.usage };
}

/** Parse the model's JSON defensively (fences, prose around it). */
export function parseFindings(text) {
  let t = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{')) { const i = t.indexOf('{'); const j = t.lastIndexOf('}'); if (i >= 0 && j > i) t = t.slice(i, j + 1); }
  const j = JSON.parse(t);
  const findings = Array.isArray(j.findings) ? j.findings : [];
  return {
    verdict: ['publishable', 'needs-work', 'unreadable'].includes(j.verdict) ? j.verdict : 'needs-work',
    summary: String(j.summary || ''),
    findings: findings.map((f) => ({
      severity: ['error', 'warning', 'note'].includes(f.severity) ? f.severity : 'note',
      rule: String(f.rule || 'unspecified').toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      message: String(f.message || ''),
      cells: Array.isArray(f.cells) ? f.cells.map(String) : [],
    })),
  };
}

/**
 * Render the page, ask the critic, validate cell references.
 * Returns {verdict, summary, findings, unmatched, model, usage, prompt_chars}.
 */
export async function critique(doc, model, { backend, netlist = null, modelName, scale = 1.5 } = {}) {
  const png = (await exportDocument(doc, model, { format: 'png', scale })).buffer;
  const prompt = buildPrompt(model, { netlist });
  let call = backend;
  if (typeof call !== 'function') {
    const name = backend || process.env.CRITIC_BACKEND || (process.env.CRITIC_URL ? 'openai' : 'anthropic');
    call = name === 'openai' ? openaiBackend : anthropicBackend;
  }
  const res = await call({ png, prompt, model: modelName });
  const parsed = parseFindings(res.text);
  const known = new Set();
  for (const raw of allCells(model)) { const c = cellInfo(raw); known.add(String(c.id)); if (c.refdes) known.add(String(c.refdes)); }
  const unmatched = [];
  for (const f of parsed.findings) {
    const ok = [];
    for (const id of f.cells) { if (known.has(id)) ok.push(id); else unmatched.push({ rule: f.rule, cell: id }); }
    f.cells = ok;
  }
  return { ...parsed, unmatched, model: res.model || modelName || null, usage: res.usage || null, prompt_chars: prompt.length };
}
