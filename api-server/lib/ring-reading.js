/**
 * ring-reading.js — the reading of a CMOS ring oscillator (contract and tests:
 * test/ring.test.js). Written by the local agent (Ornith, lai-delegate task
 * ring-reading, 2026-10-12) from a contract by the drawio session; reviewed.
 */
// ring-reading.mjs — lecture d'un oscillateur en anneau CMOS dans une netlist.
// Module ES, Node 22, sans dépendance.

const RAIL_POS = /^(vdd\w*|vcc\w*|vp|avdd|dvdd)$/i;
const RAIL_NEG = /^(0|gnd\w*|vss\w*|vee\w*|avss|dvss)$/i;
const OUT_RE = /^v?out/i;

const isRailPos = (n) => typeof n === 'string' && RAIL_POS.test(n);
const isRailNeg = (n) => typeof n === 'string' && RAIL_NEG.test(n);
const isRail = (n) => isRailPos(n) || isRailNeg(n);

// Comparaison naturelle de références (M2 < M10, M10 < M100, ...).
function natCompare(a, b) {
  const pa = String(a).match(/\d+|\D+/g) || [];
  const pb = String(b).match(/\d+|\D+/g) || [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const xn = /^\d/.test(x);
    const yn = /^\d/.test(y);
    if (xn || yn) {
      const nx = x ? parseInt(x, 10) || 0 : 0;
      const ny = y ? parseInt(y, 10) || 0 : 0;
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function ringReading(parsed) {
  if (!parsed || !Array.isArray(parsed.components)) return null;
  const comps = parsed.components;

  const mos = [];
  const caps = [];
  for (const c of comps) {
    if (!c || typeof c.prefix !== 'string') continue;
    const nodes = c.nodes || [];
    if (c.prefix === 'M') {
      const model = c.model || '';
      mos.push({
        ref: c.ref,
        D: nodes[0],
        G: nodes[1],
        S: nodes[2],
        B: nodes[3],
        isPmos: /pmos/i.test(model),
        isNmos: /nmos/i.test(model),
      });
    } else if (c.prefix === 'C') {
      caps.push({ ref: c.ref, nodes });
    }
  }

  // Grappe des inverseurs : PMOS + NMOS même grille (in) et même drain (out), in !== out.
  const byKey = new Map();
  const keyOf = (m) => `${JSON.stringify(m.D)}\u0000${JSON.stringify(m.G)}`;
  for (const m of mos) {
    if (m.isPmos && m.isNmos) continue; // modèle ambigu : ignoré
    if (m.isPmos || m.isNmos) {
      const key = keyOf(m);
      if (!byKey.has(key)) byKey.set(key, { p: [], n: [] });
      if (m.isPmos) byKey.get(key).p.push(m);
      else byKey.get(key).n.push(m);
    }
  }

  const stages = [];
  for (const { p, n } of byKey.values()) {
    const D = p[0]?.D;
    const G = p[0]?.G;
    if (D === undefined || D === G) continue;
    const pairs = Math.min(p.length, n.length);
    for (let i = 0; i < pairs; i++) {
      stages.push({ p: p[i].ref, n: n[i].ref, in: G, out: D });
    }
  }

  const N = stages.length;
  if (N < 3) return null;

  // graphe : edge i -> j si stages[j].in === stages[i].out
  const adj = new Array(N).fill(null).map(() => []);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i !== j && stages[j].in === stages[i].out) adj[i].push(j);
    }
  }

  // Plus long cycle simple impair (>= 3 étages).
  let bestCycle = null;
  const dfs = (start, cur, visited, path) => {
    for (const next of adj[cur]) {
      if (next === start) {
        if (path.length >= 3 && path.length % 2 === 1 &&
            (!bestCycle || path.length > bestCycle.length)) {
          bestCycle = [...path];
        }
      } else if (!visited.has(next) && path.length < N) {
        visited.add(next);
        path.push(next);
        dfs(start, next, visited, path);
        path.pop();
        visited.delete(next);
      }
    }
  };
  for (let i = 0; i < N; i++) dfs(i, i, new Set([i]), [i]);
  if (!bestCycle) return null;

  const ringRefs = new Set();
  for (const idx of bestCycle) {
    ringRefs.add(stages[idx].p);
    ringRefs.add(stages[idx].n);
  }

  // Ordre de l'anneau : la sortie de l'un alimente l'entrée du suivant.
  const inToIdx = new Map();
  for (const idx of bestCycle) inToIdx.set(stages[idx].in, idx);
  const nextOf = (idx) => inToIdx.get(stages[idx].out);

  let startIdx;
  const outMatchIdx = bestCycle.find((idx) => OUT_RE.test(stages[idx].out));
  if (outMatchIdx !== undefined) {
    startIdx = nextOf(outMatchIdx); // l'étage "out" finit en dernier
  } else {
    startIdx = bestCycle.reduce((a, b) =>
      natCompare(stages[a].p, stages[b].p) < 0 ? a : b);
  }

  const ordered = [];
  let cur = startIdx;
  for (let i = 0; i < bestCycle.length; i++) {
    ordered.push(stages[cur]);
    cur = nextOf(cur);
  }

  const pmosMap = new Map();
  const nmosMap = new Map();
  for (const m of mos) {
    if (m.isPmos) pmosMap.set(m.ref, m);
    else if (m.isNmos) nmosMap.set(m.ref, m);
  }

  const resultStages = ordered.map((s) => {
    const pcomp = pmosMap.get(s.p);
    const ncomp = nmosMap.get(s.n);
    const pSrc = pcomp?.S;
    const nSrc = ncomp?.S;

    let sp = null;
    if (typeof pSrc === 'string' && !isRail(pSrc)) {
      const cand = mos.filter(
        (m) => m.isPmos && !ringRefs.has(m.ref) && m.D === pSrc && isRailPos(m.S));
      if (cand.length) sp = cand[0].ref;
    }

    let sn = null;
    if (typeof nSrc === 'string' && !isRail(nSrc)) {
      const cand = mos.filter(
        (m) => m.isNmos && !ringRefs.has(m.ref) && m.D === nSrc && isRailNeg(m.S));
      if (cand.length) sn = cand[0].ref;
    }

    let load = null;
    for (const c of caps) {
      const nd = c.nodes;
      if ((nd[0] === s.out && isRail(nd[1])) || (nd[1] === s.out && isRail(nd[0]))) {
        load = c.ref;
        break;
      }
    }

    return { p: s.p, n: s.n, in: s.in, out: s.out, sp, sn, load };
  });

  const spRefs = resultStages.filter((s) => s.sp !== null).map((s) => s.sp);
  const snRefs = resultStages.filter((s) => s.sn !== null).map((s) => s.sn);

  let biasP = null;
  if (spRefs.length === resultStages.length && spRefs.length) {
    const gates = new Set(spRefs.map((ref) => pmosMap.get(ref)?.G));
    if (gates.size === 1) biasP = [...gates][0];
  }

  let biasN = null;
  if (snRefs.length === resultStages.length && snRefs.length) {
    const gates = new Set(snRefs.map((ref) => nmosMap.get(ref)?.G));
    if (gates.size === 1) biasN = [...gates][0];
  }

  const excluded = new Set([...ringRefs, ...spRefs, ...snRefs]);
  const biasDevs = mos.filter(
    (m) => !excluded.has(m.ref) &&
      ((biasP && m.D === biasP) || (biasN && m.D === biasN))
  ).map((m) => m.ref);

  const used = new Set();
  for (const s of resultStages) {
    used.add(s.p);
    used.add(s.n);
    if (s.sp) used.add(s.sp);
    if (s.sn) used.add(s.sn);
    if (s.load) used.add(s.load);
  }
  for (const ref of biasDevs) used.add(ref);

  return {
    stages: resultStages,
    biasP,
    biasN,
    biasDevs,
    used,
  };
}
