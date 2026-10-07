"""amsnet-layouts.py — human-drawn layouts from AMSNet (734 textbook schematics,
GPL, private use): each component's position, orientation and mirror, LINKED to
its netlist reference. The AMSNet netlists were generated from the boxes by
their notebook (AMSNet_1_1.ipynb, reformat_names): refs are numbered per
category in the order of the bbox json keys and boxes, so the mapping is
reproduced exactly here (part_categories copied from the notebook).
Boxes are [y0, x0, y1, x1]. Key = <kind>[-mirror|-cross…]_<angle>.
Out: /AI/datasets/human-layouts/amsnet.jsonl
  {id, netlist, W, H, parts:[{ref, key, kind, angle, mirror, x, y, w, h}], ok}
  ok = every netlist component (M, R, C, L, I, V, Q) has exactly one box.
Usage: python3 tools/human/amsnet-layouts.py"""
import json, os, re
from PIL import Image

ROOT = '/AI/datasets/judge/amsnet/amsnet_1.0'
CATS = {'capacitor': 'C', 'gnd': 'G', 'current': 'I', 'inductor': 'L', 'mos': 'M', 'net': 'N', 'resistor': 'R',
        'voltage': 'V', 'vdd': 'VDD', 'npn': 'Q', 'pnp': 'Q', 'subskt': 'X'}   # order matters (notebook)


def root_of(key):
    for sub, r in CATS.items():
        if sub in key:
            return r
    return 'U'


out = open('/AI/datasets/human-layouts/amsnet.jsonl', 'w')
n_ok = n = 0
for d in sorted(os.listdir(ROOT), key=lambda s: int(s) if s.isdigit() else 1e9):
    bb = f'{ROOT}/{d}/{d}_bbox.json'
    if not os.path.exists(bb):
        continue
    boxes = json.load(open(bb))
    W, H = Image.open(f'{ROOT}/{d}/{d}.jpg').size
    counts, parts = {}, []
    for key, lst in boxes.items():
        for (y0, x0, y1, x1) in lst:
            r = root_of(key)
            counts[r] = counts.get(r, 0) + 1
            m = re.match(r'^([a-z]+)(-[a-z-]+)?_(\d+)$', key)
            kind, mod, ang = (m.group(1), m.group(2) or '', int(m.group(3))) if m else (key, '', 0)
            parts.append({'ref': f'{r}{counts[r]}', 'key': key, 'kind': kind, 'angle': ang, 'mirror': 'mirror' in mod,
                          'x': (x0 + x1) / 2, 'y': (y0 + y1) / 2, 'w': x1 - x0, 'h': y1 - y0})
    refs = [l.split()[0] for l in open(f'{ROOT}/{d}/{d}.cir') if l[:1].upper() in 'MRCLIVQ' and not l.startswith('.')]
    have = {p['ref'] for p in parts}
    ok = bool(refs) and all(r.upper() in have for r in refs)
    n += 1; n_ok += ok
    out.write(json.dumps({'id': f'amsnet/{d}', 'netlist': f'{ROOT}/{d}/{d}.cir', 'W': W, 'H': H, 'parts': parts, 'ok': ok}) + '\n')
print(f'{n} AMSNet schematics, {n_ok} with every netlist component matched to a box')
