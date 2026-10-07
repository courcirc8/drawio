"""eval.py — the checks the judge must pass before it may be used anywhere
(Eric's conditions; nothing is plugged into engine=auto by this script).

  1. style invariance: the same drawing at another render scale, with thicker
     lines, or with scan-like noise and blur must keep its score (|Δ| small);
  2. text neutrality: the same drawing normalised with its text kept or
     stripped must keep its score;
  3. witness: on the bandgap analoggenie/1645 the textbook branch-column drawing
     (v2+branches) must score above the scatter auto picked;
  4. separation on the held-out test split (published vs generated).
Usage: python3 tools/judge/eval.py [--model /AI/datasets/judge/models/judge-v1.pt] [--gpu 1] [--n 300]
Prints numbers only."""
import glob, json, os, random, sys
import numpy as np
import torch
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(__file__))
from normalize import normalize        # noqa: E402
from train import model, split_of, ROOT  # noqa: E402

args = sys.argv
MODEL = args[args.index('--model') + 1] if '--model' in args else f'{ROOT}/models/judge-v1.pt'
GPU = int(args[args.index('--gpu') + 1]) if '--gpu' in args else 1
N = int(args[args.index('--n') + 1]) if '--n' in args else 300
dev = torch.device(f'cuda:{GPU}' if torch.cuda.is_available() else 'cpu')
m = model(); m.load_state_dict(torch.load(MODEL, map_location='cpu', weights_only=True)); m.to(dev).eval()
random.seed(1)


def score(norm_img):
    a = 1.0 - np.asarray(norm_img.convert('L'), dtype=np.float32) / 255.0
    with torch.no_grad():
        return torch.sigmoid(m(torch.from_numpy(a)[None, None].to(dev))).item()


def variants(raw):
    w, h = raw.size
    out = {'scale0.6': raw.resize((max(1, int(w * 0.6)), max(1, int(h * 0.6))), Image.LANCZOS),
           'scale1.6': raw.resize((int(w * 1.6), int(h * 1.6)), Image.LANCZOS),
           'thick': raw.convert('L').filter(ImageFilter.MinFilter(3))}
    a = np.asarray(raw.convert('L'), dtype=np.float32)
    noisy = np.clip(a + np.random.default_rng(0).normal(0, 25, a.shape), 0, 255).astype(np.uint8)
    out['scan'] = Image.fromarray(noisy).filter(ImageFilter.GaussianBlur(0.8))
    return out


# our held-out drawings (test split)
gen = []
for f in glob.glob(f'{ROOT}/gen-raw/index-*.jsonl'):
    for l in open(f):
        r = json.loads(l)
        if split_of('gen:' + r['id']) == 'test':
            gen.append(r)
random.shuffle(gen)
gen = gen[:N]
d_style, d_text, base = {}, [], []
for r in gen:
    raw = Image.open(f'{ROOT}/gen-raw/{r["file"]}')
    n0 = normalize(raw)
    if n0 is None:
        continue
    s0 = score(n0); base.append(s0)
    for k, v in variants(raw).items():
        nv = normalize(v)
        if nv is not None:
            d_style.setdefault(k, []).append(abs(score(nv) - s0))
    nt = normalize(raw, text=True)
    if nt is not None:
        d_text.append(abs(score(nt) - s0))
print(f'1. style invariance on {len(base)} of our test drawings, mean |Δscore| (share with |Δ| > 0.1):')
for k, v in d_style.items():
    v = np.array(v); print(f'   {k:9s} {v.mean():.3f} ({(v > 0.1).mean():.0%})')
v = np.array(d_text); print(f'2. text kept vs stripped: mean |Δ| {v.mean():.3f} ({(v > 0.1).mean():.0%} > 0.1)')
wit = {k: f'/tmp/claude-1000/motif-diag/ref/1645-{k}.png' for k in ('v2b', 'now')}
if all(os.path.exists(p) for p in wit.values()):
    s = {k: score(normalize(Image.open(p))) for k, p in wit.items()}
    print(f'3. witness bandgap 1645: v2+branches {s["v2b"]:.3f} vs auto scatter {s["now"]:.3f} -> {"PASS" if s["v2b"] > s["now"] else "FAIL"}')
pub = [json.loads(l) for l in open(f'{ROOT}/pub-raw/index.jsonl')]
pub = [r for r in pub if split_of('pub:' + r['key'].split('|')[0]) == 'test'][:N]
ps = [score(Image.open(f'{ROOT}/pub/{r["n"]}.png')) for r in pub if os.path.exists(f'{ROOT}/pub/{r["n"]}.png')]
print(f'4. test split: published mean score {np.mean(ps):.3f} (n={len(ps)}), ours mean {np.mean(base):.3f} (n={len(base)})')
