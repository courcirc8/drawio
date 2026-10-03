#!/usr/bin/env python3
"""ranker-train.py — pairwise logistic ranker for engine=auto (lib/ranker.js).

Trains on TUNING datasets only (tools/ranker-dataset.mjs output), evaluates on
any other dataset (the holdout), writes data/ranker.json.

Preference: fewer check.py errors wins; equal errors -> fewer check.py warnings
wins if the gap is >= 3 (else no pair). Model: linear score w·z(features),
logistic loss on score differences of the pairs of each circuit, L2.

Usage: python3 tools/ranker-train.py --train a.jsonl b.jsonl --eval h.jsonl [--out data/ranker.json]
"""
import argparse, collections, json
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--train', nargs='+', required=True)
ap.add_argument('--eval', nargs='*', default=[])
ap.add_argument('--out', default=None)
ap.add_argument('--l2', type=float, default=1.0)
ap.add_argument('--folds', type=int, default=5)
a = ap.parse_args()


def load(paths):
    rows = [json.loads(l) for p in paths for l in open(p) if l.strip()]
    by = collections.defaultdict(list)
    for r in rows:
        by[r['circuit']].append(r)
    return by


def pairs(group, feats, mean, std):
    X = []
    for i, a_ in enumerate(group):
        for b_ in group[i + 1:]:
            ea, eb = a_['py_errors'], b_['py_errors']
            if ea == eb:
                wa, wb = a_['py_warnings'], b_['py_warnings']
                if abs(wa - wb) < 3:
                    continue
                better = a_ if wa < wb else b_
            else:
                better = a_ if ea < eb else b_
            worse = b_ if better is a_ else a_
            X.append((vec(better, feats) - mean) / std - (vec(worse, feats) - mean) / std)
    return X


def vec(r, feats):
    return np.array([float(r['features'].get(k, 0.0)) for k in feats])


def fit(groups, feats, l2):
    allv = np.array([vec(r, feats) for g in groups for r in g])
    mean, std = allv.mean(0), allv.std(0)
    std[std < 1e-9] = 1.0
    X = np.array([x for g in groups for x in pairs(g, feats, mean, std)])
    w = np.zeros(len(feats))
    if len(X) == 0:
        return w, mean, std
    for _ in range(3000):           # gradient descent, logistic loss on +1 labels
        z = X @ w
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        g = -(X * (1 - p)[:, None]).mean(0) + l2 * w / len(X)
        w -= 0.5 * g
    return w, mean, std


def choose(group, key):
    return min(group, key=key)


def evaluate(by, w, mean, std, feats, label):
    def default4(g):
        return [r for r in g if r['cand'].endswith(':190:180')]
    res = collections.Counter()
    for c, g in by.items():
        d4 = default4(g) or g
        order = {r['cand']: i for i, r in enumerate(d4)}
        cur = min(d4, key=lambda r: (r['features']['js_errors'], -r['features']['conv'], order[r['cand']]))
        js16 = min(g, key=lambda r: (r['features']['js_errors'], -r['features']['conv']))
        orc = min(g, key=lambda r: (r['py_errors'], r['py_warnings']))
        orc4 = min(d4, key=lambda r: (r['py_errors'], r['py_warnings']))
        sc = lambda r: -float(((vec(r, feats) - mean) / std) @ w)
        rk4 = min(d4, key=sc)
        rk16 = min(g, key=sc)
        for name, r in [('current auto (4, check.js)', cur), ('check.js over 16', js16), ('ranker over 4', rk4), ('ranker over 16', rk16), ('oracle 4', orc4), ('oracle 16', orc)]:
            res[name] += r['py_errors']
            res[name + ' zero'] += r['py_errors'] == 0
    print(f'== {label}: {len(by)} circuits')
    for name in ['current auto (4, check.js)', 'check.js over 16', 'ranker over 4', 'ranker over 16', 'oracle 4', 'oracle 16']:
        print(f'  {name:28s} errors {res[name]:4d}   zero-error circuits {res[name + " zero"]}')
    return res


train = load(a.train)
feats = sorted({k for g in train.values() for r in g for k in r['features']})
groups = list(train.values())
# cross-validation on the tuning circuits (folds by circuit)
names = sorted(train)
rng = np.random.default_rng(0)
perm = rng.permutation(len(names))
cv = collections.Counter()
for k in range(a.folds):
    test = {names[i] for i in perm[k::a.folds]}
    w, mean, std = fit([train[n] for n in names if n not in test], feats, a.l2)
    r = evaluate({n: train[n] for n in test}, w, mean, std, feats, f'tuning fold {k + 1}')
    cv.update(r)
print('== tuning, 5-fold CV totals:', {k: v for k, v in cv.items() if not k.endswith('zero')})
w, mean, std = fit(groups, feats, a.l2)
for p in a.eval:
    evaluate(load([p]), w, mean, std, feats, f'EVAL {p}')
top = sorted(zip(feats, w), key=lambda t: -abs(t[1]))[:12]
print('top weights:', ', '.join(f'{k} {v:+.2f}' for k, v in top))
if a.out:
    json.dump({'features': feats, 'w': [round(float(x), 5) for x in w], 'mean': [float(x) for x in mean],
               'std': [float(x) for x in std], 'trained_on': a.train, 'l2': a.l2,
               'doc': 'tools/ranker-train.py; higher score = better drawing'}, open(a.out, 'w'), indent=1)
    print('->', a.out)
