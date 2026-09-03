#!/usr/bin/env python3
"""
PIXEL regression test for DEFECT A (2026-08-31): a wire endpoint anchored on
a hidden junction/dot cell used to get no explicit exit/entry anchor, so
mxGraph resolved the connection via the shape's floating PERIMETER instead of
its centre -- two wires reaching the dot from opposite directions landed on
two different points of its rim, leaving a real gap in the conductor
wherever the dot's glyph is hidden (a genuine 2-way pass-through, painted
transparent by lib/route.js::hideDegenerateJunctions()).

This is a full round-trip test on the REAL file the defect was found on
(test/fixtures/matching_2446_hand_in.drawio, cell `J_Bp`), not a synthetic
fixture: it boots the actual server, replays the exact repro sequence
(xml import -> POST /rewire -> GET model -> GET PNG export), and inspects
actual rendered pixels -- the only ground truth for what mxGraph paints,
per the "three disagreeing label-geometry models" lesson in lib/annotate.js
(a model's own idea of where something lands is not proof of the render).

Requires a working headless Chromium (see lib/render.js::findChrome()); skips
(exit 0) if PNG export comes back with anything other than 200, the same
"skip, don't fail, on an absent dependency" contract test/e2e.test.js uses.

Run with the PySpectre venv (has PIL/requests), NOT $CURSOR_TOOLS_PYTHON:
  /eda/dm/home/evandel/CURSOR/PySpectre/venv/bin/python test/test_defect_a_pixel.py

MUTATION-TESTED: reverting lib/rewire.js::mkEdge()'s dot-end anchor back to
`undefined` (the pre-fix code) reproduces the exact gap this test asserts
against -- x=640..651 (12 px) on rows 85/86 of the ORIGINAL repro's PNG,
independently confirmed by re-running the subject's own curl sequence before
writing this test. Confirmed RED against that mutation while developing the
fix (see the coder's report); this script re-derives the row/col from
geometry on THIS run rather than hard-coding those numbers, since the exact
pixel offsets are a function of the whole document's bounding box and are
not guaranteed byte-stable across otherwise-equivalent runs (id allocation
order, float rounding in the router).
"""
import json
import os
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

import requests
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
API_SERVER = os.path.dirname(HERE)
BUN = '/eda/dm/home/evandel/CURSOR/Tools/bun/bin/bun'
FIXTURE = os.path.join(HERE, 'fixtures', 'matching_2446_hand_in.drawio')
GOLDEN_CIR = ('/eda/dm/home/evandel/CURSOR/PySpectre/Match_BOM_optimizer/'
              'multi_agent_opt/rf_schematics/golden/matching_2446.cir')
PORT = 8771
BASE = f'http://127.0.0.1:{PORT}'


def wait_healthy(proc, timeout_s=15):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if proc.poll() is not None:
            raise RuntimeError('server exited early')
        try:
            r = requests.get(f'{BASE}/health', timeout=1)
            if r.ok:
                return
        except requests.exceptions.RequestException:
            pass
        time.sleep(0.2)
    raise RuntimeError('server did not become healthy')


def model_bbox(root):
    """Bounding box over every mxGeometry (vertex boxes AND edge waypoints),
    matching what server.js/render.js feeds the export (see model.js's own
    'measured min x = -166, min y = -52' normalizeOrigin comment for the same
    kind of bbox computation elsewhere in this codebase)."""
    xs, ys = [], []
    for g in root.iter('mxGeometry'):
        x, y, w, h = g.get('x'), g.get('y'), g.get('width'), g.get('height')
        if x is not None and w is not None:
            x, y, w, h = float(x), float(y or 0), float(w), float(h or 0)
            xs += [x, x + w]
            ys += [y, y + h]
        for pt in g.findall('Array/mxPoint'):
            xs.append(float(pt.get('x')))
            ys.append(float(pt.get('y')))
    return min(xs), min(ys), max(xs), max(ys)


def main():
    assert os.path.isfile(FIXTURE), FIXTURE
    assert os.path.isfile(GOLDEN_CIR), GOLDEN_CIR

    proc = subprocess.Popen(
        [BUN, os.path.join(API_SERVER, 'server.js'), '--port', str(PORT)],
        cwd=API_SERVER, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        wait_healthy(proc)

        with open(FIXTURE, 'rb') as f:
            created = requests.post(f'{BASE}/documents', data=f.read(),
                                     headers={'content-type': 'application/xml'}).json()
        did = created['id']

        with open(GOLDEN_CIR, 'rb') as f:
            rewire_resp = requests.post(f'{BASE}/documents/{did}/rewire?allowFlip=1',
                                         data=f.read(),
                                         headers={'content-type': 'text/plain'}).json()
        assert rewire_resp['lvs']['match'] is True, rewire_resp
        assert rewire_resp['unreachable'] == [], rewire_resp

        xml_text = requests.get(f'{BASE}/documents/{did}').text
        root = ET.fromstring(xml_text)
        j_bp = next(c for c in root.iter('mxCell') if c.get('id') == 'J_Bp')
        g = j_bp.find('mxGeometry')
        jx, jy = float(g.get('x')), float(g.get('y'))
        jw, jh = float(g.get('width')), float(g.get('height'))
        cx, cy = jx + jw / 2, jy + jh / 2  # J_Bp's centre, in MODEL coordinates

        minx, miny, _, _ = model_bbox(root)

        r = requests.get(f'{BASE}/documents/{did}/export', params={'format': 'png', 'scale': 2})
        if r.status_code != 200:
            print(f'  skipped: PNG export unavailable (status {r.status_code}, '
                  f'likely no Chromium) -- {r.text[:200]}')
            return

        # server.js's export route: border defaults to 10 (model units, added
        # BEFORE the scale multiply), scale defaults to 2 -- see
        # app.get('/documents/:id/export') in server.js. This is the same
        # mapping verified by hand against the original repro's PNG (model
        # (541,189) -> pixel (642,84), matching the reported (640-651, 85-86)
        # to within antialiasing) before this script existed.
        border, scale = 10, 2
        px = round((cx - minx + border) * scale)
        py = round((cy - miny + border) * scale)

        png_path = '/tmp/defect_a_pixel_test.png'
        with open(png_path, 'wb') as f:
            f.write(r.content)
        im = Image.open(png_path).convert('RGB')
        pix = im.load()

        def is_white(x, y):
            p = pix[x, y]
            return p[0] > 250 and p[1] > 250 and p[2] > 250

        # First LOCATE the conductor row near the dot: scanning a window
        # blindly and taking the "worst" white run is wrong -- rows just
        # above/below the wire are legitimate all-white background and would
        # always win that comparison (measured: a naive scan of py-3..py+3
        # picked a background row with an 80px run before this was fixed).
        # A conductor row is identified by requiring DARK pixels flanking the
        # dot's column on BOTH sides at a safe distance (>=15px, clear of the
        # dot's own ~6px-wide glyph footprint at scale=2) -- i.e. proof this
        # row actually carries the horizontal rail through the dot, not mere
        # proximity to its y-coordinate.
        flank = 15
        search_half_x = 40
        x_lo, x_hi = max(0, px - search_half_x), min(im.width, px + search_half_x)
        conductor_row = None
        for row in range(max(0, py - 5), min(im.height, py + 6)):
            left_dark = any(not is_white(x, row) for x in range(x_lo, max(x_lo, px - flank)))
            right_dark = any(not is_white(x, row) for x in range(min(x_hi, px + flank), x_hi))
            if left_dark and right_dark:
                conductor_row = row
                break
        assert conductor_row is not None, (
            f'could not locate the horizontal conductor near J_Bp (pixel~({px},{py})) '
            f'-- fixture/geometry may have changed; this test needs re-deriving, not skipping')

        # NOW check that same row for a white gap in the IMMEDIATE vicinity
        # of the dot's own column (+/- a bit beyond its glyph footprint) --
        # this is where DEFECT A's rim-vs-centre mismatch actually opened a
        # hole (measured: 12px at scale=2 on the original repro, exactly the
        # dot's own model width of 6px x scale 2).
        near_lo, near_hi = px - flank, px + flank
        run, worst = 0, 0
        for x in range(near_lo, near_hi):
            if is_white(x, conductor_row):
                run += 1
                worst = max(worst, run)
            else:
                run = 0

        print(f'J_Bp centre: model=({cx},{cy}) -> pixel=({px},{py}); '
              f'conductor row={conductor_row}; longest white run within +/-{flank}px: {worst}px')
        assert worst <= 4, (
            f'DEFECT A regressed: a white run of {worst}px interrupts the conductor '
            f'at row {conductor_row} within {flank}px of J_Bp (pixel x={px})')
        print('PASS: no white-run gap at J_Bp -- DEFECT A stays fixed')
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == '__main__':
    main()
