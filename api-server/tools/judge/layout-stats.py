"""layout-stats.py — layout features of a schematic from its detected component
boxes only (judge v2, step 3). No pixel enters the features: line thickness,
grain, fonts and text cannot be a cue; only where the parts sit relative to each
other. The same code runs on the DVD schematics and on our renders, both
detected by the same detector, so detector biases hit both sides alike.

Parts: MOS (nmos + pmos merged: polarity is often unreadable on scans, even for
Opus auditors), R, C, SRC (current + voltage sources); rails (vdd, gnd) only for
the rail features. Unit u = median part size, so the figure scale drops out.
Features (FEATURES, in order):
  n_log            log part count
  aspect_log       log(width / height) of the part centres' bounding box
  density          parts per u^2 of that box
  nn_med           median nearest-neighbour distance / u
  col_share        parts sharing a column (|dx| < 0.3u) with another part
  row_share        parts sharing a row (|dy| < 0.3u)
  mos_stack        MOS whose nearest MOS is vertical (|dy| > |dx|)
  mos_pair_row     MOS with a same-row MOS within 3u (pairs side by side)
  mos_mirror_sym   MOS mirrored about the MOS mean x (a partner at -dx, same row)
  vdd_above        rails: vdd above the MOS mean y (when both exist; else 0.5)
  gnd_below        gnd below the MOS mean y (else 0.5)
  dir_*            3 nearest neighbours: 8 directions x 3 distances (<1.5u, <3u, more), normalised
Usage (build the feature files):
  python3 tools/judge/layout-stats.py [--model detector-sb3] [--thr 0.5]
  -> /AI/datasets/judge/layout-<dvd|gen>.jsonl  {n, key, f:[...]}"""
import json, math, sys
import numpy as np

PART = {'nmos': 'MOS', 'pmos': 'MOS', 'resistor': 'R', 'capacitor': 'C', 'current': 'SRC', 'voltage': 'SRC'}
BASE = ['n_log', 'aspect_log', 'density', 'nn_med', 'col_share', 'row_share', 'mos_stack', 'mos_pair_row',
        'mos_mirror_sym', 'vdd_above', 'gnd_below']
DIRS = [f'dir_{a}_{d}' for d in ('near', 'mid', 'far') for a in range(8)]
FEATURES = BASE + DIRS


def features(boxes, thr=0.5):
    """boxes: [[x0,y0,x1,y1,class,score]]. Returns a list of len(FEATURES), or None (< 3 parts)."""
    parts = [(PART[b[4]], (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, max(b[2] - b[0], b[3] - b[1]))
             for b in boxes if b[5] >= thr and b[4] in PART]
    if len(parts) < 3:
        return None
    u = float(np.median([p[3] for p in parts])) or 1.0
    xy = np.array([[p[1] / u, p[2] / u] for p in parts])
    kinds = [p[0] for p in parts]
    n = len(parts)
    w, h = np.ptp(xy[:, 0]) + 1, np.ptp(xy[:, 1]) + 1
    d = np.hypot(xy[:, None, 0] - xy[None, :, 0], xy[:, None, 1] - xy[None, :, 1])
    np.fill_diagonal(d, np.inf)
    dx = np.abs(xy[:, None, 0] - xy[None, :, 0]); dy = np.abs(xy[:, None, 1] - xy[None, :, 1])
    np.fill_diagonal(dx, np.inf); np.fill_diagonal(dy, np.inf)
    col = float(np.mean((dx < 0.3).any(1))); row = float(np.mean((dy < 0.3).any(1)))
    mos = [i for i, k in enumerate(kinds) if k == 'MOS']
    stack = pair = sym = 0.0
    if len(mos) >= 2:
        sub = d[np.ix_(mos, mos)]
        nn = sub.argmin(1)
        stack = float(np.mean([abs(xy[mos[j], 1] - xy[i, 1]) > abs(xy[mos[j], 0] - xy[i, 0]) for i, j in zip(mos, nn)]))
        pair = float(np.mean([any(dy[i, j] < 0.3 and dx[i, j] < 3 for j in mos if j != i) for i in mos]))
        cx = xy[mos, 0].mean()
        sym = float(np.mean([any(abs((xy[j, 0] - cx) + (xy[i, 0] - cx)) < 0.4 and dy[i, j] < 0.3 for j in mos if j != i)
                             for i in mos]))
    my = xy[mos, 1].mean() if mos else xy[:, 1].mean()
    vdd = [(b[1] + b[3]) / 2 / u for b in boxes if b[5] >= thr and b[4] == 'vdd']
    gnd = [(b[1] + b[3]) / 2 / u for b in boxes if b[5] >= thr and b[4] == 'gnd']
    vdd_above = float(np.mean([y < my for y in vdd])) if vdd else 0.5
    gnd_below = float(np.mean([y > my for y in gnd])) if gnd else 0.5
    hist = np.zeros(24)
    for i in range(n):
        for j in np.argsort(d[i])[:min(3, n - 1)]:
            ang = math.atan2(xy[j, 1] - xy[i, 1], xy[j, 0] - xy[i, 0])
            a = int(((ang + math.pi / 8) % (2 * math.pi)) // (math.pi / 4)) % 8
            r = d[i, j]
            hist[a + 8 * (0 if r < 1.5 else 1 if r < 3 else 2)] += 1
    hist /= max(1, hist.sum())
    return [math.log(n), math.log(w / h), n / (w * h), float(np.median(d.min(1))), col, row, stack, pair, sym,
            vdd_above, gnd_below] + hist.tolist()


if __name__ == '__main__':
    args = sys.argv
    model = args[args.index('--model') + 1] if '--model' in args else 'detector-sb3'
    thr = float(args[args.index('--thr') + 1]) if '--thr' in args else 0.5
    for side in ('dvd', 'gen'):
        kept = tot = 0
        with open(f'/AI/datasets/judge/layout-{side}.jsonl', 'w') as out:
            for l in open(f'/AI/datasets/judge/{side}-detections-{model}.jsonl'):
                r = json.loads(l); tot += 1
                f = features(r['boxes'], thr)
                if f is not None:
                    kept += 1
                    out.write(json.dumps({'n': r['n'], 'key': r['key'], 'f': [round(v, 4) for v in f]}) + '\n')
        print(f'{side}: {kept} of {tot} figures with >= 3 parts')
