#!/usr/bin/env python3
"""crawl-openpdk.py — real transistor-level netlists from open-silicon projects
(SkyWater sky130, GF180MCU, IHP SG13G2) on GitHub, for the quality bank.

Why: the bank's RF and data-converter families are thin (LNA 36, mixer 28,
PA 22, PLL 31, ADC/DAC 5). Open-PDK tape-out projects (Tiny Tapeout analog,
Efabless/Chipalooza, university courses) publish xschem/SPICE netlists of real
SAR/flash ADCs, PLLs, LNAs, mixers, LDOs, bandgaps, mostly under Apache-2.0.

1. search: GitHub code search (gh api, authenticated) per PDK device name x
   family keyword; up to 1000 hits per query (10 pages), politely paced.
2. licence: per repository (gh api repos/O/R/license); unknown kept, flagged.
3. fetch: raw file into ROOT/openpdk/raw/<owner>__<repo>/<path> (outside git).
4. convert: PDK devices -> SPICE M/R/C/Q, hierarchy flattened from the top
   subcircuit; one bank netlist per file into ROOT/bank/openpdk/, manifest
   lines appended to ROOT/bank/manifest-openpdk.jsonl with family from the
   author's names (repo/path/subckt keywords), flagged familySource="name".
Usage: python3 tools/crawl-openpdk.py search|fetch|convert|all [--root /AI/datasets/netlists] [--max-pages 10]
"""
import argparse, base64, collections, json, os, re, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('step', choices=['search', 'fetch', 'convert', 'all'])
ap.add_argument('--root', default='/AI/datasets/netlists')
ap.add_argument('--max-pages', type=int, default=10)
# the GitHub API quota (5 000 / h) is SHARED with the other sessions of the
# account: fetch at most ~2 400 requests / h by default
ap.add_argument('--pace', type=float, default=1.5, help='seconds between fetch requests')
a = ap.parse_args()
ROOT = os.path.join(a.root, 'openpdk')
os.makedirs(ROOT, exist_ok=True)
HITS = os.path.join(ROOT, 'hits.jsonl')

DEVICES = ['sky130_fd_pr__nfet_01v8', 'nfet_03v3', 'sg13_lv_nmos']
FAMILY_WORDS = {
    'adc': ['adc', 'sar', 'flash', 'pipeline', 'sigma', 'delta'],
    'dac': ['dac', 'cdac'], 'comparator': ['comparator', 'strongarm', 'latch'],
    'lna': ['lna', 'low noise'], 'mixer': ['mixer', 'gilbert'], 'pa': ['power amplifier', ' pa ', '_pa'],
    'pll': ['pll', 'charge pump', 'chargepump', 'pfd'], 'oscillator': ['vco', 'oscillator', 'ring osc'],
    'regulator': ['ldo', 'regulator'], 'reference': ['bandgap', 'bgr', 'reference'],
    'opamp': ['opamp', 'op-amp', 'ota', 'amplifier'], 'filter': ['filter'], 'sampler-sc': ['sample', 'hold', 'switched cap'],
}
QUERY_WORDS = ['adc', 'sar', 'comparator', 'lna', 'mixer', 'pll', 'vco', 'ldo', 'bandgap', 'ota', 'opamp', 'dac', 'filter', 'pa']


def gh(args, retries=4):
    for k in range(retries):
        r = subprocess.run(['gh', 'api'] + args, capture_output=True, text=True)
        if r.returncode == 0:
            return json.loads(r.stdout) if r.stdout.strip() else None
        if 'rate limit' in r.stderr.lower() or 'secondary' in r.stderr.lower():
            if k == retries - 1:
                # never record "no licence" / skip a blob because the shared
                # quota ran out: stop, the next run resumes where this one ended
                sys.exit('GitHub API quota exhausted: stopped, rerun later to resume')
            time.sleep(60 * (k + 1)); continue
        if '404' in r.stderr or '422' in r.stderr:
            return None
        time.sleep(5 * (k + 1))
    return None


def search():
    seen = set()
    if os.path.exists(HITS):
        seen = {json.loads(l)['key'] for l in open(HITS)}
    with open(HITS, 'a') as out:
        for dev in DEVICES:
            for w in QUERY_WORDS + ['']:
                q = f'{dev} {w} extension:spice'.replace('  ', ' ')
                for page in range(1, a.max_pages + 1):
                    j = gh(['-X', 'GET', 'search/code', '-f', f'q={q}', '-f', 'per_page=100', '-f', f'page={page}'])
                    time.sleep(7)  # code search: 10 requests / minute
                    items = (j or {}).get('items') or []
                    for it in items:
                        key = it['repository']['full_name'] + '/' + it['path']
                        if key in seen:
                            continue
                        seen.add(key)
                        out.write(json.dumps({'key': key, 'repo': it['repository']['full_name'], 'path': it['path'], 'sha': it['sha'], 'query': q}) + '\n')
                    if len(items) < 100:
                        break
                print(f'{q}: total hits so far {len(seen)}', flush=True)


def fetch():
    hits = [json.loads(l) for l in open(HITS)]
    lic_path = os.path.join(ROOT, 'licences.json')
    lic = json.load(open(lic_path)) if os.path.exists(lic_path) else {}
    by_sha = set()
    for h in hits:
        if h['repo'] not in lic:
            time.sleep(a.pace)
            j = gh([f'repos/{h["repo"]}/license'])
            lic[h['repo']] = (j or {}).get('license', {}).get('spdx_id') if j else None
            json.dump(lic, open(lic_path, 'w'))
        if h['sha'] in by_sha:
            continue   # same blob already fetched (forks, copies)
        by_sha.add(h['sha'])
        dst = os.path.join(ROOT, 'raw', h['repo'].replace('/', '__'), h['path'])
        if os.path.exists(dst):
            continue
        time.sleep(a.pace)
        j = gh([f'repos/{h["repo"]}/git/blobs/{h["sha"]}'])
        if not j or j.get('size', 0) > 2_000_000:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        open(dst, 'wb').write(base64.b64decode(j['content']))
    print(f'{len(by_sha)} unique blobs; licences: {collections.Counter(lic.values()).most_common(8)}')


# ---------- conversion
NMOS = re.compile(r'(nfet|nmos|_lv_nmos|_hv_nmos)', re.I)
PMOS = re.compile(r'(pfet|pmos|_lv_pmos|_hv_pmos)', re.I)
RES = re.compile(r'(res_|rppd|rsil|rhigh|ppolyf|nplus_|pplus_|rm\d)', re.I)
CAP = re.compile(r'(cap_|mim|cmim|varactor|mom)', re.I)
NPN = re.compile(r'(npn)', re.I)
PNP = re.compile(r'(pnp)', re.I)


def logical_lines(text):
    out = []
    for ln in text.splitlines():
        if ln.startswith('+') and out:
            out[-1] += ' ' + ln[1:]
        else:
            out.append(ln)
    return [l.strip() for l in out if l.strip() and not l.strip().startswith('*')]


def parse_subckts(lines):
    subs, top, cur = {}, [], None
    for l in lines:
        low = l.lower()
        if low.startswith('.subckt'):
            t = l.split()
            ports = [p for p in t[2:] if '=' not in p]
            cur = {'name': t[1], 'ports': ports, 'body': []}
            subs[t[1].lower()] = cur
        elif low.startswith('.ends'):
            cur = None
        elif low.startswith('.'):
            continue
        else:
            (cur['body'] if cur else top).append(l)
    return subs, top


def device(tokens, prefix_counter):
    """One PDK primitive instance -> SPICE line, or None if not a primitive."""
    name, rest = tokens[0], [t for t in tokens[1:] if '=' not in t]
    if not rest:
        return None
    model = rest[-1]
    nodes = rest[:-1]
    def ref(p):
        prefix_counter[p] += 1
        return f'{p}{prefix_counter[p]}'
    if NMOS.search(model) and len(nodes) >= 3:
        return f'{ref("M")} {" ".join(nodes[:4] if len(nodes) >= 4 else nodes[:3] + ["0"])} NMOS'
    if PMOS.search(model) and len(nodes) >= 3:
        return f'{ref("M")} {" ".join(nodes[:4] if len(nodes) >= 4 else nodes[:3] + [nodes[2]])} PMOS'
    if NPN.search(model) and len(nodes) >= 3:
        return f'{ref("Q")} {" ".join(nodes[:3])} NPN'
    if PNP.search(model) and len(nodes) >= 3:
        return f'{ref("Q")} {" ".join(nodes[:3])} PNP'
    if RES.search(model) and len(nodes) >= 2:
        return f'{ref("R")} {nodes[0]} {nodes[1]} 1k'
    if CAP.search(model) and len(nodes) >= 2:
        return f'{ref("C")} {nodes[0]} {nodes[1]} 1p'
    return None


def flatten(subs, body, prefix, mapping, counter, out, depth=0, missing=None):
    for l in body:
        t = l.split()
        c0 = t[0][0].upper()
        loc = lambda n: mapping.get(n, n if n in ('0', 'gnd', 'GND', 'vdd', 'VDD', 'vss', 'VSS') else prefix + n)
        if c0 == 'X':
            args = [x for x in t[1:] if '=' not in x]
            model = args[-1] if args else ''
            sub = subs.get(model.lower())
            if sub and depth < 12:
                m = dict(zip(sub['ports'], [loc(n) for n in args[:-1]]))
                flatten(subs, sub['body'], prefix + t[0] + '.', m, counter, out, depth + 1, missing)
                continue
            d = device([t[0]] + [loc(n) if '=' not in n and i < len(args) - 1 else n for i, n in enumerate(t[1:])], counter)
            if d:
                out.append(d)
            elif missing is not None:
                missing[model] += 1
        elif c0 in 'MRCQLD':
            args = [x for x in t[1:] if '=' not in x]
            if len(args) < 3:
                continue
            nodes = [loc(n) for n in args[:-1]] if c0 in 'MQ' else [loc(n) for n in args[:2]]
            if c0 == 'M':
                d = device([t[0]] + nodes + [args[-1]], counter)
                if d: out.append(d)
            elif c0 == 'Q':
                d = device([t[0]] + nodes + [args[-1]], counter)
                if d: out.append(d)
            else:
                counter[c0] += 1
                out.append(f'{c0}{counter[c0]} {nodes[0]} {nodes[1]} {"1k" if c0 == "R" else "1p" if c0 == "C" else "1n" if c0 == "L" else "D"}')
        elif c0 in 'VI' and len(t) >= 3:
            counter[c0] += 1
            out.append(f'{c0}{counter[c0]} {loc(t[1])} {loc(t[2])} {" ".join(t[3:]) or "0"}')


def family_from(text):
    s = text.lower()
    for fam, words in FAMILY_WORDS.items():
        if any(w in s for w in words):
            return fam
    return None


def convert():
    bank = os.path.join(a.root, 'bank', 'openpdk')
    os.makedirs(bank, exist_ok=True)
    lic = json.load(open(os.path.join(ROOT, 'licences.json')))
    man = open(os.path.join(a.root, 'bank', 'manifest-openpdk.jsonl'), 'w')
    stats = collections.Counter()
    for dp, _, fs in os.walk(os.path.join(ROOT, 'raw')):
        for f in fs:
            p = os.path.join(dp, f)
            repo = os.path.relpath(p, os.path.join(ROOT, 'raw')).split(os.sep)[0].replace('__', '/')
            text = open(p, errors='replace').read()
            subs, top = parse_subckts(logical_lines(text))
            used = {x.split()[-1].lower() for s in subs.values() for x in s['body'] if x[:1].upper() == 'X'}
            # the netlist's own circuit: the top-level body if it has devices, else each un-instantiated subckt
            roots = [('top', top)] if any(l[:1].upper() in 'XM' for l in top) else [(s['name'], s['body']) for k, s in subs.items() if k not in used]
            for rname, body in roots:
                out, counter, missing = [], collections.Counter(), collections.Counter()
                flatten(subs, body, '', {}, counter, out, missing=missing)
                stats['candidates'] += 1
                if sum(1 for l in out if l[0] in 'MQ') < 2:
                    stats['too few transistors'] += 1; continue
                if len(out) > 150:
                    stats['too big'] += 1; continue
                ident = re.sub(r'[^A-Za-z0-9_.-]', '_', f'{repo}__{os.path.relpath(p, dp)}__{rname}')[:180]
                fam = family_from(f'{repo} {p} {rname}')
                open(os.path.join(bank, ident + '.cir'), 'w').write(f'* openpdk {repo} {os.path.basename(p)} {rname}\n' + '\n'.join(out) + '\n.end\n')
                man.write(json.dumps({'id': f'openpdk/{ident}', 'source': 'openpdk', 'licence': lic.get(repo), 'family': fam,
                                      'familySource': 'name', 'file': os.path.join(bank, ident + '.cir'),
                                      'extra': {'repo': repo, 'unconverted': sum(missing.values())}}) + '\n')
                stats['kept'] += 1
    man.close()
    print(dict(stats))


if a.step in ('search', 'all'):
    search()
if a.step in ('fetch', 'all'):
    fetch()
if a.step in ('convert', 'all'):
    convert()
