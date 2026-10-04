"""self-train.py — pseudo-label self-training of the component detector on the
DVD schematics (judge v2, step 2). Private, ai-station only; DVD origin only.

Each round:
  1. run the current detector on the DVD figures of the POOL split (low threshold);
  2. keep a figure as pseudo-labelled only when, for every kind in nmos, pmos,
     resistor, capacitor, its top-n boxes (n = the Ornith reading's count of that
     kind) are confident (score >= KEEP) and the next box is not (< EXTRA), and no
     two kept boxes of different kinds overlap (IoU > 0.5). Rails, dots and
     terminals are taken from the detector at score >= 0.7 (no reading to check);
  3. fine-tune on AMSNet (full labels, scan augmentation) + the kept figures.
Measured on the EVAL split (papers never used for pseudo-labels): exact match of
the detected counts with the Ornith counts, per kind, plus AMSNet val (no regression).
Prints numbers only; no image leaves the station.
Usage: python3 tools/judge/self-train.py [--rounds 3] [--epochs 6] [--gpu 1] [--start detector-v2]
Writes /AI/datasets/judge/models/detector-st<r>.pt and self-train.json."""
import hashlib, json, os, random, sqlite3, sys
import torch
from PIL import Image
import torchvision.transforms.functional as TF
import importlib.util
spec = importlib.util.spec_from_file_location('tdet', os.path.join(os.path.dirname(__file__), 'train-detector.py'))
tdet = importlib.util.module_from_spec(spec)
sys.argv, _argv = [sys.argv[0], '--scan-aug'], sys.argv   # train-detector reads its own flags at import
spec.loader.exec_module(tdet)
sys.argv = _argv
from torchvision.models.detection import fasterrcnn_resnet50_fpn_v2
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor

Image.MAX_IMAGE_PIXELS = None
args = sys.argv
opt = lambda k, d: type(d)(args[args.index(k) + 1]) if k in args else d
ROUNDS, EPOCHS, GPU = opt('--rounds', 3), opt('--epochs', 6), opt('--gpu', 1)
START = opt('--start', 'detector-v2')
KEEP, EXTRA, LOW = opt('--keep', 0.5), opt('--extra', 0.5), 0.2
MAXSIDE = 1600
ROOT = '/AI/datasets/judge'
dev = torch.device(f'cuda:{GPU}')
tdet.dev = dev
C = tdet.CLASSES
KIND = {'nmos': 'nmos', 'pmos': 'pmos', 'resistor': 'R', 'capacitor': 'C'}
FREE = ('vdd', 'gnd', 'dot', 'terminal')


def split_of(pid):
    return 'eval' if int(hashlib.sha1(('st:' + pid).encode()).hexdigest()[:8], 16) / 0xffffffff < 0.1 else 'pool'


def new_model():
    m = fasterrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None)
    m.roi_heads.box_predictor = FastRCNNPredictor(m.roi_heads.box_predictor.cls_score.in_features, len(C))
    m.roi_heads.detections_per_img = 300
    return m


def load_pub(n):
    im = Image.open(f'{ROOT}/pub-raw/{n}.png').convert('RGB')
    s = min(1.0, MAXSIDE / max(im.size))
    if s < 1:
        im = im.resize((int(im.size[0] * s), int(im.size[1] * s)), Image.LANCZOS)
    return im


def figures():
    db = sqlite3.connect('file:/AI/datasets/IEEE/derived/figures.sqlite?mode=ro', uri=True)
    out = []
    for l in open(f'{ROOT}/pub-raw/index.jsonl'):
        r = json.loads(l)
        pid, page, rang = r['key'].split('|')
        if not os.path.exists(f'{ROOT}/pub-raw/{r["n"]}.png'):
            continue
        row = db.execute('SELECT lecture FROM lectures WHERE paper_id=? AND page=? AND rang=?', (pid, int(page), int(rang))).fetchone()
        if not row:
            continue
        comps = [c for c in (json.loads(row[0]).get('components') or []) if c]
        cnt = {d: sum(1 for c in comps if c.get('kind') == k) for d, k in KIND.items()}
        if sum(cnt.values()) == 0 or len(comps) > 60:
            continue
        out.append({'n': r['n'], 'split': split_of(pid), 'cnt': cnt})
    return out


def detect(m, figs):
    m.eval(); res = {}
    with torch.no_grad():
        for f in figs:
            o = m([TF.to_tensor(load_pub(f['n'])).to(dev)])[0]
            res[f['n']] = [(b.tolist(), C[int(l)], float(s)) for b, l, s in zip(o['boxes'].cpu(), o['labels'].cpu(), o['scores'].cpu()) if s >= LOW]
    return res


def counts_match(figs, det, thr):
    a = {k: [0, 0, 0.0] for k in KIND}
    for f in figs:
        for k in KIND:
            nd = sum(1 for _, c, s in det[f['n']] if c == k and s >= thr); nr = f['cnt'][k]
            if nd or nr:
                a[k][1] += 1; a[k][0] += nd == nr; a[k][2] += abs(nd - nr)
    return {k: (round(x / max(1, n), 3), round(e / max(1, n), 2), n) for k, (x, n, e) in a.items()}


def pseudo(f, dets):
    keep = []
    for k in KIND:
        cand = sorted((d for d in dets if d[1] == k), key=lambda d: -d[2])
        n = f['cnt'][k]
        if len(cand) < n or (n and cand[n - 1][2] < KEEP) or (len(cand) > n and cand[n][2] >= EXTRA):
            return None
        keep += cand[:n]
    for i in range(len(keep)):
        for j in range(i + 1, len(keep)):
            if tdet.iou(keep[i][0], keep[j][0]) > 0.5:
                return None
    keep += [d for d in dets if d[1] in FREE and d[2] >= 0.7]
    return keep


class Mixed(torch.utils.data.Dataset):
    def __init__(self, ams, pseudo_items):
        self.items = [('a', i) for i in ams] + [('p', p) for p in pseudo_items]
    def __len__(self):
        return len(self.items)
    def __getitem__(self, k):
        src, it = self.items[k]
        if src == 'a':
            im, b, l = tdet.load(it)
            if random.random() < 0.8:
                im = tdet.scan_like(im)
        else:
            n, boxes = it
            im = load_pub(n)
            b = torch.tensor([d[0] for d in boxes], dtype=torch.float32).reshape(-1, 4)
            l = torch.tensor([C.index(d[1]) for d in boxes], dtype=torch.int64)
        x = TF.to_tensor(im)
        if random.random() < 0.5:
            x = torch.clamp((x - 0.5) * random.uniform(0.8, 1.2) + 0.5 + random.uniform(-0.1, 0.1), 0, 1)
        return x, {'boxes': b, 'labels': l}


if __name__ == '__main__':
    random.seed(0); torch.manual_seed(0)
    figs = figures()
    pool = [f for f in figs if f['split'] == 'pool']; ev = [f for f in figs if f['split'] == 'eval']
    ids = sorted(d for d in os.listdir(tdet.ROOT) if os.path.isdir(f'{tdet.ROOT}/{d}'))
    ams_tr = [i for i in ids if tdet.split_of(i) == 'train']; ams_va = [i for i in ids if tdet.split_of(i) == 'val']
    print(f'DVD figures with a reading: pool {len(pool)}, eval {len(ev)}', flush=True)
    m = new_model(); m.load_state_dict(torch.load(f'{ROOT}/models/{START}.pt', map_location='cpu', weights_only=True)); m.to(dev)
    log = []
    for r in range(ROUNDS + 1):
        de = detect(m, ev)
        rep = {'round': r, 'eval': {str(t): counts_match(ev, de, t) for t in (0.5, 0.7)}}
        if r:
            rep['amsnet_val'] = tdet.evaluate(m, ams_va)
        print(json.dumps(rep), flush=True); log.append(rep)
        if r == ROUNDS:
            break
        dp = detect(m, pool)
        items = [(f['n'], p) for f in pool if (p := pseudo(f, dp[f['n']])) is not None and p]
        print(f'round {r + 1}: {len(items)} of {len(pool)} pool figures pseudo-labelled', flush=True)
        log[-1]['pseudo'] = len(items)
        dl = torch.utils.data.DataLoader(Mixed(ams_tr, items), batch_size=4, shuffle=True, num_workers=6, collate_fn=lambda b: tuple(zip(*b)))
        o = torch.optim.SGD([p for p in m.parameters() if p.requires_grad], lr=0.005, momentum=0.9, weight_decay=1e-4)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(o, EPOCHS * len(dl))
        for ep in range(EPOCHS):
            m.train(); tot = 0
            for xs, ts in dl:
                loss = sum(m([x.to(dev) for x in xs], [{k: v.to(dev) for k, v in t.items()} for t in ts]).values())
                o.zero_grad(); loss.backward(); o.step(); sched.step(); tot += loss.item()
            print(f'  epoch {ep + 1}: loss {tot / len(dl):.3f}', flush=True)
        torch.save(m.state_dict(), f'{ROOT}/models/detector-st{r + 1}.pt')
    json.dump(log, open(f'{ROOT}/models/self-train.json', 'w'), indent=1)
    print('done')
