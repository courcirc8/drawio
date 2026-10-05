"""audit-compare.py — compare component counts against an audited control set
(Opus auditors, /AI/datasets/judge/audit/opus-*.json; numbers only, no image):
the two Ornith readings (lectures, boites-ornith) and detector versions.
Metric per kind: exact count share and mean |diff| over the audited figures;
'mos' = nmos + pmos + polarity-unknown (polarity is often undecidable on scans).
Usage: python3 tools/judge/audit-compare.py [--models detector-v2,detector-st3,detector-sb3] [--size 1200]"""
import glob, json, sqlite3, sys
import importlib.util, os
args = sys.argv
MODELS = (args[args.index('--models') + 1] if '--models' in args else 'detector-v2,detector-st3,detector-sb3').split(',')
SIZE = int(args[args.index('--size') + 1]) if '--size' in args else 1200
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location('st', os.path.join(os.path.dirname(__file__), 'self-train.py'))
st = importlib.util.module_from_spec(spec); spec.loader.exec_module(st)
import torch

truth = {r['n']: r for f in sorted(glob.glob('/AI/datasets/judge/audit/opus-*.json')) for r in json.load(open(f))}
key = {json.loads(l)['n']: json.loads(l)['key'] for l in open('/AI/datasets/judge/pub-raw/index.jsonl')}
db = sqlite3.connect('file:/AI/datasets/IEEE/derived/figures.sqlite?mode=ro', uri=True)
boites = {}
for l in open('/AI/datasets/IEEE/derived/boites-ornith.jsonl'):
    b = json.loads(l); boites[f"{b['paper_id']}|{b['page']}|{b['rang']}"] = b['components']
KINDS = ('nmos', 'pmos', 'R', 'C')


def cnt(comps, name):
    c = {k: sum(1 for x in comps if x and x.get('kind') == k) for k in KINDS}
    c['mos'] = c['nmos'] + c['pmos']
    return c


preds = {'ornith-1': {}, 'ornith-2': {}}
for n in truth:
    pid, page, rang = key[n].split('|')
    row = db.execute('SELECT lecture FROM lectures WHERE paper_id=? AND page=? AND rang=?', (pid, int(page), int(rang))).fetchone()
    preds['ornith-1'][n] = cnt(json.loads(row[0]).get('components') or [], 'o1')
    preds['ornith-2'][n] = cnt(boites.get(key[n], []), 'o2')
figs = [{'n': n} for n in truth]
for tag in MODELS:
    m = st.new_model(); m.load_state_dict(torch.load(f'/AI/datasets/judge/models/{tag}.pt', map_location='cpu', weights_only=True)); m.to(st.dev)
    m.transform.min_size, m.transform.max_size = (SIZE,), max(1333, SIZE * 5 // 3); st.MAXSIDE = SIZE * 2
    d = st.detect(m, figs)
    M = {'nmos': 'nmos', 'pmos': 'pmos', 'R': 'resistor', 'C': 'capacitor'}
    preds[tag] = {}
    for n in truth:
        c = {k: sum(1 for _, cl, s in d[n] if cl == M[k] and s >= 0.5) for k in KINDS}
        c['mos'] = c['nmos'] + c['pmos']; preds[tag][n] = c
print(f'{len(truth)} audited figures; per kind: exact share, mean |diff|  (truth mos includes polarity-unknown)')
for name, p in preds.items():
    row = []
    for k in KINDS + ('mos',):
        ex, err = 0, 0
        for n, t in truth.items():
            tv = t['nmos'] + t['pmos'] + t['mos_unknown'] if k == 'mos' else t[k]
            ex += p[n][k] == tv; err += abs(p[n][k] - tv)
        row.append(f'{k} {ex / len(truth):.2f}/{err / len(truth):.1f}')
    print(f'  {name:14s} ' + '  '.join(row))
