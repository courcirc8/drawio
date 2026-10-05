"""layout-rules.py — judge v2b: readable layout conventions measured on the DVD
schematics AT EQUAL CONTENT (circuit type x size), instead of a "published vs
ours" classifier (v2 learned circuit mix and scan detection noise, failed the
1645 witness).

For each stratum (caption type, part-count bucket) and each convention feature
(layout-stats.py: col_share, row_share, mos_pair_row, mos_mirror_sym, mos_stack,
vdd_above, gnd_below):
  level    = median on the DVD figures of the stratum (detector gd1 boxes);
  baseline = median of the same feature after shuffling each figure's part
             centres uniformly in its box (what no convention at all gives);
  a rule exists when level - baseline > 0.05 ("published drawings do this").
Rule satisfaction for a drawing = min(1, (value - baseline) / (level - baseline)),
floored at 0: ONE-SIDED, capped at the published level, so a drawing more
regular than the (noisily detected) scans is never penalised. Score = mean
satisfaction over the stratum's rules, weighted by level - baseline.
Strata with < 30 DVD figures fall back to the size bucket alone.

Checks (nothing goes into engine=auto): witness 1645, style invariance, variant
preference. Prints the rules table (numbers only).
Usage: python3 tools/judge/layout-rules.py [--model detector-gd1] [--n 100]"""
import json, os, random, sys
import importlib.util
import numpy as np

HERE = os.path.dirname(__file__)
args = sys.argv
MODEL = args[args.index('--model') + 1] if '--model' in args else 'detector-gd1'
N = int(args[args.index('--n') + 1]) if '--n' in args else 100
sys.argv = [sys.argv[0]]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, path))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


ls = load('ls', 'layout-stats.py')
sys.path.insert(0, HERE)
from train import split_of, PUB_FAM, GEN_FAM   # noqa: E402

ROOT = '/AI/datasets/judge'
RULES = ['col_share', 'row_share', 'mos_pair_row', 'mos_mirror_sym', 'mos_stack', 'vdd_above', 'gnd_below']
IDX = [ls.FEATURES.index(f) for f in RULES]
MOS_RULES = {'mos_pair_row', 'mos_mirror_sym', 'mos_stack'}
rng = random.Random(0)


def size_bucket(n):
    return '3-6' if n <= 6 else '7-12' if n <= 12 else '13-25' if n <= 25 else '26+'


def parts_of(boxes, thr=0.5):
    return [b for b in boxes if b[5] >= thr and b[4] in ls.PART]


def shuffled(boxes):
    """Same parts and rails, centres drawn uniformly in the figure's part box."""
    ps = parts_of(boxes) + [b for b in boxes if b[5] >= 0.5 and b[4] in ('vdd', 'gnd')]
    xs = [(b[0] + b[2]) / 2 for b in ps]; ys = [(b[1] + b[3]) / 2 for b in ps]
    out = []
    for b in ps:
        cx, cy = rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys))
        w, h = (b[2] - b[0]) / 2, (b[3] - b[1]) / 2
        out.append([cx - w, cy - h, cx + w, cy + h, b[4], b[5]])
    return out


pub_type = {json.loads(l)['n']: json.loads(l).get('type') for l in open(f'{ROOT}/pub-raw/index.jsonl')}
feat, base, strata = [], [], []
for r in map(json.loads, open(f'{ROOT}/dvd-detections-{MODEL}.jsonl')):
    if split_of('pub:' + r['key'].split('|')[0]) == 'test':
        continue
    f = ls.features(r['boxes'])
    if f is None:
        continue
    fb = ls.features(shuffled(r['boxes']))
    if fb is None:
        continue
    n_mos = sum(1 for b in parts_of(r['boxes']) if ls.PART[b[4]] == 'MOS')
    feat.append(f); base.append(fb)
    strata.append((PUB_FAM.get(pub_type.get(r['n']), 'other'), size_bucket(len(parts_of(r['boxes']))), n_mos >= 2))
feat, base = np.array(feat), np.array(base)


def rules_for(fam, size):
    sel = [i for i, s in enumerate(strata) if s[0] == fam and s[1] == size]
    where = f'{fam}/{size}'
    if len(sel) < 30:
        sel = [i for i, s in enumerate(strata) if s[1] == size]; where = f'*/{size}'
    out = {}
    for name, j in zip(RULES, IDX):
        rows = [i for i in sel if strata[i][2]] if name in MOS_RULES else sel
        if name in ('vdd_above', 'gnd_below'):
            rows = [i for i in rows if feat[i, j] != 0.5]   # 0.5 = no rail detected
        if len(rows) < 15:
            continue
        lv, bl = float(np.median(feat[rows, j])), float(np.median(base[rows, j]))
        if lv - bl > 0.05:
            out[name] = (lv, bl)
    return out, where, len(sel)


def score(boxes, fam):
    f = ls.features(boxes)
    if f is None:
        return None, {}
    n_mos = sum(1 for b in parts_of(boxes) if ls.PART[b[4]] == 'MOS')
    rules, _, _ = rules_for(fam, size_bucket(len(parts_of(boxes))))
    sat, w = {}, {}
    for name, (lv, bl) in rules.items():
        v = f[ls.FEATURES.index(name)]
        if name in MOS_RULES and n_mos < 2:
            continue
        if name in ('vdd_above', 'gnd_below') and v == 0.5:
            continue
        sat[name] = max(0.0, min(1.0, (v - bl) / (lv - bl))); w[name] = lv - bl
    if not sat:
        return None, {}
    return sum(sat[k] * w[k] for k in sat) / sum(w.values()), sat


print(f'DVD figures used (train+val papers): {len(feat)}')
print('rules per stratum (feature: published level / no-convention baseline):')
for fam in sorted({s[0] for s in strata}):
    for size in ('3-6', '7-12', '13-25', '26+'):
        rules, where, n = rules_for(fam, size)
        if where.startswith(fam):
            print(f'  {where:22s} n={n:5d}  ' + '  '.join(f'{k} {lv:.2f}/{bl:.2f}' for k, (lv, bl) in rules.items()))
for size in ('3-6', '7-12', '13-25', '26+'):
    rules, where, n = rules_for('__none__', size)
    print(f'  {where:22s} n={n:5d}  ' + '  '.join(f'{k} {lv:.2f}/{bl:.2f}' for k, (lv, bl) in rules.items()))

if '--export' in args:   # size-only strata (auto does not know the circuit family): numbers only, safe for git
    out = {size: {k: [round(lv, 3), round(bl, 3)] for k, (lv, bl) in rules_for('__none__', size)[0].items()}
           for size in ('3-6', '7-12', '13-25', '26+')}
    json.dump({'source': f'DVD 2001/2008 schematics, train+val papers, {MODEL} boxes, n={len(feat)}', 'rules': out},
              open(os.path.join(HERE, '../../data/layout-rules.json'), 'w'), indent=1)
    print('exported data/layout-rules.json'); sys.exit(0)

# checks on our drawings (detector gd1 run on the renders)
st = load('st', 'self-train.py')
import torch                                     # noqa: E402
import torchvision.transforms.functional as TF   # noqa: E402
from PIL import Image, ImageFilter               # noqa: E402
det = st.new_model(); det.load_state_dict(torch.load(f'{ROOT}/models/{MODEL}.pt', map_location='cpu', weights_only=True))
det.transform.min_size, det.transform.max_size = (1200,), 2000
det.to(st.dev).eval()


def detect_im(im):
    im = im.convert('RGB'); W0, H0 = im.size
    s = min(1.0, 2400 / max(W0, H0))
    if s < 1:
        im = im.resize((int(W0 * s), int(H0 * s)), Image.LANCZOS)
    with torch.no_grad():
        o = det([TF.to_tensor(im).to(st.dev)])[0]
    return [[*(v / s for v in b.tolist()), st.C[int(c)], float(sc)] for b, c, sc in
            zip(o['boxes'].cpu(), o['labels'].cpu(), o['scores'].cpu()) if sc >= 0.3]


wit = {k: f'/tmp/claude-1000/motif-diag/ref/1645-{k}.png' for k in ('v2b', 'now')}
if all(os.path.exists(p) for p in wit.values()):
    res = {k: score(detect_im(Image.open(p)), 'reference') for k, p in wit.items()}
    print('witness bandgap 1645 (family reference):')
    for k, (s, sat) in res.items():
        print(f'   {k:4s} score {s if s is None else round(s, 3)}  ' + '  '.join(f'{a} {b:.2f}' for a, b in sat.items()))
    ok = res['v2b'][0] is not None and res['now'][0] is not None and res['v2b'][0] > res['now'][0]
    print('   ->', 'PASS' if ok else 'FAIL')

gen = {}
for r in map(json.loads, open(f'{ROOT}/gen-detections-{MODEL}.jsonl')):
    cid, variant, family = r['key'].split('|')
    fam = GEN_FAM.get(family, family)
    s, _ = score(r['boxes'], fam if fam in set(PUB_FAM.values()) else 'other')
    if s is not None:
        gen.setdefault(cid, {})[variant] = s
win = {'v2b': 0, 'auto': 0, 'tie': 0}
for cid, v in gen.items():
    if len(v) == 2:
        d = v['v2b'] - v['auto']
        win['tie' if abs(d) < 0.02 else 'v2b' if d > 0 else 'auto'] += 1
print('variant preference (circuits with both, |Δ| < 0.02 = tie):', win)

file_of = {}
for f in os.listdir(f'{ROOT}/gen-raw'):
    if f.startswith('index-'):
        for r in map(json.loads, open(f'{ROOT}/gen-raw/{f}')):
            file_of[f"{r['id']}|{r['variant']}"] = (r['file'], r.get('family'))
keys = [k for k in file_of if split_of('gen:' + k.split('|')[0]) == 'test']
random.Random(1).shuffle(keys)
dl = {}
for k in keys[:N]:
    fn, family = file_of[k]
    fam = GEN_FAM.get(family, family); fam = fam if fam in set(PUB_FAM.values()) else 'other'
    raw = Image.open(f'{ROOT}/gen-raw/{fn}')
    s0, _ = score(detect_im(raw), fam)
    if s0 is None:
        continue
    w, h = raw.size
    a = np.asarray(raw.convert('L'), dtype=np.float32)
    for name, im in {'scale0.6': raw.resize((max(1, int(w * .6)), max(1, int(h * .6))), Image.LANCZOS),
                     'thick': raw.convert('L').filter(ImageFilter.MinFilter(3)),
                     'scan': Image.fromarray(np.clip(a + np.random.default_rng(0).normal(0, 25, a.shape), 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))}.items():
        s1, _ = score(detect_im(im), fam)
        if s1 is not None:
            dl.setdefault(name, []).append(abs(s1 - s0))
print(f'style invariance on {N} of our test drawings, mean |Δscore| (share > 0.1):')
for k, v in dl.items():
    v = np.array(v); print(f'   {k:9s} {v.mean():.3f} ({(v > 0.1).mean():.0%})')
