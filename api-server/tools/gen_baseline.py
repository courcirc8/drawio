#!/usr/bin/env python3
"""
gen_baseline.py — baseline results table generator for the beauty score.

Companion to run-benchmark.sh, for a host with NO headless Chromium (no
puppeteer-core executable found -> lib/render.js:24 throws, which makes
POST /documents/:id/beauty AND GET .../export?format=png both fail, since
lib/beauty.js unconditionally renders a PNG before computing anything).

This script does not need Chromium: it drives the same netlist-import / lvs
/ erc endpoints as run-benchmark.sh, but pulls the diagram as XML
(GET .../export?format=xml, which bypasses render.js entirely) and calls
tools/beauty.py DIRECTLY on that XML with a nonexistent PNG path. beauty.py
already handles a missing/unreadable PNG by returning an empty dict from
cv_metrics() (see beauty.py:299-301) instead of raising, so this yields the
exact same XML-geometry metrics (crossings, bends, wire_length, min_length,
label_on_wire, label_overlap, too_close, sprawl, align_ratio) that
POST /beauty would have computed from the same XML. It does NOT yield:
  - cv2 metrics (ink_balance, ssim, orb_match) -- need the rendered PNG.
  - structural metrics (flow_ok, rails_ok, pair_sym, mirror_row) -- computed
    in lib/beauty.js's structuralMetrics(), which is not exposed as its own
    endpoint and is only ever called from inside the render-then-score path.
Both are recorded as the literal string "unavailable" in the results table,
never as 0/blank, per this task's explicit instruction not to fabricate rows.

The results table also carries its own availability record (score, per the
2026-08-28 follow-up: beauty.score() now returns a dict with `score_partial`
always present but `score` ONLY when nothing was skipped, plus
`evaluated_weight`/`missing_weight`/`missing_terms` — see beauty.py and
tools/BEAUTY.md). On THIS host `score` is 'unavailable' for every row: the
5 structural+cv2 terms (unbalance/flow/rails/pair_sym/mirror_row) are always
missing without a render. That is not a bug in this script — it is the
fix working: a caller can no longer mistake `score_partial` for a complete
`score`. Per-circuit v1/v2/opt comparisons are written to
comparisons.tsv using beauty.compare(), which refuses to diff two results
whose missing_terms differ (opt rows have no result at all here, since the
optimizer's own hill-climb needs Chromium to import).

Usage: gen_baseline.py [base_url] [out_dir]
"""
import sys, os, glob, json, subprocess, requests

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8770'
HERE = os.path.dirname(os.path.abspath(__file__))
API_ROOT = os.path.dirname(HERE)
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(API_ROOT, 'benchmark', 'results')
os.makedirs(OUT, exist_ok=True)

sys.path.insert(0, HERE)
import beauty  # noqa: E402 -- for beauty.compare(); guarded by __main__ in beauty.py

BEAUTY_PY = os.path.join(HERE, 'beauty.py')
NETLISTS = sorted(glob.glob(os.path.join(API_ROOT, 'benchmark', 'netlists', '*.cir')))
ENGINES = ['v1', 'v2', 'opt']
ITER = 12

UNAVAILABLE = 'unavailable'

COLUMNS = [
    'circuit', 'engine', 'import_error',
    'lvs_match', 'lvs_missing', 'lvs_extra', 'lvs_type_mismatches',
    'erc_errors', 'erc_warnings',
    'score', 'score_partial', 'evaluated_weight', 'missing_weight', 'missing_terms',
    'crossings', 'through_component', 'bends', 'excess_bends',
    'wire_length', 'min_length', 'too_close',
    'label_on_wire', 'label_overlap', 'align_ratio', 'sprawl',
    'n_wires', 'n_components',
    'ink_balance', 'ssim', 'orb_match',
    'flow_ok', 'rails_ok', 'pair_sym', 'mirror_row',
]


def row_for(cir_path, engine):
    """Returns (row_dict, beauty_result_or_None). beauty_result is the raw
    dict beauty.py's score() produced (with 'missing_terms' etc.), kept
    around so main() can feed matching pairs into beauty.compare() -- a row
    dict alone has already been flattened/stringified and lost that shape."""
    name = os.path.splitext(os.path.basename(cir_path))[0]
    spice = open(cir_path).read()
    row = {c: UNAVAILABLE for c in COLUMNS}
    row['circuit'] = name
    row['engine'] = engine
    row['import_error'] = ''

    doc = requests.post(f'{BASE}/documents', json={}).json()['id']
    try:
        url = f'{BASE}/documents/{doc}/netlist/import'
        params = {'engine': engine} if engine != 'opt' else {'optimize': ITER}
        resp = requests.post(url, params=params, data=spice.encode(),
                              headers={'Content-Type': 'text/plain'}).json()
        if resp.get('error'):
            row['import_error'] = resp['error']
            return row, None

        lvs = requests.post(f'{BASE}/documents/{doc}/lvs', data=spice.encode(),
                             headers={'Content-Type': 'text/plain'}).json()
        row['lvs_match'] = lvs.get('match')
        row['lvs_missing'] = len(lvs.get('missing', []))
        row['lvs_extra'] = len(lvs.get('extra', []))
        row['lvs_type_mismatches'] = len(lvs.get('type_mismatches', []))

        erc = requests.get(f'{BASE}/documents/{doc}/erc').json()
        row['erc_errors'] = erc.get('errors', UNAVAILABLE)
        row['erc_warnings'] = erc.get('warnings', UNAVAILABLE)

        # Score through the SERVER's /beauty endpoint, not by calling beauty.py on
        # raw XML. The direct-XML path was written when this host was believed to
        # have no Chromium; it cannot produce the PNG (cv2 terms) nor the JS-side
        # structural metrics, so it silently left 54 of the 100 weight points
        # unmeasured -- exactly the partial-score trap the availability columns
        # exist to expose. Chrome for Testing is present (render.js now discovers
        # the puppeteer/Playwright caches), so the full score is reachable.
        # If the render path fails, fall back to the XML-only path rather than
        # dropping the row, and let missing_terms record what was lost.
        resp = requests.post(f'{BASE}/documents/{doc}/beauty', json={})
        if resp.status_code == 200:
            result = resp.json()
        else:
            xml = requests.get(f'{BASE}/documents/{doc}/export', params={'format': 'xml'}).text
            xml_path = os.path.join(OUT, f'.{name}-{engine}.xml.tmp')
            with open(xml_path, 'w') as f:
                f.write(xml)
            out = subprocess.run([sys.executable, BEAUTY_PY, xml_path, '/nonexistent-no-render.png'],
                                  capture_output=True, text=True)
            os.remove(xml_path)
            if out.returncode != 0:
                row['import_error'] = f'beauty rc={out.returncode}: {out.stderr[:300]}'
                return row, None
            result = json.loads(out.stdout)
        # BUG (fixed): this used to do `row['score'] = result['score']`,
        # which KeyErrors now that score() omits 'score' whenever any term
        # is missing (see beauty.py) -- on this Chromium-less host that is
        # EVERY row, so the unguarded version would have crashed the whole
        # run. 'score' now correctly stays 'unavailable' here; score_partial
        # carries the number that IS real.
        row['score'] = result.get('score', UNAVAILABLE)
        row['score_partial'] = result['score_partial']
        row['evaluated_weight'] = result['evaluated_weight']
        row['missing_weight'] = result['missing_weight']
        row['missing_terms'] = ';'.join(result['missing_terms'])
        m = result['metrics']
        for k in ('crossings', 'through_component', 'bends', 'excess_bends', 'wire_length',
                  'min_length', 'too_close', 'label_on_wire', 'label_overlap',
                  'align_ratio', 'sprawl', 'n_wires', 'n_components',
                  'ink_balance', 'ssim', 'orb_match',
                  'flow_ok', 'rails_ok', 'pair_sym', 'mirror_row'):
            row[k] = m.get(k, UNAVAILABLE)
        return row, result
    finally:
        requests.delete(f'{BASE}/documents/{doc}')


def main():
    if not NETLISTS:
        print('ERROR: no netlists found under benchmark/netlists/', file=sys.stderr)
        sys.exit(1)
    try:
        requests.get(f'{BASE}/health', timeout=3).raise_for_status()
    except Exception as e:
        print(f'ERROR: api-server not reachable at {BASE}: {e}', file=sys.stderr)
        sys.exit(1)

    rows = []
    results = {}  # (circuit, engine) -> raw beauty.py result dict, or None
    for cir in NETLISTS:
        for engine in ENGINES:
            print(f'  {os.path.basename(cir)} / {engine} ...', file=sys.stderr)
            row, result = row_for(cir, engine)
            rows.append(row)
            results[(row['circuit'], engine)] = result

    tsv_path = os.path.join(OUT, 'results.tsv')
    with open(tsv_path, 'w') as f:
        f.write('\t'.join(COLUMNS) + '\n')
        for r in rows:
            f.write('\t'.join(str(r[c]) for c in COLUMNS) + '\n')
    print(f'wrote {tsv_path}')

    # Per-circuit engine-vs-engine comparisons via beauty.compare() -- the
    # "use it wherever a before/after or best-candidate comparison is made"
    # requirement. A pair with no result on either side (import failed, e.g.
    # every 'opt' row here needs Chromium) is recorded as not_run, never fed
    # into compare() as if it were a real 0/100.
    CMP_COLUMNS = ['circuit', 'a_engine', 'b_engine', 'status', 'metric', 'a', 'b', 'delta',
                   'a_missing', 'b_missing']
    cmp_rows = []
    circuits = sorted({name for name, _ in results})
    for name in circuits:
        for a_engine, b_engine in (('v1', 'v2'), ('v1', 'opt'), ('v2', 'opt')):
            a, b = results.get((name, a_engine)), results.get((name, b_engine))
            row = {c: '' for c in CMP_COLUMNS}
            row.update(circuit=name, a_engine=a_engine, b_engine=b_engine)
            if a is None or b is None:
                row['status'] = 'not_run (import failed on one or both sides)'
            else:
                cmp = beauty.compare(a, b)
                if 'error' in cmp:
                    row['status'] = cmp['error']
                    row['a_missing'] = ';'.join(cmp['a_missing'])
                    row['b_missing'] = ';'.join(cmp['b_missing'])
                else:
                    row['status'] = 'ok'
                    row['metric'] = cmp['metric']
                    row['a'] = cmp['a']
                    row['b'] = cmp['b']
                    row['delta'] = cmp['delta']
            cmp_rows.append(row)

    cmp_path = os.path.join(OUT, 'comparisons.tsv')
    with open(cmp_path, 'w') as f:
        f.write('\t'.join(CMP_COLUMNS) + '\n')
        for r in cmp_rows:
            f.write('\t'.join(str(r[c]) for c in CMP_COLUMNS) + '\n')
    print(f'wrote {cmp_path}')


if __name__ == '__main__':
    main()
