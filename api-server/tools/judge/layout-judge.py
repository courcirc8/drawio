"""layout-judge.py — judge v2: "does this layout look like a published one?" from
the box-only layout features of layout-stats.py (no pixel, so style cannot be a
cue by construction). Logistic regression (interpretable) on DVD vs ours, families
balanced within each class as in judge v1; n_log is left out (a property of the
circuit, not of its layout). Splits as judge v1 (by paper / by circuit id).

Checks printed (nothing is plugged into engine=auto by this script):
  1. separation on the test split (AUC) and the weight of each feature;
  2. style invariance: our test drawings re-rendered smaller, larger, thicker and
     scan-like, re-detected, re-scored: |Δscore|;
  3. witness bandgap analoggenie/1645: v2+branches must beat the auto scatter;
  4. variants of the same circuit: which variant the judge prefers.
--reliable keeps only the DVD figures whose detected MOS/R/C counts equal BOTH Ornith
readings (reliable-dvd-keys.json): detector noise on scans made messy layouts look
"published" (first gd1 run failed the 1645 witness).
Usage: python3 tools/judge/layout-judge.py [--model detector-sb3] [--n 200] [--gpu 1] [--reliable]
Writes /AI/datasets/judge/models/layout-judge-v2.json (weights, mean, std)."""
import json, os, random, sys
import importlib.util
import numpy as np

HERE = os.path.dirname(__file__)
args = sys.argv
MODEL = args[args.index('--model') + 1] if '--model' in args else 'detector-sb3'
N = int(args[args.index('--n') + 1]) if '--n' in args else 200
RELIABLE = set(json.load(open('/AI/datasets/judge/reliable-dvd-keys.json'))) if '--reliable' in args else None


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, path))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


sys.argv = [sys.argv[0]] + (['--gpu', args[args.index('--gpu') + 1]] if '--gpu' in args else [])
ls = load('ls', 'layout-stats.py')
sys.path.insert(0, HERE)
from train import split_of, PUB_FAM, GEN_FAM   # noqa: E402
import torch                                    # noqa: E402

ROOT = '/AI/datasets/judge'
USE = [i for i, f in enumerate(ls.FEATURES) if f != 'n_log']
pub_type = {json.loads(l)['n']: json.loads(l).get('type') for l in open(f'{ROOT}/pub-raw/index.jsonl')}
known = set(PUB_FAM.values())
X, y, sp, fam, keys = [], [], [], [], []
for side, lab in (('dvd', 1), ('gen', 0)):
    for l in open(f'{ROOT}/layout-{side}.jsonl'):
        r = json.loads(l)
        if lab and RELIABLE is not None and r['key'] not in RELIABLE:
            continue
        if lab:
            s = split_of('pub:' + r['key'].split('|')[0]); fm = PUB_FAM.get(pub_type.get(r['n']), 'other')
        else:
            cid, variant, family = r['key'].split('|')
            s = split_of('gen:' + cid); fm = GEN_FAM.get(family, family); fm = fm if fm in known else 'other'
        X.append([r['f'][i] for i in USE]); y.append(lab); sp.append(s); fam.append(fm); keys.append(r['key'])
X, y, sp = np.array(X, dtype=np.float32), np.array(y), np.array(sp)
tr = sp == 'train'
mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-6
Z = (X - mu) / sd
cnt = {}
for i in np.where(tr)[0]:
    cnt[(y[i], fam[i])] = cnt.get((y[i], fam[i]), 0) + 1
w = np.array([1.0 / cnt[(y[i], fam[i])] if tr[i] else 0 for i in range(len(y))], dtype=np.float32)
w[tr] *= tr.sum() / w[tr].sum()
lin = torch.nn.Linear(Z.shape[1], 1)
opt = torch.optim.LBFGS(lin.parameters(), max_iter=500)
Zt, yt, wt = torch.tensor(Z[tr]), torch.tensor(y[tr], dtype=torch.float32), torch.tensor(w[tr])


def closure():
    opt.zero_grad()
    loss = (torch.nn.functional.binary_cross_entropy_with_logits(lin(Zt).squeeze(1), yt, reduction='none') * wt).mean() \
        + 1e-3 * (lin.weight ** 2).sum()
    loss.backward(); return loss


opt.step(closure)
W, B = lin.weight.detach().numpy()[0], float(lin.bias.detach())


def score_f(f):
    z = (np.array([f[i] for i in USE], dtype=np.float32) - mu) / sd
    return float(1 / (1 + np.exp(-(z @ W + B))))


def auc(p, t):
    pos, neg = p[t == 1], p[t == 0]
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


P = 1 / (1 + np.exp(-(Z @ W + B)))
te = sp == 'test'
print(f'counts: DVD {int((y == 1).sum())}, ours {int((y == 0).sum())}; test AUC {auc(P[te], y[te]):.3f}')
print('1. feature weights (standardised; + = looks published):')
for k in np.argsort(-np.abs(W)):
    f = ls.FEATURES[USE[k]]
    print(f'   {f:15s} {W[k]:+.2f}   mean DVD {X[y == 1, k].mean():.2f}  ours {X[y == 0, k].mean():.2f}')
os.makedirs(f'{ROOT}/models', exist_ok=True)
json.dump({'features': [ls.FEATURES[i] for i in USE], 'w': W.tolist(), 'b': B, 'mu': mu.tolist(), 'sd': sd.tolist(),
           'detector': MODEL}, open(f'{ROOT}/models/layout-judge-v2.json', 'w'))

# 2-3 need the detector on new renders
st = load('st', 'self-train.py')
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


def variants(raw):
    w, h = raw.size
    out = {'scale0.6': raw.resize((max(1, int(w * 0.6)), max(1, int(h * 0.6))), Image.LANCZOS),
           'scale1.6': raw.resize((int(w * 1.6), int(h * 1.6)), Image.LANCZOS),
           'thick': raw.convert('L').filter(ImageFilter.MinFilter(3))}
    a = np.asarray(raw.convert('L'), dtype=np.float32)
    out['scan'] = Image.fromarray(np.clip(a + np.random.default_rng(0).normal(0, 25, a.shape), 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    return out


random.seed(1)
test_gen = [keys[i] for i in range(len(y)) if y[i] == 0 and te[i]]
file_of = {}
for f in os.listdir(f'{ROOT}/gen-raw'):
    if f.startswith('index-'):
        for r in map(json.loads, open(f'{ROOT}/gen-raw/{f}')):
            file_of[f"{r['id']}|{r['variant']}|{r.get('family')}"] = r['file']
random.shuffle(test_gen)
dlt, lost = {}, {}
for k in test_gen[:N]:
    raw = Image.open(f'{ROOT}/gen-raw/{file_of[k]}')
    f0 = ls.features(detect_im(raw))
    if f0 is None:
        continue
    s0 = score_f(f0)
    for name, im in variants(raw).items():
        f1 = ls.features(detect_im(im))
        if f1 is None:
            lost[name] = lost.get(name, 0) + 1; continue
        dlt.setdefault(name, []).append(abs(score_f(f1) - s0))
print(f'2. style invariance on {N} of our test drawings, mean |Δscore| (share > 0.1) [figures losing all parts]:')
for k, v in dlt.items():
    v = np.array(v); print(f'   {k:9s} {v.mean():.3f} ({(v > 0.1).mean():.0%}) [{lost.get(k, 0)}]')
wit = {k: f'/tmp/claude-1000/motif-diag/ref/1645-{k}.png' for k in ('v2b', 'now')}
if all(os.path.exists(p) for p in wit.values()):
    s = {}
    for k, p in wit.items():
        f = ls.features(detect_im(Image.open(p)))
        s[k] = score_f(f) if f else float('nan')
    print(f'3. witness bandgap 1645: v2+branches {s["v2b"]:.3f} vs auto scatter {s["now"]:.3f} -> {"PASS" if s["v2b"] > s["now"] else "FAIL"}')
by = {}
for i in range(len(y)):
    if y[i] == 0:
        cid, variant, _ = keys[i].split('|'); by.setdefault(cid, []).append((P[i], variant))
win = {}
for cid, v in by.items():
    if len(v) > 1:
        b = max(v)[1]; win[b] = win.get(b, 0) + 1
print('4. preferred variant per circuit (circuits with >1 variant):', dict(sorted(win.items(), key=lambda x: -x[1])))
