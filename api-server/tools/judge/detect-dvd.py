"""detect-dvd.py — apply the component detector (detector-v1.pt) to the DVD
schematics (pub-raw, origin dvd-* only) and, with --check N, compare the
detected component counts with the RAG vision readings (lectures.components)
on N figures: a plausibility check of the domain shift (textbook -> scans) that
needs no image to leave the station. Prints numbers only.
Writes /AI/datasets/judge/dvd-detections.jsonl: {key, W, H, boxes:[[x0,y0,x1,y1,cls,score]]}.
Usage: python3 tools/judge/detect-dvd.py [--check 300] [--all] [--gpu 1] [--thr 0.6]"""
import json, os, sqlite3, sys
import torch
from PIL import Image
import torchvision.transforms.functional as TF
sys.path.insert(0, os.path.dirname(__file__))
import importlib.util   # train-detector.py has a dash in its name: load it by path
spec = importlib.util.spec_from_file_location('tdet', os.path.join(os.path.dirname(__file__), 'train-detector.py'))
tdet = importlib.util.module_from_spec(spec); spec.loader.exec_module(tdet)

args = sys.argv
GPU = int(args[args.index('--gpu') + 1]) if '--gpu' in args else 1
THR = float(args[args.index('--thr') + 1]) if '--thr' in args else 0.6
CHECK = int(args[args.index('--check') + 1]) if '--check' in args else 0
dev = torch.device(f'cuda:{GPU}')
from torchvision.models.detection import fasterrcnn_resnet50_fpn_v2
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
m = fasterrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None)
m.roi_heads.box_predictor = FastRCNNPredictor(m.roi_heads.box_predictor.cls_score.in_features, len(tdet.CLASSES))
m.load_state_dict(torch.load('/AI/datasets/judge/models/detector-v1.pt', map_location='cpu', weights_only=True))
m.to(dev).eval()

idx = [json.loads(l) for l in open('/AI/datasets/judge/pub-raw/index.jsonl')]
if CHECK and '--all' not in args:
    idx = idx[::max(1, len(idx) // CHECK)][:CHECK]
db = sqlite3.connect('file:/AI/datasets/IEEE/derived/figures.sqlite?mode=ro', uri=True)
out = open('/AI/datasets/judge/dvd-detections.jsonl', 'w' if '--all' in args else 'a')
KIND = {'nmos': 'nmos', 'pmos': 'pmos', 'resistor': 'R', 'capacitor': 'C'}
agree = {k: [0, 0] for k in KIND}   # exact count matches, figures with that kind read
err = {k: [] for k in KIND}
for r in idx:
    p = f'/AI/datasets/judge/pub-raw/{r["n"]}.png'
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    with torch.no_grad():
        o = m([TF.to_tensor(im).to(dev)])[0]
    boxes = [[*map(float, b), tdet.CLASSES[int(l)], float(s)] for b, l, s in zip(o['boxes'], o['labels'], o['scores']) if s >= THR]
    out.write(json.dumps({'key': r['key'], 'W': im.size[0], 'H': im.size[1], 'boxes': boxes}) + '\n')
    if CHECK:
        pid, page, rang = r['key'].split('|')
        row = db.execute('SELECT lecture FROM lectures WHERE paper_id=? AND page=? AND rang=?', (pid, int(page), int(rang))).fetchone()
        if not row:
            continue
        comps = json.loads(row[0]).get('components') or []
        for det_cls, read_kind in KIND.items():
            nd = sum(1 for b in boxes if b[4] == det_cls)
            nr = sum(1 for c in comps if c and c.get('kind') == read_kind)
            if nr or nd:
                agree[det_cls][1] += 1; agree[det_cls][0] += (nd == nr); err[det_cls].append(abs(nd - nr))
out.close()
if CHECK:
    print(f'detected vs read counts on {len(idx)} DVD figures (exact-match share, mean |diff|):')
    for k, (a, n) in agree.items():
        print(f'  {k:9s} {a}/{n} ({100 * a / max(1, n):.0f} %), mean |diff| {sum(err[k]) / max(1, len(err[k])):.2f}')
