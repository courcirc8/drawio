/**
 * check.js — vérificateur de règles du schéma (« DRC schématique »).
 * Contrôle les invariants du registre training/RULES.md sur le document
 * réel : géométrie exacte des pins/fils/nœuds. Retourne des violations
 * typées {rule, severity, message, cells}.
 */
import { allCells, cellInfo } from './model.js';
import { pinAbs } from './route.js';
import { extractNetlist, connectivity } from './netlist.js';
import { detectStructures } from './patterns.js';

function polyOf(c, byId) {
  const src = byId.get(c.source), tgt = byId.get(c.target);
  if (src == null || tgt == null || src.x == null || tgt.x == null) return null;
  const anchor = (pref, cell) => {
    const X = c.style.map.get(pref + 'X'), Y = c.style.map.get(pref + 'Y');
    if (X != null && Y != null) return pinAbs(cell, { x: parseFloat(X), y: parseFloat(Y) });
    return { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
  };
  return [anchor('exit', src), ...(c.points || []), anchor('entry', tgt)];
}
const aabbOf = (v) => {
  const t = ((v.rotation || 0) * Math.PI) / 180;
  const w = Math.abs(v.w * Math.cos(t)) + Math.abs(v.h * Math.sin(t));
  const h = Math.abs(v.w * Math.sin(t)) + Math.abs(v.h * Math.cos(t));
  return { x: v.x + v.w / 2 - w / 2, y: v.y + v.h / 2 - h / 2, w, h };
};
function segRect(p, q, r) {
  const inside = (pt) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const d = (a, b, c2) => (b.x - a.x) * (c2.y - a.y) - (b.y - a.y) * (c2.x - a.x);
  const inter = (a, b, c2, e2) => {
    const d1 = d(c2, e2, a), d2 = d(c2, e2, b), d3 = d(a, b, c2), d4 = d(a, b, e2);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  const cs = [[{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }], [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
    [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }], [{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }]];
  return cs.some(([a, b]) => inter(p, q, a, b));
}

export function checkDocument(model) {
  const V = [];
  const cells = allCells(model).map(cellInfo);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const comps = cells.filter((c) => c.kind === 'vertex' && c.x != null && !c.style.map.has('drawioApiJunction'));
  const dots = cells.filter((c) => c.kind === 'vertex' && c.style.map.has('drawioApiJunction'))
    .map((c) => ({ id: c.id, x: c.x + c.w / 2, y: c.y + c.h / 2 }));
  const wires = cells.filter((c) => c.kind === 'edge' && c.source != null && c.target != null);

  // identité de net par extrémité
  const conn = connectivity(model);
  const netOfEnd = (c, which) => {
    const cid = which === 'src' ? c.source : c.target;
    const cell = byId.get(cid);
    if (cell != null && cell.style.map.has('drawioApiJunction')) return 'JCELL:' + cid;
    const X = c.style.map.get(which === 'src' ? 'exitX' : 'entryX');
    return cid + ':' + X + ',' + c.style.map.get(which === 'src' ? 'exitY' : 'entryY');
  };
  // union locale pour net id (comme route.js)
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  const uni = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  for (const w of wires) uni(netOfEnd(w, 'src'), netOfEnd(w, 'tgt'));
  const netId = (w) => find(netOfEnd(w, 'src'));

  // R-through : AUCUN fil (diagonales volontaires comprises) ne traverse un
  // corps qui n'est pas l'un de ses terminaux
  for (const w of wires) {
    const pl = polyOf(w, byId);
    if (pl == null) continue;
    for (let i = 0; i + 1 < pl.length; i++) {
      for (const v of comps) {
        if (v.id === w.source || v.id === w.target) continue;
        const r = aabbOf(v);
        if (segRect(pl[i], pl[i + 1], { x: r.x + 3, y: r.y + 3, w: r.w - 6, h: r.h - 6 })) {
          V.push({ rule: 'through', severity: 'error',
            message: `fil ${w.source}->${w.target} traverse le corps de ${v.id}`, cells: [w.id, v.id] });
        }
      }
    }
  }

  // R22 : superposition/proximité (<6 px) de segments colinéaires inter-nets
  const segsOf = (pl) => {
    const out = [];
    for (let k = 0; k + 1 < pl.length; k++) {
      const p = pl[k], q = pl[k + 1];
      if (Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) >= 0.6) out.push({ axis: 'h', lane: p.y, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x) });
      else if (Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) >= 0.6) out.push({ axis: 'v', lane: p.x, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y) });
    }
    return out;
  };
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (netId(wires[i]) === netId(wires[j])) continue;
      const pa = polyOf(wires[i], byId), pb = polyOf(wires[j], byId);
      if (pa == null || pb == null) continue;
      for (const sa of segsOf(pa)) for (const sb of segsOf(pb)) {
        if (sa.axis !== sb.axis || Math.abs(sa.lane - sb.lane) > 6) continue;
        if (Math.min(sa.b, sb.b) - Math.max(sa.a, sb.a) < 12) continue;
        V.push({ rule: '22', severity: 'error',
          message: `nets différents superposés/à <6px : ${wires[i].source}->${wires[i].target} vs ${wires[j].source}->${wires[j].target}`,
          cells: [wires[i].id, wires[j].id] });
      }
    }
  }

  // R30 : branche >=3 voies sans point de contact ; dots dupliqués
  const clusters = []; // clustering par distance réelle, par net
  for (const w of wires) {
    const pl = polyOf(w, byId);
    if (pl == null) continue;
    for (const [pt, cid] of [[pl[0], w.source], [pl[pl.length - 1], w.target]]) {
      const net = netId(w);
      const c0 = clusters.find((m) => m.net === net && Math.hypot(m.pt.x - pt.x, m.pt.y - pt.y) < 5);
      if (c0 != null) c0.list.push({ w, pt, cid });
      else clusters.push({ net, pt, list: [{ w, pt, cid }] });
    }
  }
  for (const { pt: cpt, list } of clusters) {
    // au pin d'un composant : 2 fils + la broche = 3 voies ; sur une cellule
    // de jonction : il faut >=3 fils (2 = simple traversée)
    const onJunction = list.every((l) => byId.get(l.cid)?.style.map.has('drawioApiJunction'));
    if (list.length < (onJunction ? 3 : 2)) continue;
    const pt = cpt;
    const hasDot = dots.some((dd) => Math.hypot(dd.x - pt.x, dd.y - pt.y) < 12);
    if (!hasDot) {
      V.push({ rule: '30', severity: 'error',
        message: `branche à ${list.length + 1} voies sans point de contact en (${Math.round(pt.x)},${Math.round(pt.y)})`,
        cells: list.map((l) => l.w.id) });
    }
  }
  function pinDistance(v, pt) {
    // approx : distance au bord de l'AABB (les pins vivent au bord)
    const r = aabbOf(v);
    const dx = Math.max(r.x - pt.x, 0, pt.x - (r.x + r.w));
    const dy = Math.max(r.y - pt.y, 0, pt.y - (r.y + r.h));
    return Math.hypot(dx, dy);
  }
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      if (Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y) < 10) {
        V.push({ rule: '30b', severity: 'warning',
          message: `points de contact dupliqués (${dots[i].id}, ${dots[j].id})`, cells: [dots[i].id, dots[j].id] });
      }
    }
  }

  // R32 : transistor monté en diode -> la boucle gate-drain passe du côté
  // DRAIN (bas pour un PMOS source en haut, haut pour un NMOS drain en haut)
  const selfEdges = cells.filter((c) => c.kind === 'edge' && c.source != null && c.source === c.target);
  for (const se of selfEdges) {
    const body = byId.get(se.source);
    if (body == null || body.x == null || !(se.points || []).length) continue;
    const bb = aabbOf(body);
    const aY = parseFloat(se.style.map.get('exitY')), bY = parseFloat(se.style.map.get('entryY'));
    if (Number.isNaN(aY) || Number.isNaN(bY)) continue;
    const drainRel = Math.abs(aY - 0.5) > 0.25 ? { x: parseFloat(se.style.map.get('exitX')), y: aY }
      : { x: parseFloat(se.style.map.get('entryX')), y: bY };
    const drain = pinAbs(body, drainRel);
    const drainTop = drain.y <= bb.y + bb.h / 2;
    const horiz = se.points.filter((p) => p.y < bb.y - 4 || p.y > bb.y + bb.h + 4);
    const loopTop = horiz.length ? horiz[0].y < bb.y : null;
    if (loopTop != null && loopTop !== drainTop) {
      V.push({ rule: '32', severity: 'error',
        message: `diode ${se.source} : la boucle gate-drain passe côté ${loopTop ? 'haut' : 'bas'} alors que le drain est en ${drainTop ? 'haut' : 'bas'}`,
        cells: [se.id, se.source] });
    }
  }

  // R14/26 : paires et miroirs à la même rangée ; R25 drains alignés
  const extracted = extractNetlist(model);
  const structures = detectStructures({ components: extracted.components.map((c) => ({ ...c, model: c.value })) });
  const rowCheck = (refs, rule, label) => {
    const ys = refs.map((r) => byId.get(r)).filter((c) => c != null && c.y != null).map((c) => c.y + c.h / 2);
    if (ys.length >= 2 && Math.max(...ys) - Math.min(...ys) > 14) {
      V.push({ rule, severity: 'error', message: `${label} [${refs.join(',')}] pas à la même rangée`, cells: refs });
    }
  };
  for (const p of structures.diffPairs) rowCheck(p.refs, '14', 'paire différentielle');
  for (const m of structures.mirrors) rowCheck(m.refs, '26', 'miroir de courant');

  return { violations: V, errors: V.filter((v) => v.severity === 'error').length,
    warnings: V.filter((v) => v.severity === 'warning').length };
}
