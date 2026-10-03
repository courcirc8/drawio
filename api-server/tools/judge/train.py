"""train.py — the DVD-trained layout judge, version 1 (private, ai-station only).

Task: "published (DVD schematic) vs generated (our drawing)" on images that went
through the SAME normalisation (normalize.py). Its score P(published) on our
drawings is meant to rank candidates by how much they look like a published
LAYOUT. Style must not be a cue (Eric's condition (a)), hence:
  - identical random degradations on BOTH sides (line thickness by dilation or
    erosion, salt-and-pepper noise, small rotation, small rescale), so trait,
    grain and resolution carry no label information;
  - tests in eval.py: same drawing, different styles -> scores must tie.
Splits: by paper (published) and by circuit id (generated), 80/10/10.
Model: ResNet18, one grey channel, trained from scratch (no downloaded weights).
Usage: python3 tools/judge/train.py [--epochs 8] [--gpu 1]
Writes /AI/datasets/judge/models/judge-v1.pt and metrics.json."""
import glob, hashlib, json, os, random, sys
import numpy as np
import torch, torch.nn as nn, torch.nn.functional as F
import torchvision
from PIL import Image

ROOT = '/AI/datasets/judge'
args = sys.argv
EPOCHS = int(args[args.index('--epochs') + 1]) if '--epochs' in args else 8
GPU = int(args[args.index('--gpu') + 1]) if '--gpu' in args else 1
dev = torch.device(f'cuda:{GPU}' if torch.cuda.is_available() else 'cpu')
random.seed(0); np.random.seed(0); torch.manual_seed(0)


def split_of(key):
    h = int(hashlib.sha1(key.encode()).hexdigest()[:8], 16) / 0xffffffff
    return 'train' if h < 0.8 else 'val' if h < 0.9 else 'test'


# circuit families on both sides (caption type of the published figure, bank
# family of ours), so the sampler can give every family the same weight in
# each class: the judge must not learn "this kind of circuit is published"
PUB_FAM = {'LNA': 'lna', 'mixer': 'mixer', 'PA': 'pa', 'PLL': 'pll', 'VCO': 'oscillator', 'opamp': 'opamp',
           'reference': 'reference', 'filter': 'filter', 'ADC': 'data-converter', 'DAC': 'data-converter', 'DC-DC': 'power'}
GEN_FAM = {'adc': 'data-converter', 'dac': 'data-converter', 'oscillator': 'oscillator', 'VCO': 'oscillator', 'LNA': 'lna', 'PA': 'pa', 'PLL': 'pll'}


def load_items():
    items = []
    for l in open(f'{ROOT}/pub-raw/index.jsonl'):
        r = json.loads(l)
        p = f'{ROOT}/pub/{r["n"]}.png'
        if os.path.exists(p):
            items.append((p, 1, split_of('pub:' + r['key'].split('|')[0]), PUB_FAM.get(r.get('type'), 'other')))
    known = set(PUB_FAM.values())
    for f in glob.glob(f'{ROOT}/gen-raw/index-*.jsonl'):
        for l in open(f):
            r = json.loads(l)
            p = f'{ROOT}/gen/{r["file"]}'
            if os.path.exists(p):
                fam = GEN_FAM.get(r.get('family'), r.get('family'))
                items.append((p, 0, split_of('gen:' + r['id']), fam if fam in known else 'other'))
    return items


def degrade(a):
    """Same style perturbations for both classes. a: float32 HxW, 1 = ink."""
    t = torch.from_numpy(a)[None, None]
    r = random.random()
    if r < 0.3:
        t = F.max_pool2d(t, 3, 1, 1)                      # thicker lines
    elif r < 0.45:
        t = -F.max_pool2d(-t, 3, 1, 1)                    # thinner (erosion)
    if random.random() < 0.5:
        noise = (torch.rand_like(t) < random.uniform(0, 0.01)).float()
        t = torch.clamp(t + noise, 0, 1)                  # salt
        t = t * (torch.rand_like(t) > random.uniform(0, 0.01)).float()  # pepper
    if random.random() < 0.5:
        ang = random.uniform(-1.5, 1.5) * np.pi / 180
        sc = random.uniform(0.9, 1.1)
        th = torch.tensor([[np.cos(ang) / sc, -np.sin(ang) / sc, 0], [np.sin(ang) / sc, np.cos(ang) / sc, 0]], dtype=torch.float32)[None]
        grid = F.affine_grid(th, t.shape, align_corners=False)
        t = (F.grid_sample(t, grid, align_corners=False) > 0.5).float()
    return t[0]


class DS(torch.utils.data.Dataset):
    def __init__(self, items, aug):
        self.items, self.aug = items, aug
    def __len__(self):
        return len(self.items)
    def __getitem__(self, i):
        p, y = self.items[i][0], self.items[i][1]
        a = 1.0 - np.asarray(Image.open(p).convert('L'), dtype=np.float32) / 255.0
        x = degrade(a) if self.aug else torch.from_numpy(a)[None]
        return x, torch.tensor(float(y))


def model():
    m = torchvision.models.resnet18(weights=None, num_classes=1)
    m.conv1 = nn.Conv2d(1, 64, 7, 2, 3, bias=False)
    return m


def evaluate(m, loader):
    m.eval(); ys, ps = [], []
    with torch.no_grad():
        for x, y in loader:
            ps.append(torch.sigmoid(m(x.to(dev)).squeeze(1)).cpu()); ys.append(y)
    y, p = torch.cat(ys), torch.cat(ps)
    acc = ((p > 0.5).float() == y).float().mean().item()
    pos, neg = p[y == 1], p[y == 0]
    auc = (pos[:, None] > neg[None, :]).float().mean().item() if len(pos) and len(neg) else float('nan')
    return acc, auc


if __name__ == '__main__':
    items = load_items()
    parts = {s: [it for it in items if it[2] == s] for s in ('train', 'val', 'test')}
    print({s: (len(v), sum(1 for it in v if it[1] == 1)) for s, v in parts.items()}, flush=True)
    print('families (published, generated):', {f: (sum(1 for it in items if it[3] == f and it[1] == 1), sum(1 for it in items if it[3] == f and it[1] == 0)) for f in sorted({it[3] for it in items})}, flush=True)
    tr = parts['train']
    cnt = {}
    for it in tr: cnt[(it[1], it[3])] = cnt.get((it[1], it[3]), 0) + 1
    w = [1.0 / cnt[(it[1], it[3])] for it in tr]   # balance classes AND families within each class
    sampler = torch.utils.data.WeightedRandomSampler(w, num_samples=len(tr), replacement=True)
    dl = torch.utils.data.DataLoader(DS(tr, True), batch_size=128, sampler=sampler, num_workers=8)
    dv = torch.utils.data.DataLoader(DS(parts['val'], False), batch_size=256, num_workers=8)
    dt = torch.utils.data.DataLoader(DS(parts['test'], False), batch_size=256, num_workers=8)
    m = model().to(dev)
    opt = torch.optim.AdamW(m.parameters(), lr=1e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS * len(dl))
    for ep in range(EPOCHS):
        m.train()
        for x, y in dl:
            loss = F.binary_cross_entropy_with_logits(m(x.to(dev)).squeeze(1), y.to(dev))
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        print(f'epoch {ep + 1}: loss {loss.item():.3f} val acc/auc {evaluate(m, dv)}', flush=True)
    os.makedirs(f'{ROOT}/models', exist_ok=True)
    torch.save(m.state_dict(), f'{ROOT}/models/judge-v1.pt')
    acc, auc = evaluate(m, dt)
    json.dump({'test_acc': acc, 'test_auc': auc, 'epochs': EPOCHS, 'counts': {s: len(v) for s, v in parts.items()}}, open(f'{ROOT}/models/judge-v1.metrics.json', 'w'))
    print('test acc/auc', acc, auc)
