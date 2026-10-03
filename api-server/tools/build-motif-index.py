#!/usr/bin/env python3
"""build-motif-index.py — compact retrieval index of the IEEE schematic readings.

Reads the vision readings of the IEEE archive (figures.sqlite, ai-station only)
and writes, OUTSIDE the repository, one record per readable schematic with
identifiers and labels only: paper id, page, rank, circuit type, motif counts,
layout labels. No caption, no text, no netlist: nothing of the corpus content.
lib/recognize-llm.js uses it to find published schematics with the same motifs.

Usage: python3 tools/build-motif-index.py [--db PATH] [--out PATH]
Defaults: /AI/datasets/IEEE/derived/figures.sqlite -> /AI/datasets/IEEE/derived/motif-index.json
"""
import argparse, collections, json, sqlite3

ap = argparse.ArgumentParser()
ap.add_argument('--db', default='/AI/datasets/IEEE/derived/figures.sqlite')
ap.add_argument('--out', default='/AI/datasets/IEEE/derived/motif-index.json')
a = ap.parse_args()
db = sqlite3.connect(f'file:{a.db}?mode=ro', uri=True)
recs = []
for pid, page, rang, typ, lecture in db.execute(
        "select paper_id, page, rang, type, lecture from lectures where erreur is null and lecture is not null"):
    try:
        j = json.loads(lecture)
    except ValueError:
        continue
    if not j.get('readable'):
        continue
    motifs = collections.Counter(m for m in (j.get('motifs') or []) if isinstance(m, str))
    lay = j.get('layout') or {}
    recs.append({'id': pid, 'page': page, 'rang': rang, 'type': typ if typ and typ != 'sans type' else None,
                 'motifs': dict(motifs),
                 'layout': {k: lay.get(k) for k in ('signal_flow', 'supply_position', 'symmetric', 'stages')}})
with open(a.out, 'w') as f:
    json.dump({'source': 'IEEE SSCS archive vision readings (identifiers and labels only)', 'records': recs}, f)
print(f'{len(recs)} records -> {a.out}')
