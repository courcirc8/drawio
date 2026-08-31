/**
 * route-worker.js — exécute AvoidRouting.computeRoutes dans un worker isolé.
 * Un solve libavoid pathologique (boucle/abandon Emscripten) ne peut pas être
 * interrompu en thread principal : le worker, lui, se tue et se relance.
 */
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(HERE, '../../src/main/webapp/js/libavoid-js');
vm.runInThisContext(fs.readFileSync(path.join(LIB_DIR, 'libavoid.min.js'), 'utf8'), { filename: 'libavoid.min.js' });
vm.runInThisContext(fs.readFileSync(path.join(LIB_DIR, 'libavoid-routing.js'), 'utf8'), { filename: 'libavoid-routing.js' });

const ready = Promise.resolve(globalThis.__libavoidReady);
parentPort.on('message', async (msg) => {
  await ready;
  try {
    const routes = globalThis.AvoidRouting.computeRoutes(globalThis.Avoid, msg.vertices, msg.edges, msg.opts || {});
    parentPort.postMessage({ id: msg.id, routes });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: String(e).slice(0, 300) });
  }
});
