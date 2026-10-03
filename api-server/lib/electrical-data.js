import { allCells, cellInfo } from './model.js';
import { identityOf, SPICE_MAP } from './components.js';

/** Persist hidden SPICE terminals; never copy the visible netlist back on extraction. */
export function preserveElectricalData(model, parsed) {
  const cells = new Map(allCells(model).map(n => [String(identityOf(cellInfo(n))).toUpperCase(), n]));
  for (const c of parsed.components) {
    let node = cells.get(c.ref.toUpperCase());
    if (!node) continue;
    node.setAttribute('refdes', c.ref);
    node.setAttribute('spice_value', c.value || '');
    // declared hidden terminals (MOS bulk) + OPTIONAL ones present in this
    // netlist (BJT substrate "Q c b e s model"): every fullNodes index that
    // the visible pins do not carry
    const declared = SPICE_MAP[c.prefix]?.dropNodes || [];
    const optional = !declared.length && (c.fullNodes?.length || 0) > c.nodes.length
      ? Array.from({ length: c.fullNodes.length - c.nodes.length }, (_, k) => c.nodes.length + k) : [];
    const hidden = [...declared, ...optional].map(index => {
      const net = c.fullNodes?.[index];
      if (!net) return {index};
      // Bind omitted terminals to a visible pin, so later GUI rewires are observed.
      for (const target of parsed.components) {
        const pin = target.nodes.findIndex(n => n === net);
        if (pin >= 0) return {index, anchor:{ref:target.ref, pin}};
      }
      return {index, net}; // explicitly named, hidden-only global net
    });
    if (hidden.length) node.setAttribute('spice_hidden_nodes', JSON.stringify(hidden));
  }
}
