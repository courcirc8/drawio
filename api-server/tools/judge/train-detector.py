"""train-detector.py — component detector for schematic images (judge v2, step 1).

Trained on AMSNet (734 textbook schematics with hand-drawn component boxes; GPL,
private use), boxes stored as [y0, x0, y1, x1] (row, column — checked on the
images). torchvision Faster R-CNN (ResNet50-FPN v2, COCO weights), 10 classes.
Split 90/10 by circuit. Reports precision / recall per class at IoU >= 0.5.
Writes /AI/datasets/judge/models/detector-v1.pt (private, ai-station only).
Usage: python3 tools/judge/train-detector.py [--epochs 30] [--gpu 1] [--scan-aug]  (--scan-aug -> detector-v2)"""
import hashlib, json, os, random, sys
import numpy as np
import torch, torchvision
from PIL import Image
from torchvision.models.detection import fasterrcnn_resnet50_fpn_v2, FasterRCNN_ResNet50_FPN_V2_Weights
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
import torchvision.transforms.functional as TF
import io
from PIL import ImageFilter

ROOT = '/AI/datasets/judge/amsnet/amsnet_1.0'
args = sys.argv
EPOCHS = int(args[args.index('--epochs') + 1]) if '--epochs' in args else 30
SCAN = '--scan-aug' in args   # v2: degrade like a scanned paper (detector v1 did not transfer to the DVD scans)
TAG = 'v2' if SCAN else 'v1'
GPU = int(args[args.index('--gpu') + 1]) if '--gpu' in args else 1
dev = torch.device(f'cuda:{GPU}')
CLASSES = ['bg', 'nmos', 'pmos', 'resistor', 'capacitor', 'current', 'voltage', 'vdd', 'gnd', 'dot', 'terminal']
MAP = {'nmos': 'nmos', 'nmos-mirror': 'nmos', 'nmos-cross': 'nmos', 'nmos-mirror-cross': 'nmos',
       'pmos': 'pmos', 'pmos-mirror': 'pmos', 'pmos-cross': 'pmos', 'resistor': 'resistor', 'capacitor': 'capacitor',
       'current': 'current', 'voltage': 'voltage', 'voltage-mirror': 'voltage', 'vdd': 'vdd', 'gnd': 'gnd',
       'net-black': 'dot', 'net-white': 'terminal'}


def split_of(i):
    return 'val' if int(hashlib.sha1(i.encode()).hexdigest()[:8], 16) / 0xffffffff >= 0.9 else 'train'


def load(i):
    im = Image.open(f'{ROOT}/{i}/{i}.jpg').convert('RGB')
    boxes, labels = [], []
    for k, v in json.load(open(f'{ROOT}/{i}/{i}_bbox.json')).items():
        c = MAP.get(k.rsplit('_', 1)[0])
        if c is None:
            continue
        for y0, x0, y1, x1 in v:
            if x1 > x0 + 1 and y1 > y0 + 1:
                boxes.append([x0, y0, x1, y1]); labels.append(CLASSES.index(c))
    return im, torch.tensor(boxes, dtype=torch.float32).reshape(-1, 4), torch.tensor(labels, dtype=torch.int64)


def scan_like(im):
    """Scanned-paper look, geometry unchanged (boxes stay valid): lower resolution
    and back, blur, thinner or thicker strokes, noise, JPEG compression."""
    w, h = im.size
    f = random.uniform(0.3, 0.7)
    im = im.resize((max(8, int(w * f)), max(8, int(h * f))), Image.BILINEAR).resize((w, h), Image.BILINEAR)
    if random.random() < 0.5:
        im = im.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 1.2)))
    r = random.random()
    if r < 0.3:
        im = im.filter(ImageFilter.MinFilter(3))      # thicker dark strokes
    elif r < 0.5:
        im = im.filter(ImageFilter.MaxFilter(3))      # thinner
    a = np.asarray(im.convert('L'), dtype=np.float32)
    a = np.clip(a + np.random.normal(0, random.uniform(0, 20), a.shape), 0, 255).astype(np.uint8)
    im = Image.fromarray(a).convert('RGB')
    if random.random() < 0.5:
        buf = io.BytesIO(); im.save(buf, 'JPEG', quality=random.randint(30, 80)); buf.seek(0); im = Image.open(buf).convert('RGB')
    return im


class DS(torch.utils.data.Dataset):
    def __init__(self, ids, aug):
        self.ids, self.aug = ids, aug
    def __len__(self):
        return len(self.ids)
    def __getitem__(self, k):
        im, b, l = load(self.ids[k])
        if self.aug and SCAN and random.random() < 0.8:
            im = scan_like(im)
        x = TF.to_tensor(im)
        if self.aug and random.random() < 0.5:   # brightness/contrast jitter only: no flips (orientation matters)
            x = torch.clamp((x - 0.5) * random.uniform(0.8, 1.2) + 0.5 + random.uniform(-0.1, 0.1), 0, 1)
        return x, {'boxes': b, 'labels': l}


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1]); x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def evaluate(m, ids, thr=0.5):
    m.eval(); tp = {c: 0 for c in CLASSES[1:]}; fp = dict(tp); fn = dict(tp)
    with torch.no_grad():
        for i in ids:
            im, b, l = load(i)
            out = m([TF.to_tensor(im).to(dev)])[0]
            pb = [(bb.tolist(), CLASSES[int(lb)]) for bb, lb, sc in zip(out['boxes'], out['labels'], out['scores']) if sc >= thr]
            gt = [(bb.tolist(), CLASSES[int(lb)]) for bb, lb in zip(b, l)]
            used = set()
            for bb, c in pb:
                j = next((j for j, (g, gc) in enumerate(gt) if j not in used and gc == c and iou(bb, g) >= 0.5), None)
                if j is None: fp[c] += 1
                else: tp[c] += 1; used.add(j)
            for j, (g, gc) in enumerate(gt):
                if j not in used: fn[gc] += 1
    return {c: (round(tp[c] / max(1, tp[c] + fp[c]), 2), round(tp[c] / max(1, tp[c] + fn[c]), 2), tp[c] + fn[c]) for c in CLASSES[1:]}


if __name__ == '__main__':
    random.seed(0); torch.manual_seed(0)
    ids = sorted(d for d in os.listdir(ROOT) if os.path.isdir(f'{ROOT}/{d}'))
    tr, va = [i for i in ids if split_of(i) == 'train'], [i for i in ids if split_of(i) == 'val']
    print('train', len(tr), 'val', len(va), flush=True)
    m = fasterrcnn_resnet50_fpn_v2(weights=FasterRCNN_ResNet50_FPN_V2_Weights.DEFAULT)
    m.roi_heads.box_predictor = FastRCNNPredictor(m.roi_heads.box_predictor.cls_score.in_features, len(CLASSES))
    m.to(dev)
    dl = torch.utils.data.DataLoader(DS(tr, True), batch_size=4, shuffle=True, num_workers=6, collate_fn=lambda b: tuple(zip(*b)))
    opt = torch.optim.SGD([p for p in m.parameters() if p.requires_grad], lr=0.01, momentum=0.9, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS * len(dl))
    for ep in range(EPOCHS):
        m.train(); tot = 0
        for xs, ts in dl:
            loss = sum(m([x.to(dev) for x in xs], [{k: v.to(dev) for k, v in t.items()} for t in ts]).values())
            opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += loss.item()
        print(f'epoch {ep + 1}: loss {tot / len(dl):.3f}', flush=True)
        if (ep + 1) % 10 == 0:
            print('  val (precision, recall, n):', evaluate(m, va), flush=True)
    os.makedirs('/AI/datasets/judge/models', exist_ok=True)
    torch.save(m.state_dict(), f'/AI/datasets/judge/models/detector-{TAG}.pt')
    json.dump({'val': evaluate(m, va), 'classes': CLASSES}, open(f'/AI/datasets/judge/models/detector-{TAG}.metrics.json', 'w'))
    print('saved')
