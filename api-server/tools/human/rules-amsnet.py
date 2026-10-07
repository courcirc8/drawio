"""rules-amsnet.py — how often HUMAN drawings follow Eric's three rules, measured
exactly on the AMSNet textbook layouts (amsnet.jsonl: positions linked to the
netlist), against chance (each drawing's positions shuffled among its parts).
  R1  transistors with source (emitter) on ground share one row
  R2  transistors with source (emitter) on the supply share one row
  R3  parts carrying the same DC current (a DC branch: drain-source, collector-
      emitter, R, L, I, cut at rails and at nets with 3+ DC terminals) share a column
"Share a row / column": centres within 0.3 u (u = median part size).
Per drawing: the share of qualifying pairs that comply; reported as the share of
drawings where ALL pairs comply, and the mean pair compliance. Numbers only.
Usage: python3 tools/human/rules-amsnet.py"""
import json, random, re
from collections import defaultdict

GND = re.compile(r'^(0|gnd|vss|vee|avss|dvss|agnd|dgnd)$', re.I)
SUP = re.compile(r'^(vdd|vcc|avdd|dvdd|vpwr)$', re.I)
random.seed(0)


def comps_of(r):
    parts = {p['ref']: p for p in r['parts']}
    out = []
    for l in open(r['netlist']):
        t = l.split()
        if not t or t[0][0].upper() not in 'MRCLIVQ' or t[0].startswith('.'):
            continue
        ref = t[0].upper(); p = parts.get(ref)
        if p is None:
            continue
        nodes = [x for x in t[1:5] if '=' not in x]
        # the DC line of a transistor is its drain-source lead, on one side of the
        # symbol (right when unmirrored at 0 deg, left when mirrored), not its centre
        lx = p['x']
        if ref[0] in 'MQ' and p['angle'] in (0, 180):
            side = 1 if (p['angle'] == 0) != p['mirror'] else -1
            lx = p['x'] + side * p['w'] / 2
        out.append({'ref': ref, 'pre': ref[0], 'nodes': nodes, 'x': lx, 'cx': p['x'], 'y': p['y'], 's': max(p['w'], p['h'])})
    return out


def dc(c):
    if c['pre'] in 'MQ':
        return [c['nodes'][0], c['nodes'][2]] if len(c['nodes']) >= 3 else []
    return c['nodes'][:2] if c['pre'] in 'RLI' else []


def groups(cs):
    g1 = [i for i, c in enumerate(cs) if c['pre'] in 'MQ' and len(c['nodes']) >= 3 and GND.match(c['nodes'][2])]
    g2 = [i for i, c in enumerate(cs) if c['pre'] in 'MQ' and len(c['nodes']) >= 3 and SUP.match(c['nodes'][2])]
    deg = defaultdict(int)
    for c in cs:
        for n in dc(c):
            deg[n] += 1
    uf = list(range(len(cs)))
    def f(i):
        while uf[i] != i:
            uf[i] = uf[uf[i]]; i = uf[i]
        return i
    last = {}
    for i, c in enumerate(cs):
        for n in dc(c):
            if GND.match(n) or SUP.match(n) or deg[n] != 2:
                continue
            if n in last:
                uf[f(i)] = f(last[n])
            else:
                last[n] = i
    ch = defaultdict(list)
    for i, c in enumerate(cs):
        if dc(c):
            ch[f(i)].append(i)
    return g1, g2, [g for g in ch.values() if len(g) > 1]


def comply(cs, grp, axis, u):
    pairs = [(a, b) for k, a in enumerate(grp) for b in grp[k + 1:]]
    if not pairs:
        return None
    return sum(abs(cs[a][axis] - cs[b][axis]) < 0.3 * u for a, b in pairs) / len(pairs)


res = {k: {'real': [], 'rand': []} for k in ('R1 rangée source-masse', 'R2 rangée source-VDD', 'R3 colonne même courant DC')}
for line in open('/AI/datasets/human-layouts/amsnet.jsonl'):
    r = json.loads(line)
    if not r['ok']:
        continue
    cs = comps_of(r)
    if len(cs) < 3:
        continue
    u = sorted(c['s'] for c in cs)[len(cs) // 2] or 1
    g1, g2, cols = groups(cs)
    sh = [dict(c) for c in cs]
    pos = [(c['x'], c['y']) for c in cs]; random.shuffle(pos)
    for c, (x, y) in zip(sh, pos):
        c['x'], c['y'] = x, y
    for key, grps, axis in (('R1 rangée source-masse', [g1], 'y'), ('R2 rangée source-VDD', [g2], 'y'), ('R3 colonne même courant DC', cols, 'x')):
        for g in grps:
            a, b = comply(cs, g, axis, u), comply(sh, g, axis, u)
            if a is not None:
                res[key]['real'].append(a); res[key]['rand'].append(b)
for k, v in res.items():
    n = len(v['real'])
    if not n:
        continue
    allr = sum(x == 1 for x in v['real']) / n; allh = sum(x == 1 for x in v['rand']) / n
    print(f'{k:28s} groupes {n:4d} : respectée entièrement dans {allr:.0%} des dessins humains (hasard {allh:.0%}) ; paires conformes {sum(v["real"]) / n:.0%} (hasard {sum(v["rand"]) / n:.0%})')
