/**
 * place-elk.js — S2 : moteur de placement par graphe en couches (elkjs),
 * l'approche Weave/netlistsvg, avec le bundle ELK du fork chargé headless.
 *  - un nœud ELK par composant, ports FIXED_POS aux positions exactes des
 *    pins du stencil ;
 *  - nets multi-terminaux : nœud-jonction + étoile (ELK place aussi la
 *    jonction) ; direction DOWN pour le flux de conduction, gates en ports
 *    latéraux ;
 *  - échelle de modes (Weave) : options riches → dégradées, premier résultat
 *    accepté (le LVS est garanti par construction, le score départage en
 *    aval via ?optimize).
 * Le câblage/rails/ports réutilise wireNets() de place2.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { addVertex, httpError } from './model.js';
import { SPICE_MAP } from './components.js';
import { getShape, getPin } from './stencils.js';
import { condInfo, wireNets } from './place2.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELK_BUNDLE = path.resolve(HERE, '../../src/main/webapp/js/elk/drawio-elk.min.js');
let elkInstance = null;

function getElk() {
  if (elkInstance == null) {
    vm.runInThisContext(fs.readFileSync(ELK_BUNDLE, 'utf8'), { filename: 'drawio-elk.min.js' });
    elkInstance = new globalThis.ELK();
  }
  return elkInstance;
}

const JCT = 'ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;';

const MODES = [
  { // mode 1 : couches direction DOWN, ports fixes, espacement généreux
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '60', 'elk.spacing.edgeNode': '25',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  },
  { // mode 2 : défauts ELK purs
    'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
  },
];

export async function importNetlistElk(model, parsed, opts = {}) {
  const comps = parsed.components;
  if (comps.length === 0) throw httpError(400, 'netlist vide');
  const info = new Map();
  for (const c of comps) {
    let ci = condInfo(c);
    if (ci == null && SPICE_MAP[c.prefix] != null) {
      const map = SPICE_MAP[c.prefix];
      ci = { shapeKey: map.shape, po: map.pinOrder };
    }
    if (ci != null) info.set(c.ref, ci);
  }
  const railNames = new Set(['0']);
  let vddNet = [...new Set(comps.flatMap((c) => c.nodes))].find((n) => /^vdd$/i.test(n));
  if (vddNet == null) {
    const tops = new Map();
    for (const c of comps) {
      const ci = info.get(c.ref);
      if (ci != null && ci.top != null && ci.top !== '0') tops.set(ci.top, (tops.get(ci.top) || 0) + 1);
    }
    vddNet = [...tops.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  // --- graphe ELK
  const nodes = [];
  const edges = [];
  const portId = (ref, pin) => `${ref}__${pin}`;
  for (const c of comps) {
    const ci = info.get(c.ref);
    if (ci == null) continue;
    const shape = getShape(ci.shapeKey);
    nodes.push({
      id: c.ref, width: shape.w, height: shape.h,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: ci.po.map((pn) => {
        const p = getPin(ci.shapeKey, pn) || { x: 0.5, y: 0.5 };
        return { id: portId(c.ref, pn), x: p.x * shape.w - 1, y: p.y * shape.h - 1, width: 2, height: 2 };
      }),
    });
  }
  // nets : terminaux par net (hors rails, gérés par wireNets)
  const netTermsList = new Map();
  for (const c of comps) {
    const ci = info.get(c.ref);
    if (ci == null) continue;
    c.nodes.forEach((n, i) => {
      if (n === '0' || n === vddNet) return;
      if (!netTermsList.has(n)) netTermsList.set(n, []);
      netTermsList.get(n).push({ ref: c.ref, pin: ci.po[i], isTop: ci.top === n, isGate: ci.gatePin === ci.po[i] });
    });
  }
  let eseq = 0, jseq = 0;
  const junctionNodes = [];
  for (const [net, terms] of netTermsList) {
    if (terms.length === 2) {
      // orientation conduction : top->bottom sinon driver->gate
      const [a, b] = terms;
      const src = a.isTop || b.isGate ? a : b;
      const dst = src === a ? b : a;
      edges.push({ id: 'e' + (++eseq), sources: [portId(src.ref, src.pin)], targets: [portId(dst.ref, dst.pin)] });
    } else if (terms.length > 2) {
      const jid = 'J_' + net.replace(/[^A-Za-z0-9]/g, '_');
      junctionNodes.push(jid);
      nodes.push({ id: jid, width: 6, height: 6 });
      for (const t of terms) {
        const gate = t.isGate;
        edges.push({ id: 'e' + (++eseq),
          sources: gate ? [jid] : [portId(t.ref, t.pin)],
          targets: gate ? [portId(t.ref, t.pin)] : [jid] });
      }
    }
  }

  // --- échelle de modes
  let layout = null, modeUsed = -1;
  const elk = getElk();
  for (let mi = 0; mi < MODES.length; mi++) {
    try {
      layout = await elk.layout({ id: 'root', layoutOptions: MODES[mi], children: nodes, edges });
      modeUsed = mi;
      break;
    } catch (e) { /* mode suivant */ }
  }
  if (layout == null) throw httpError(500, 'ELK: tous les modes ont échoué');

  // --- matérialisation
  const placed = new Map();
  const elkJunctionPos = new Map();
  const netTerms = new Map();
  const term = (net, ref, pinName, pin) => {
    if (!netTerms.has(net)) netTerms.set(net, []);
    netTerms.get(net).push({ ref, pinName, pin });
  };
  const X0 = 120, Y0 = 100;
  for (const n of layout.children) {
    const x = X0 + n.x, y = Y0 + n.y;
    if (junctionNodes.includes(n.id)) {
      elkJunctionPos.set(n.id, { x, y });
      continue;
    }
    const c = comps.find((k) => k.ref === n.id);
    const ci = info.get(n.id);
    addVertex(model, { id: n.id, shape: ci.shapeKey, x, y, w: n.width, h: n.height, rotation: 0, value: c.value || '' });
    placed.set(n.id, { id: n.id, x, y, w: n.width, h: n.height, rotation: 0 });
    for (let i = 0; i < ci.po.length; i++) term(c.nodes[i], n.id, ci.po[i], getPin(ci.shapeKey, ci.po[i]));
  }
  // wireNets pose rails/ports/jonctions ; P.junctionHint transmet les positions ELK
  const wires = wireNets(model, { comps, info, placed, netTerms, vddNet,
    P: { colW: 190, x0: X0, junctionHint: elkJunctionPos } });
  return { components: comps.map((c) => c.ref), wires, warnings: parsed.warnings || [],
    engine: 'elk', mode: modeUsed, params: {} };
}
