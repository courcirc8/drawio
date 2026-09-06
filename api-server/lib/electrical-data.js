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
    const hidden = (SPICE_MAP[c.prefix]?.dropNodes || []).map(index => {
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
