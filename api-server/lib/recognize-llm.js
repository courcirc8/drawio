/**
 * recognize-llm.js — function recognition, step B: retrieval of published
 * schematics with the same motifs + a local LLM, checked by the detectors.
 *
 *   1. lib/function.js ranks the circuit types (naive Bayes on the IEEE
 *      statistics) and names blocks and nets.
 *   2. Retrieval: the IEEE readings index (identifiers and labels only, built
 *      by tools/build-motif-index.py OUTSIDE the repository, on the station)
 *      gives the published schematics whose motif set is closest (Jaccard);
 *      their type distribution is a second vote.
 *   3. The local LLM (OpenAI-compatible, default the shared Ornith on :30010)
 *      gets the netlist, motifs, block/net roles, the Bayes ranking and the
 *      neighbours' types, and answers in constrained JSON.
 *   4. Control: the LLM's type is kept only if it is among the Bayes top 8 or
 *      the neighbours' types (or a power type decided by rule); blocks and nets
 *      it names must exist. Otherwise the Bayes answer stands and the
 *      disagreement is reported. Nothing of the corpus is sent anywhere: the
 *      index holds no text, the LLM runs on the station.
 */
import fs from 'node:fs';
import { recognizeFunction, netRoles, blockRoles, TYPES } from './function.js';

const INDEX_PATH = process.env.IEEE_MOTIF_INDEX || '/AI/datasets/IEEE/derived/motif-index.json';
const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:30010/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'ornith-1.5-35b';
const POWER = ['rectifier', 'inverter', 'DC-DC'];
const CONTROL_TOP = Number(process.env.RC_TOP ?? 8);   // 3: 47/53, 8: 48/53, no control (20): 45/53
let INDEX = null;

function loadIndex() {
  if (INDEX !== null) return INDEX;
  try { INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')).records; } catch { INDEX = []; }
  return INDEX;
}

/** Published schematics whose motif SET is closest to `motifs` (Jaccard). */
export function similarSchematics(motifs, k = 20) {
  const q = new Set(motifs);
  if (!q.size) return [];
  const out = [];
  for (const r of loadIndex()) {
    const s = new Set(Object.keys(r.motifs));
    if (!s.size) continue;
    let inter = 0; for (const m of q) if (s.has(m)) inter++;
    if (!inter) continue;
    const j = inter / (q.size + s.size - inter);
    out.push({ id: r.id, page: r.page, rang: r.rang, type: r.type, motifs: Object.keys(r.motifs), score: +j.toFixed(3) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

function compactNetlist(parsed, max = 60) {
  return parsed.components.slice(0, max).map((c) => `${c.ref} ${c.nodes.join(' ')} ${c.value || c.model || ''}`.trim()).join('\n') +
    (parsed.components.length > max ? `\n… ${parsed.components.length - max} more` : '');
}

async function askLLM(prompt, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(LLM_URL, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, temperature: 0, max_tokens: 900, chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: 'user', content: prompt }] }) });
    if (!r.ok) throw new Error('LLM HTTP ' + r.status);
    const j = await r.json();
    const txt = j.choices?.[0]?.message?.content || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM answer has no JSON');
    return JSON.parse(m[0]);
  } finally { clearTimeout(t); }
}

/** Full recognition. opts.llm=false skips the LLM (Bayes + retrieval only). */
export async function recognize(parsed, { llm = true, timeoutMs = 30000, k = 20 } = {}) {
  const bayes = recognizeFunction(parsed);
  const nets = netRoles(parsed);
  const blocks = blockRoles(parsed);
  const similar = similarSchematics(bayes.motifs, k);
  const votes = {};
  for (const s of similar) if (s.type) votes[s.type] = (votes[s.type] || 0) + 1;
  const neighbourTypes = Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ type: t, n }));
  const result = { type: bayes.types[0].type, confidence: bayes.types[0].p, source: bayes.rule, bayes: bayes.types.slice(0, 5),
    neighbours: { index: loadIndex().length, top: similar.slice(0, 5), types: neighbourTypes }, nets, blocks, motifs: bayes.motifs };
  if (!llm || bayes.rule !== 'bayes') return result;   // power/zener rules are not second-guessed
  const allowed = [...TYPES, ...POWER, 'other'];
  const prompt = [
    'You are an analog/RF IC designer. Identify the FUNCTION of this circuit.',
    'SPICE netlist (ref nodes value):', compactNetlist(parsed),
    `Detected motifs: ${bayes.motifs.join(', ') || 'none'}`,
    `Blocks: ${blocks.map((b) => `${b.id}=${b.role} [${b.refs.join(' ')}]`).join('; ') || 'none'}`,
    `Net roles by name/topology: ${Object.entries(nets).map(([n, r]) => `${n}:${r}`).join(', ')}`,
    `Statistical ranking from 10 966 published IEEE schematics: ${bayes.types.slice(0, 5).map((t) => `${t.type} ${t.p}`).join(', ')}`,
    `Types of the published schematics with the most similar motifs: ${neighbourTypes.slice(0, 5).map((t) => `${t.type}×${t.n}`).join(', ') || 'none'}`,
    `Answer with JSON only: {"type": one of ${JSON.stringify(allowed)}, "confidence": 0..1, "function": "one sentence",`,
    ' "blocks": [{"id": block id, "role": "short role"}], "nets": {"net name": "input|output|bias|supply|clock|feedback|internal"}, "rationale": "two sentences"}',
  ].join('\n');
  try {
    const a = await askLLM(prompt, timeoutMs);
    const okType = allowed.includes(a.type);
    const plausible = okType && (bayes.types.slice(0, CONTROL_TOP).some((t) => t.type === a.type) || neighbourTypes.some((t) => t.type === a.type));
    const blockIds = new Set(blocks.map((b) => b.id));
    const llmBlocks = Array.isArray(a.blocks) ? a.blocks.filter((b) => blockIds.has(b.id)) : [];
    const llmNets = Object.fromEntries(Object.entries(a.nets || {}).filter(([n]) => n in nets));
    result.llm = { type: a.type, confidence: a.confidence, function: a.function, rationale: a.rationale, accepted: plausible };
    if (plausible) { result.type = a.type; result.confidence = a.confidence ?? result.confidence; result.source = 'llm+bayes'; result.function = a.function; }
    else result.llm.rejected = okType ? 'type outside the Bayes top 5 and the neighbours' : 'type not in the allowed list';
    for (const b of llmBlocks) { const blk = result.blocks.find((x) => x.id === b.id); if (blk) blk.llmRole = String(b.role).slice(0, 80); }
    result.llmNets = llmNets;
  } catch (e) {
    result.llm = { error: String(e.message || e).slice(0, 120) };
  }
  return result;
}
