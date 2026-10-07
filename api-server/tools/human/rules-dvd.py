"""rules-dvd.py — Eric's three rules measured on the published DVD schematics,
structure by structure (lists: /AI/datasets/IEEE/derived/figures-par-structure.jsonl
from the RAG session; boxes: detector gd1, dvd-detections-detector-gd1.jsonl).
No netlist here, so the rules are read from geometry (approximations):
  R1  MOS with a ground symbol right below (|dx| < 1 u, 0 < dy < 3 u) = source on
      ground; all such MOS of a figure on one row (centres within 0.3 u)
  R2  MOS with a supply symbol right above = source on VDD; all on one row
  R3  (proxy) parts with a part directly above or below within 2.5 u whose
      centre or side lines up (|dx| < 0.3 u, or left/right edges within 0.3 u):
      share of parts that sit in such a column
Chance: the same parts at uniform random positions in the figure's part box.
Prints numbers only; nothing leaves the station.
Usage: python3 tools/human/rules-dvd.py [--min-conf 0.7]"""
import json, random, sys
from collections import defaultdict

random.seed(0)
MINC = float(sys.argv[sys.argv.index('--min-conf') + 1]) if '--min-conf' in sys.argv else 0.7
PART = {'nmos', 'pmos', 'resistor', 'capacitor', 'current', 'voltage'}
det = {}
for l in open('/AI/datasets/judge/dvd-detections-detector-gd1.jsonl'):
    r = json.loads(l); det[r['key']] = [b for b in r['boxes'] if b[5] >= 0.5]


def measures(boxes):
    parts = [dict(x=(b[0] + b[2]) / 2, y=(b[1] + b[3]) / 2, x0=b[0], x1=b[2], k=b[4], h=b[3] - b[1], w=b[2] - b[0]) for b in boxes if b[4] in PART]
    if len(parts) < 3:
        return None
    u = sorted(max(p['w'], p['h']) for p in parts)[len(parts) // 2] or 1
    gnd = [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for b in boxes if b[4] == 'gnd']
    vdd = [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2) for b in boxes if b[4] == 'vdd']
    mos = [p for p in parts if p['k'] in ('nmos', 'pmos')]
    # a MOS's leads are on one side of its box: accept the rail symbol under/over either side
    near = lambda p, pts, below: any(min(abs(x - p['x0']), abs(x - p['x1']), abs(x - p['x'])) < 0.6 * u and (0 < (y - p['y']) * (1 if below else -1) < 3 * u) for x, y in pts)
    out = {}
    for key, pts, below in (('R1', gnd, True), ('R2', vdd, False)):
        g = [p for p in mos if near(p, pts, below)]
        if len(g) >= 2:
            out[key] = (g, all(abs(a['y'] - b['y']) < 0.3 * u for i, a in enumerate(g) for b in g[i + 1:]))
    col = 0
    for p in parts:
        for q in parts:
            if q is p or not (0 < abs(q['y'] - p['y']) < 2.5 * u):
                continue
            if abs(q['x'] - p['x']) < 0.3 * u or min(abs(q['x0'] - p['x0']), abs(q['x1'] - p['x1']), abs(q['x0'] - p['x1']), abs(q['x1'] - p['x0'])) < 0.3 * u:
                col += 1; break
    out['R3'] = col / len(parts)
    return out, parts, boxes


def shuffled(boxes):
    ps = [b for b in boxes if b[4] in PART]
    xs = [(b[0] + b[2]) / 2 for b in ps]; ys = [(b[1] + b[3]) / 2 for b in ps]
    # uniform positions in the figure's part box (a shuffle would keep the same x set, i.e. the columns)
    pos = [(random.uniform(min(xs), max(xs)), random.uniform(min(ys), max(ys))) for _ in ps]
    out = [b for b in boxes if b[4] not in PART]
    for b, (x, y) in zip(ps, pos):
        w, h = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
        out.append([x - w, y - h, x + w, y + h, b[4], b[5]])
    return out


by = defaultdict(list)
for l in open('/AI/datasets/IEEE/derived/figures-par-structure.jsonl'):
    r = json.loads(l)
    if r.get('confiance', 0) >= MINC and r['key'] in det:
        by[r['structure']].append(r['key'])
by['(toutes)'] = sorted(det)
print(f'structure          n   R1 rangée src-masse      R2 rangée src-VDD        R3 part en colonne')
for st in sorted(by, key=lambda s: -len(by[s])):
    acc = {'R1': [0, 0, 0], 'R2': [0, 0, 0], 'R3': [0.0, 0.0, 0]}
    for k in by[st]:
        m = measures(det[k])
        if m is None:
            continue
        mr = measures(shuffled(det[k]))
        for rule in ('R1', 'R2'):
            if rule in m[0]:
                acc[rule][2] += 1; acc[rule][0] += m[0][rule][1]
                acc[rule][1] += (mr is not None and rule in mr[0] and mr[0][rule][1])
        acc['R3'][2] += 1; acc['R3'][0] += m[0]['R3']; acc['R3'][1] += mr[0]['R3'] if mr else 0
    f = lambda a: f"{a[0] / a[2]:4.0%} (hasard {a[1] / a[2]:3.0%}, n={a[2]:4d})" if a[2] else '        -              '
    print(f'{st:15s} {len(by[st]):5d}   {f(acc["R1"])}   {f(acc["R2"])}   {f(acc["R3"])}')
