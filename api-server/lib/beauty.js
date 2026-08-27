/**
 * beauty.js — bridge to tools/beauty.py (XML geometry + OpenCV visual metrics).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './model.js';
import { exportDocument } from './render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../tools/beauty.py');

export async function scoreDocument(doc, model, { reference } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beauty-'));
  try {
    const xmlPath = path.join(tmp, 'doc.xml');
    const pngPath = path.join(tmp, 'doc.png');
    fs.writeFileSync(xmlPath, serialize(doc));
    const { buffer } = await exportDocument(doc, model, { format: 'png', scale: 2 });
    fs.writeFileSync(pngPath, buffer);
    const args = [SCRIPT, xmlPath, pngPath];
    if (reference != null) args.push(path.resolve(reference));
    const out = await new Promise((resolve, reject) => {
      const p = spawn('python3', args);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => stdout += d);
      p.stderr.on('data', (d) => stderr += d);
      p.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error('beauty.py: ' + stderr.slice(0, 400))));
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
