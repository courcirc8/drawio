#!/usr/bin/env python3
"""
import-dvd-natif.py — circuits read by Ornith on the DVD schematics (RAG
delivery schemas-natif-2026-10-08.jsonl, origins dvd-2001 / dvd-2008 only,
Eric 2026-10-08) turned into bank netlists, to widen the variety of circuits.

The readings are ONE line of loosely SPICE-like text. Strict normaliser: the
line is cut into elements (M d g s [b] model, Q c b e [s] model, R/C/L n1 n2
value); comments, parentheses and '#'/'*' annotations are dropped; a circuit
is KEPT only when every element parses, it has 3+ elements, no transistor has
all its terminals on one net, and no element sits alone on nets nothing else
touches. Anything doubtful is rejected (counts printed). No figure text or
image is written: only the netlist, an id (paper/page/rank) and a family.

Family from the figure type; ADC/DAC -> adc/dac (data-converter, never tuned);
DC-DC -> regulator (never tuned, kept on the safe side of the holdout line);
no type -> left to the recognizer (weak label).

Writes <bank>/dvd-natif/<id>.cir and <bank>/manifest-dvdnatif.jsonl; then run
tools/inventory-bank.mjs. The 50 sealed circuits are refused later by
lib/sealed.js in every tool (fingerprints), and splitOf keeps test / unseen
families apart (hash / family).

Usage: python3 tools/import-dvd-natif.py [--src FILE] [--bank DIR]
"""
import json, os, re, sys, hashlib, collections

args = sys.argv[1:]
def arg(k, d):
    return args[args.index(k) + 1] if k in args else d
SRC = arg('--src', '/AI/datasets/IEEE/derived/schemas-natif-2026-10-08.jsonl')
BANK = arg('--bank', '/AI/datasets/netlists/bank')
FAM = {'logic': 'logic', 'VCO': 'VCO', 'memory': 'memory', 'ADC': 'adc', 'DAC': 'dac', 'SerDes': 'SerDes',
       'clock': 'clock', 'opamp': 'opamp', 'filter': 'filter', 'LNA': 'lna', 'reference': 'reference',
       'mixer': 'mixer', 'PLL': 'pll', 'DC-DC': 'regulator', 'PA': 'pa', 'sensor': 'sensor'}
MOS = re.compile(r'^(n|p)(mos|fet|ch|channel)\w*$|^[np]$', re.I)
BJT = re.compile(r'^(npn|pnp)\w*$', re.I)
NODE = re.compile(r'^[A-Za-z0-9_+\-\.\[\]<>]+$')
VAL = re.compile(r'^[0-9.]+(e-?\d+)?[a-zA-Zµ]*$')
REF = re.compile(r'^([MQRCL])[A-Za-z0-9_]*$')

def tokens(text):
    t = re.sub(r'\([^)]*\)', ' ', text)            # parenthesised notes
    t = re.sub(r'#[^A-Z]*', ' ', t)                 # '#' comments (to the next capital, crude)
    t = t.replace(',', ' ').replace(';', ' ')
    # trailing annotation marks ('pmos*', 'n1:') are dropped from each word
    return [w.rstrip('*:.') for w in t.split() if w.strip('*:.')]

ANNOT = re.compile(r'(=|/|^[0-9.]+(e-?\d+)?[a-zA-Zµ]*$|^(w|l|m|nf|mult)$)', re.I)
def skip_annotations(w, i):
    # after an element: values and notes ('140uA', 'W/L=2/0.18', 'm=4') up to the next element
    while i < len(w) and not REF.match(w[i]) and ANNOT.search(w[i]):
        i += 1
    return i

# an element name: a device letter and a digit (M1, Rf2, Q3a, I1); plain words
# ('Load', 'Mirror', 'Itail', 'INV1' — an inverter, not a source) are notes
REFD = re.compile(r'^([MQRCL])[A-Za-z_]*\d\w*$|^([IV])\d+\w*$')
DEFAULT = {'R': '1k', 'C': '1p', 'L': '1n', 'I': '10u', 'V': '1'}
STOP = {'of', 'the', 'to', 'and', 'node', 'port', 'in', 'out'} - {'in', 'out'}

def parse(text):
    """Elements in a loose reading; None when a recognised element is malformed."""
    w = tokens(text)
    out, i = [], 0
    while i < len(w):
        m = REFD.match(w[i])
        if not m:
            i += 1          # a note word
            continue
        k, ref = (m.group(1) or m.group(2)).upper(), w[i]
        if k == 'M':
            nodes = w[i + 1:i + 6]
            if len(nodes) >= 5 and MOS.match(nodes[4]) and all(NODE.match(n) for n in nodes[:4]):
                d, g, s, b, mod = nodes; i += 6
            elif len(nodes) >= 4 and MOS.match(nodes[3]) and all(NODE.match(n) for n in nodes[:3]):
                d, g, s, mod = nodes[:4]; b = s; i += 5
            else:
                return None
            if d == g == s:
                return None
            out.append(f"{ref} {d} {g} {s} {b} {'PMOS' if mod.lower().startswith('p') else 'NMOS'}")
        elif k == 'Q':
            nodes = w[i + 1:i + 5]
            if len(nodes) >= 4 and BJT.match(nodes[3]) and all(NODE.match(n) for n in nodes[:3]):
                c, b, e, mod = nodes; i += 5
            else:
                return None
            if c == b == e:
                return None
            out.append(f"{ref} {c} {b} {e} {'PNP' if mod.lower().startswith('p') else 'NPN'}")
        else:
            nodes = w[i + 1:i + 4]
            if len(nodes) < 2 or not (NODE.match(nodes[0]) and NODE.match(nodes[1])) or nodes[0].lower() in STOP or nodes[1].lower() in STOP \
               or REFD.match(nodes[0]) or REFD.match(nodes[1]):
                return None
            a, b2 = nodes[:2]
            if len(nodes) >= 3 and VAL.match(nodes[2]):
                v = nodes[2]; i += 4
            else:
                v = DEFAULT[k]; i += 3
            if a == b2:
                return None
            out.append(f"{ref} {a} {b2} {v}")
        i = skip_annotations(w, i)
    return out

def connected(lines):
    nets = collections.Counter()
    els = []
    for l in lines:
        p = l.split()
        ns = set(p[1:4] if p[0][0].upper() in 'MQ' else p[1:3])
        els.append(ns)
        nets.update(ns)
    rail = re.compile(r'^(0|gnd|vss|vdd|vcc|vee|avdd|avss|agnd)$', re.I)
    # every element shares at least one non-rail net with another element
    for ns in els:
        if not any(nets[n] > 1 and not rail.match(n) for n in ns) and not any(rail.match(n) for n in ns):
            return False
    return True

stat = collections.Counter()
os.makedirs(os.path.join(BANK, 'dvd-natif'), exist_ok=True)
man = []
seen = set()
for line in open(SRC):
    r = json.loads(line)
    stat['figures'] += 1
    if r.get('origine') not in ('dvd-2001', 'dvd-2008'):
        stat['refused: not DVD'] += 1; continue
    net = ((r.get('lecture') or {}).get('netlist') or '').strip()
    if not net:
        stat['no netlist'] += 1; continue
    lines = parse(net)
    if lines is None:
        stat['rejected: not parseable'] += 1; continue
    if len(lines) < 3:
        stat['rejected: < 3 elements'] += 1; continue
    if not connected(lines):
        stat['rejected: disconnected element'] += 1; continue
    # refs must be unique
    refs = [l.split()[0] for l in lines]
    if len(set(refs)) != len(refs):
        stat['rejected: duplicate refs'] += 1; continue
    body = '\n'.join(lines)
    h = hashlib.sha1(body.encode()).hexdigest()[:12]
    if h in seen:
        stat['duplicate netlist'] += 1; continue
    seen.add(h)
    ident = re.sub(r'[^A-Za-z0-9]+', '_', f"{r['paper_id']}_p{r['page']}_r{r['rang']}")
    f = os.path.join(BANK, 'dvd-natif', ident + '.cir')
    with open(f, 'w') as o:
        o.write(f"* dvd-natif {ident}\n{body}\n.end\n")
    fam = FAM.get(r.get('type'))
    man.append({'id': f'dvd-natif/{ident}', 'source': 'dvd-natif', 'licence': 'IEEE DVD, private use only (never leaves ai-station)',
                'family': fam, 'familySource': 'figure-type' if fam else None, 'file': f, 'extra': {'origine': r['origine']}})
    stat['kept'] += 1
with open(os.path.join(BANK, 'manifest-dvdnatif.jsonl'), 'w') as o:
    for m in man:
        o.write(json.dumps(m) + '\n')
for k, v in stat.most_common():
    print(f'{v:6d}  {k}')
print(collections.Counter(m['family'] for m in man).most_common())
