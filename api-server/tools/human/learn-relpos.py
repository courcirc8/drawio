"""learn-relpos.py — how humans place CONNECTED components relative to each
other, learned on the AMSNet human layouts (amsnet-layouts.py, refs linked to
the netlist). For every pair of components sharing a net (rails excluded), the
pin roles on that net (e.g. M:D / M:D, M:G / R:p) and the offset of B's centre
from A's, in units of the drawing's median part size, binned on a 0.5 u grid
in [-6, 6]. Kinds: nmos, pmos, npn, pnp, R, C, L, I, V. Laplace-smoothed
log-probabilities per role pair (pairs with < 20 samples fall back to the
kind-level pair, then to all pairs). Aggregate numbers only.
Out: /AI/datasets/human-layouts/relpos.json (station only)
Usage: python3 tools/human/learn-relpos.py"""
import json, math, re
from collections import defaultdict

B, R = 0.5, 6.0
NB = int(2 * R / B) + 1
RAIL = re.compile(r'^(0|gnd|vdd|vss|vcc|vee|avdd|avss)$', re.I)


def roles(prefix, nodes, kind):
    names = {'M': ['D', 'G', 'S', 'B'], 'Q': ['C', 'B', 'E', 'S']}.get(prefix, ['p', 'n'])
    return {n: names[i] for i, n in reversed(list(enumerate(nodes[:len(names)])))}


def kind_of(prefix, box_kind):
    if prefix == 'M':
        return 'pmos' if 'pmos' in box_kind else 'nmos'
    if prefix == 'Q':
        return 'pnp' if 'pnp' in box_kind else 'npn'
    return prefix


hist = defaultdict(lambda: [0] * (NB * NB))
n_pairs = 0
for line in open('/AI/datasets/human-layouts/amsnet.jsonl'):
    r = json.loads(line)
    if not r['ok']:
        continue
    parts = {p['ref']: p for p in r['parts']}
    comps = []
    for l in open(r['netlist']):
        t = l.split()
        if not t or t[0][0].upper() not in 'MRCLIVQ' or t[0].startswith('.'):
            continue
        ref = t[0].upper(); p = parts.get(ref)
        if p is None:
            continue
        nodes = [x for x in t[1:5] if '=' not in x]
        nodes = nodes[:4] if ref[0] == 'M' else nodes[:3] if ref[0] == 'Q' else nodes[:2]
        comps.append((ref, ref[0], kind_of(ref[0], p['kind']), nodes, p))
    if len(comps) < 2:
        continue
    sizes = sorted(max(c[4]['w'], c[4]['h']) for c in comps)
    u = sizes[len(sizes) // 2] or 1
    for i, a in enumerate(comps):
        ra = roles(a[1], a[3], a[2])
        for b in comps:
            if b is a:
                continue
            rb = roles(b[1], b[3], b[2])
            for net in set(ra) & set(rb):
                if RAIL.match(net):
                    continue
                dx, dy = (b[4]['x'] - a[4]['x']) / u, (b[4]['y'] - a[4]['y']) / u
                ix, iy = round((dx + R) / B), round((dy + R) / B)
                if not (0 <= ix < NB and 0 <= iy < NB):
                    continue
                for key in (f'{a[2]}:{ra[net]}|{b[2]}:{rb[net]}', f'{a[2]}|{b[2]}', '*'):
                    hist[key][iy * NB + ix] += 1
                n_pairs += 1
out = {'bin': B, 'range': R, 'n': NB, 'pairs': n_pairs, 'logp': {}, 'count': {}}
for k, h in hist.items():
    tot = sum(h)
    if tot < 20 and k != '*':
        continue
    out['count'][k] = tot
    out['logp'][k] = [round(math.log((c + 0.5) / (tot + 0.5 * len(h))), 3) for c in h]
json.dump(out, open('/AI/datasets/human-layouts/relpos.json', 'w'))
top = sorted(out['count'].items(), key=lambda x: -x[1])[:12]
print(n_pairs, 'connected pairs;', len(out['logp']), 'role pairs kept; top:', top)
# sanity: where does a PMOS drain sit relative to an NMOS drain on the same net?
k = 'nmos:D|pmos:D'
if k in out['logp']:
    h = hist[k]; tot = sum(h)
    up = sum(h[iy * NB + ix] for iy in range(NB) for ix in range(NB) if iy * B - R < -0.25) / tot
    print(f'{k}: PMOS above NMOS in {up:.0%} of {tot}')
k = 'nmos:S|nmos:S'
if k in out['logp']:
    h = hist[k]; tot = sum(h)
    row = sum(h[iy * NB + ix] for iy in range(NB) for ix in range(NB) if abs(iy * B - R) < 0.3) / tot
    print(f'{k}: same row in {row:.0%} of {tot}')
