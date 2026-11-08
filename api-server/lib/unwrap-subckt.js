/**
 * unwrap-subckt.js — a deck that is ONE .subckt and nothing else (layout3d's cells, MLOAD 08.11) drawn on the
 * flat route as that cell: its body is the netlist, its pins are the ports (parsed.pins, as lib/hier.js gives a
 * .subckt page). A deck with top-level devices, instances or several definitions is left to --hier.
 */
import { parseSpice } from './netlist.js';

export function unwrapSingleSubckt(parsed) {
  const defs = Object.values(parsed.subckts || {});
  if (parsed.components.length || (parsed.instances || []).length || defs.length !== 1 || defs[0].macro) return parsed;
  const d = defs[0], body = parseSpice(d.lines.join('\n') + '\n.end');
  if (!body.components.length || Object.keys(body.subckts || {}).length) return parsed;
  return { ...body, title: parsed.title, pins: d.pins, cell: d.name, warnings: [...(parsed.warnings || []), ...(body.warnings || [])] };
}
