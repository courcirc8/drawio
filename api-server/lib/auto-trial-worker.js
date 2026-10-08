/**
 * auto-trial-worker.js — one candidate of engine=auto in its own thread
 * (lib/auto.js, AUTO_THREADS). The candidates were promises on ONE JS thread:
 * a 150-part converter took 100-1 200 s and, under the 60 s budget, only the
 * fast and poor v2 had finished. Here each candidate gets a core; the drawing
 * comes back as XML, and a candidate past the budget is terminated.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { trial } from './auto.js';
import { serialize } from './model.js';

const { parsed, eng, restMode, sp, extra } = workerData;
const t = await trial(parsed, eng, restMode, sp, extra);
const { doc, ...rest } = t;
let placed = rest.placed;
try { placed = structuredClone(placed); } catch { placed = placed == null ? placed : JSON.parse(JSON.stringify(placed)); }
parentPort.postMessage({ ...rest, placed, xml: doc ? serialize(doc) : null });
