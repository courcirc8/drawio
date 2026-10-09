#!/usr/bin/env python3
"""import-corpora.py — gather public netlist corpora into one quality bank.

Sources (cloned under ROOT, outside every repository):
  analoggenie  github.com/xz-group/AnalogGenie (MIT; circuits transcribed from
               textbooks and papers). Spectre-like `M0 (d g s b) nmos4` lines are
               converted to SPICE; the family comes from the id ranges of
               Dataset/data_categorization.md (FAMILY_RANGES below).
  amsnet       github.com/AMS-Net/ams.net.github.io (GPL-3.0; textbook schematics
               with SPICE netlist AND component boxes of the original drawing).
  ltspice-ex   symbench/spice-datasets ltspice_examples (copyright Analog Devices)
  ltspice-demo symbench/spice-datasets ltspice_demos   (copyright Analog Devices)
  kicad        symbench/spice-datasets kicad_github    (scraped public repos)
Writes ROOT/bank/<source>/<id>.cir and ROOT/bank/manifest.jsonl
({id, source, licence, family, file, extra}). Nothing is written in a repository.

Usage: python3 tools/import-corpora.py [--root /AI/datasets/netlists]
"""
import argparse, collections, json, os, re, zipfile

ap = argparse.ArgumentParser()
ap.add_argument('--root', default='/AI/datasets/netlists')
a = ap.parse_args()
ROOT = a.root
BANK = os.path.join(ROOT, 'bank')

# AnalogGenie id ranges -> family (data_categorization.md, 2025 release)
FAMILY_RANGES = [
    (1, 68, 'amplifier'), (69, 97, 'amplifier'), (98, 159, 'mirror-bias'), (160, 183, 'amplifier'),
    (184, 225, 'amplifier'), (226, 280, 'amplifier'), (281, 355, 'opamp'), (356, 367, 'misc'),
    (368, 384, 'reference'), (385, 395, 'sampler-sc'), (396, 402, 'misc'), (403, 437, 'oscillator'),
    (438, 440, 'pll'), (441, 444, 'misc'), (445, 460, 'misc'), (461, 492, 'lna'), (493, 493, 'misc'),
    (494, 520, 'mixer'), (521, 544, 'oscillator'), (545, 577, 'pll'), (578, 592, 'pa'), (593, 603, 'misc'),
    (604, 613, 'mirror-bias'), (614, 621, 'amplifier'), (622, 623, 'mirror-bias'), (624, 627, 'reference'),
    (628, 631, 'opamp'), (632, 635, 'comparator'), (636, 639, 'amplifier'), (640, 646, 'oscillator'),
    (647, 650, 'pll'), (651, 651, 'filter'), (652, 653, 'power'), (654, 668, 'misc'),
    (669, 701, 'amplifier'), (702, 704, 'amplifier'), (705, 725, 'opamp'), (726, 737, 'regulator'),
    (738, 749, 'comparator'), (750, 767, 'sampler-sc'), (768, 788, 'filter'), (789, 811, 'sampler-sc'),
    (812, 814, 'dac'), (815, 818, 'adc'), (819, 821, 'pll'), (822, 833, 'amplifier'),
    (834, 867, 'mirror-bias'), (868, 883, 'output-stage'), (884, 902, 'opamp'), (903, 914, 'amplifier'),
    (915, 920, 'misc'), (921, 932, 'opamp'), (933, 952, 'mirror-bias'), (953, 977, 'amplifier'),
    (978, 1029, 'opamp'), (1030, 1038, 'misc'), (1039, 1041, 'comparator'), (1042, 1043, 'adc'),
    (1044, 1044, 'sampler-sc'), (1045, 1080, 'comparator'), (1081, 1090, 'lna'), (1091, 1099, 'mixer'),
    (1100, 1108, 'pa'), (1109, 1190, 'oscillator'), (1191, 1460, 'power'), (1461, 1780, 'reference'),
    (1781, 2180, 'opamp'), (2181, 2630, 'regulator'), (2631, 3502, 'sampler-sc'),
]


def family_of(i):
    for lo, hi, f in FAMILY_RANGES:
        if lo <= i <= hi:
            return f
    return 'misc'


DEV = {'nmos4': ('M', 'NMOS'), 'pmos4': ('M', 'PMOS'), 'npn': ('Q', 'NPN'), 'pnp': ('Q', 'PNP'),
       'resistor': ('R', ''), 'capacitor': ('C', ''), 'inductor': ('L', ''), 'diode': ('D', 'D')}   # AnalogGenie has no values: none invented (Eric 2026-10-09)
LINE = re.compile(r'^\s*(\S+)\s*\(([^)]*)\)\s*(\S+)')


def convert_genie(text):
    """Spectre-like AnalogGenie lines -> SPICE. Returns (spice, unsupported kinds)."""
    out, bad, seen = [], set(), collections.Counter()
    for ln in text.splitlines():
        m = LINE.match(ln)
        if not m:
            continue
        name, nodes, kind = m.group(1), m.group(2).split(), m.group(3)
        nodes = ['0' if n.upper() in ('VSS', 'GND') else n for n in nodes]
        if kind in DEV:
            p, val = DEV[kind]
            ref = name if name[0].upper() == p else p + name
            seen[ref] += 1   # Cadence exports repeat instance names: MM2 twice -> MM2, MM2_2
            if seen[ref] > 1:
                ref = f'{ref}_{seen[ref]}'
            out.append(f"{ref} {' '.join(nodes)} {val}")
        else:   # INVERTER, TRANSMISSION_GATE, NAND…: kept as a subcircuit call (partly drawable)
            bad.add(kind)
            out.append(f"X{name} {' '.join(nodes)} {kind}")
    return '\n'.join(out) + '\n.end\n', sorted(bad)


def put(source, ident, spice, family, licence, extra=None):
    d = os.path.join(BANK, source)
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, f'{ident}.cir')
    with open(f, 'w') as fh:
        fh.write(spice)
    return {'id': f'{source}/{ident}', 'source': source, 'licence': licence, 'family': family,
            'file': f, 'extra': extra or {}}


man = []
# AnalogGenie
g = os.path.join(ROOT, 'AnalogGenie', 'Dataset')
for ident in sorted(os.listdir(g), key=lambda s: int(s) if s.isdigit() else 1 << 30):
    if not ident.isdigit():
        continue
    cir = os.path.join(g, ident, f'{ident}.cir')
    if not os.path.exists(cir):
        continue
    spice, bad = convert_genie(open(cir, errors='replace').read())
    ports = os.path.join(g, ident, f'Port{ident}.txt')
    man.append(put('analoggenie', ident, f'* AnalogGenie {ident}\n' + spice, family_of(int(ident)), 'MIT (textbook transcriptions)',
                   {'unsupported': bad, 'ports': open(ports).read().split() if os.path.exists(ports) else []}))
# AMSNet (netlist + component boxes of the original drawing)
z = [f for f in os.listdir(os.path.join(ROOT, 'ams.net.github.io')) if f.endswith('.zip')]
if z:
    with zipfile.ZipFile(os.path.join(ROOT, 'ams.net.github.io', z[0])) as zf:
        names = set(zf.namelist())
        for n in sorted(names):
            m = re.match(r'amsnet_1\.0/(\w+)/\1\.cir$', n)
            if not m:
                continue
            ident = m.group(1)
            bbox = f'amsnet_1.0/{ident}/{ident}_bbox.json'
            man.append(put('amsnet', ident, zf.read(n).decode('utf-8', 'replace'), None, 'GPL-3.0 (textbook schematics)',
                           {'has_bbox': bbox in names}))
# LTspice examples / demos, KiCad (as distributed)
for sub, source, lic in [('ltspice_examples', 'ltspice-ex', 'copyright Analog Devices (private use)'),
                         ('ltspice_demos', 'ltspice-demo', 'copyright Analog Devices (private use)'),
                         ('kicad_github', 'kicad', 'scraped public GitHub repos (mixed)')]:
    base = os.path.join(ROOT, 'spice-datasets', sub)
    for dp, _, fs in os.walk(base):
        for f in sorted(fs):
            if not re.search(r'\.(net|cir\d*|sp)$', f, re.I):
                continue
            ident = re.sub(r'[^A-Za-z0-9_.-]', '_', os.path.relpath(os.path.join(dp, f), base))
            text = open(os.path.join(dp, f), errors='replace').read()
            man.append(put(source, ident, text, None, lic))
with open(os.path.join(BANK, 'manifest.jsonl'), 'w') as fh:
    for r in man:
        fh.write(json.dumps(r) + '\n')
c = collections.Counter(r['source'] for r in man)
print(f'{len(man)} netlists -> {BANK}:', dict(c))
