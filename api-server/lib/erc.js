/**
 * erc.js — electrical rule checks on a page.
 */
import { connectivity } from './netlist.js';
import { activePins } from './components.js';

export function check(model) {
  const conn = connectivity(model);
  const findings = [...conn.issues.map((i) => ({ severity: 'warning', ...i }))];

  // unconnected pins
  for (const { cell, cls } of conn.components) {
    for (const pin of activePins(cls)) {
      const key = cell.id + ':' + pin.name;
      if (!conn.netOf.has(key) || conn.nets.get(conn.netOf.get(key)) == null ||
          conn.nets.get(conn.netOf.get(key)).length < 2 && conn.netOf.get(key) !== '0') {
        findings.push({ severity: 'error', code: 'unconnected-pin',
          message: `pin ${pin.name} of ${cell.id} is not connected`, cells: [cell.id] });
      }
    }
  }
  // grounds without connection: no wire references the ground cell at all
  for (const { cell } of conn.grounds) {
    if (!conn.wiredCells.has(cell.id)) {
      findings.push({ severity: 'warning', code: 'floating-ground',
        message: `ground symbol ${cell.id} is not connected`, cells: [cell.id] });
    }
  }
  // single-terminal nets
  for (const [name, terms] of conn.nets) {
    if (name !== '0' && terms.length === 1) {
      findings.push({ severity: 'error', code: 'single-terminal-net',
        message: `net ${name} has a single terminal (${terms[0]})`, cells: terms.map((t) => t.split(':')[0]) });
    }
  }
  return { findings, errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length };
}
