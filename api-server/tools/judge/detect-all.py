"""detect-all.py — run a component detector on every DVD schematic of pub-raw and
write the boxes (pub-raw pixel coordinates) for the layout statistics of judge v2.
Private, ai-station only. Writes /AI/datasets/judge/dvd-detections-<model>.jsonl:
{n, key, W, H, boxes:[[x0,y0,x1,y1,class,score]]} (score >= 0.3; filter later).
With --gen: our own renders instead (gen-raw/index-*.jsonl, every variant of each
circuit), written to gen-detections-<model>.jsonl with n = file, key = id|variant|family.
Usage: python3 tools/judge/detect-all.py [--model detector-sb3] [--size 1200] [--gpu 1] [--gen]"""
import glob, json, os, sys
import importlib.util
args = sys.argv
MODEL = args[args.index('--model') + 1] if '--model' in args else 'detector-sb3'
SIZE = int(args[args.index('--size') + 1]) if '--size' in args else 1200
GEN = '--gen' in args
sys.argv = [sys.argv[0]] + (['--gpu', args[args.index('--gpu') + 1]] if '--gpu' in args else [])
spec = importlib.util.spec_from_file_location('st', os.path.join(os.path.dirname(__file__), 'self-train.py'))
st = importlib.util.module_from_spec(spec); spec.loader.exec_module(st)
import torch
import torchvision.transforms.functional as TF
from PIL import Image

m = st.new_model(); m.load_state_dict(torch.load(f'{st.ROOT}/models/{MODEL}.pt', map_location='cpu', weights_only=True))
m.transform.min_size, m.transform.max_size = (SIZE,), max(1333, SIZE * 5 // 3)
m.to(st.dev).eval()
out_path = f'{st.ROOT}/{"gen" if GEN else "dvd"}-detections-{MODEL}.jsonl'
if GEN:
    items = [(r['file'], f"{r['id']}|{r['variant']}|{r.get('family')}", f'{st.ROOT}/gen-raw/{r["file"]}')
             for f in sorted(glob.glob(f'{st.ROOT}/gen-raw/index-*.jsonl')) for r in map(json.loads, open(f))]
else:
    items = [(r['n'], r['key'], f'{st.ROOT}/pub-raw/{r["n"]}.png') for r in map(json.loads, open(f'{st.ROOT}/pub-raw/index.jsonl'))]
done = {json.loads(l)['n'] for l in open(out_path)} if os.path.exists(out_path) else set()
with open(out_path, 'a') as out, torch.no_grad():
    for n, key, p in items:
        if n in done or not os.path.exists(p):
            continue
        im = Image.open(p).convert('RGB'); W, H = im.size
        s = min(1.0, 2 * SIZE / max(W, H))
        if s < 1:
            im = im.resize((int(W * s), int(H * s)), Image.LANCZOS)
        o = m([TF.to_tensor(im).to(st.dev)])[0]
        boxes = [[*(round(v / s, 1) for v in b.tolist()), st.C[int(c)], round(float(sc), 3)]
                 for b, c, sc in zip(o['boxes'].cpu(), o['labels'].cpu(), o['scores'].cpu()) if sc >= 0.3]
        out.write(json.dumps({'n': n, 'key': key, 'W': W, 'H': H, 'boxes': boxes}) + '\n')
print('done', out_path)
