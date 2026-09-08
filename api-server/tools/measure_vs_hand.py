#!/usr/bin/env python3
"""
measure_vs_hand.py — distance-to-human-placement metrics for a generated
matching-network schematic, INDEPENDENT of beauty.py's score() (which is a
known-broken arbiter: 26 warnings scored 58.5, 23 warnings scored 37.1 on the
same 915 sheet — see beauty.py's own module docstring / BEAUTY.md). This tool
never aggregates into one number. It reuses beauty.py's xml_metrics() for
crossings/bends/wire_length (those ARE reliable — pure XML geometry, no cv2,
no weighting) and adds its own refdes-matched centroid distance, differential
symmetry and left-to-right flow-monotonicity checks against the frozen
hand-drawn reference JSON (seeds/matching_<band>_hand.json).

Matching rule (see AGENTS.md domain correction #1 — map by NAME, never by
recomputed index): every candidate component is matched to the reference by
its drawn REFDES label (the `value` on the mxCell/object, e.g. "C4"), never
by list position. A reference component absent from the candidate (or vice
versa) is reported explicitly under `unmatched_reference` / `unmatched_candidate`
— never silently dropped from the median/worst-case computation (AGENTS.md
domain correction #13: an aggregate must name what it excluded).

Usage:
  measure_vs_hand.py candidate.drawio reference_seed.json [--diffpairs Bp,Bn rx_Bp,rx_Bn] [--json]

Output: JSON on stdout with keys:
  centroid: {matched: N, unmatched_reference: [...], unmatched_candidate: [...],
             median_norm: float, worst_norm: float, worst_refdes: str,
             diag_px: float, per_component: {refdes: norm_dist}}
  wiring: {crossings, bends, wire_length, min_length} (from beauty.xml_metrics)
  diffpairs: {"Bp/Bn": {dy_px: float, cy_a: .., cy_b: ..}, ...}
  flow: {reversed_edges: int, total_directed_edges: int, reversed_pairs: [[src,tgt],...]}
"""
import sys
import os
import json
import math
import argparse
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import beauty  # noqa: E402  (tools/beauty.py — reused for xml_metrics only, never score())


def load_candidate(xml_path):
    """Wrapper-aware cell parse (mirrors tools/check.py::_cells and
    beauty.py::load) that ALSO keeps the raw `shape=` style key, which
    beauty.load() discards — this tool needs it to tell an actual component
    body apart from a `shape=port` net label."""
    tree = ET.parse(xml_path)
    root = tree.getroot()
    model = root if root.tag == 'mxGraphModel' else root.find('.//mxGraphModel')
    if model is None:
        raise SystemExit(f'no mxGraphModel in {xml_path}')
    cells_root = model.find('root')
    verts = {}
    for outer in cells_root:
        if outer.tag == 'object':
            c = outer.find('mxCell')
            if c is None:
                continue
            cid = outer.get('id')
            label = outer.get('label') or ''
        elif outer.tag == 'mxCell':
            c = outer
            cid = c.get('id')
            label = c.get('value') or ''
        else:
            continue
        g = c.find('mxGeometry')
        if c.get('vertex') != '1' or g is None:
            continue
        style = c.get('style') or ''
        smap = dict(tok.split('=', 1) for tok in style.split(';') if '=' in tok)
        x, y = float(g.get('x', 0)), float(g.get('y', 0))
        w, h = float(g.get('width', 0)), float(g.get('height', 0))
        # BUG (fixed while writing this script): a component's `value`/label
        # carries the refdes AND its spice value stacked on a second line
        # (e.g. "C4\n1.7 pF" — see the exported XML), so matching the raw
        # label against the hand-reference JSON's bare refdes keys ("C4")
        # matched NOTHING — every single component came back "unmatched" on
        # both sides. Split on the first newline and keep only the refdes.
        refdes = label.split('\n', 1)[0].strip()
        # Port cells are tagged `apiShape=port` (a SYNTHETIC style key,
        # lib/components.js PORT_SHAPES comment: real drawio `shape=port`
        # collides with an upstream stencil), never a bare `shape=port`.
        # Checking only `shape` here made every port cell (Bp, Bn, ANT, …)
        # register as an ordinary device body, so it entered the refdes
        # centroid comparison (as a spurious "unmatched_candidate" entry)
        # AND the flow-monotonicity walk treated port glyphs as signal-chain
        # nodes.
        verts[cid] = {
            'id': cid, 'value': refdes, 'x': x, 'y': y, 'w': w, 'h': h,
            'cx': x + w / 2.0, 'cy': y + h / 2.0,
            'shape': smap.get('shape', ''),
            'is_port': smap.get('shape') == 'port' or smap.get('apiShape') == 'port',
            'is_junction': beauty.is_junction_style(style),
            'is_text': style.startswith('text;'),
            'is_annotation': 'apiAnnotation' in smap,
        }
    edges = []
    for outer in cells_root:
        c = outer if outer.tag == 'mxCell' else (outer.find('mxCell') if outer.tag == 'object' else None)
        if c is None or c.get('edge') != '1':
            continue
        edges.append({'src': c.get('source'), 'tgt': c.get('target')})
    return verts, edges


def is_device_body(v):
    """A real placed component: not a port label, not a junction dot, not
    text/annotation ink, and wide enough to not be a stray artefact (same
    12px floor beauty.py's xml_metrics uses to exclude degenerate cells)."""
    return (not v['is_port'] and not v['is_junction'] and not v['is_text']
            and not v['is_annotation'] and v['w'] >= 12 and v['value'])


def centroid_metrics(cand_verts, ref_devices, canvas):
    """Median + worst-case centroid distance, matched by REFDES (never by
    index — AGENTS.md domain correction #1), normalized by the reference
    canvas diagonal so 915/2446 (different canvas sizes) are comparable."""
    diag = math.hypot(canvas[0], canvas[1])
    cand_by_ref = {}
    for v in cand_verts.values():
        if is_device_body(v):
            # A refdes can legitimately repeat only if the placer duplicated
            # a label — keep the first occurrence and flag collisions loudly
            # rather than silently overwriting (never assume it's a wrapper
            # duplicate of the same physical instance).
            if v['value'] in cand_by_ref:
                cand_by_ref.setdefault('__dup__', []).append(v['value'])
            else:
                cand_by_ref[v['value']] = v
    dups = cand_by_ref.pop('__dup__', [])
    matched = {}
    unmatched_ref = []
    for refdes, dev in ref_devices.items():
        if refdes in cand_by_ref:
            c = cand_by_ref[refdes]
            d = math.hypot(c['cx'] - dev['cx'], c['cy'] - dev['cy'])
            matched[refdes] = d / diag if diag > 0 else float('nan')
        else:
            unmatched_ref.append(refdes)
    unmatched_cand = [r for r in cand_by_ref if r not in ref_devices]
    vals = sorted(matched.values())
    n = len(vals)
    median = vals[n // 2] if n % 2 == 1 else (vals[n // 2 - 1] + vals[n // 2]) / 2.0 if n else float('nan')
    worst_ref = max(matched, key=matched.get) if matched else None
    return {
        'matched': n,
        'unmatched_reference': unmatched_ref,
        'unmatched_candidate': unmatched_cand,
        'duplicate_refdes_in_candidate': dups,
        'median_norm': round(median, 5) if matched else None,
        'worst_norm': round(matched[worst_ref], 5) if worst_ref else None,
        'worst_refdes': worst_ref,
        'diag_px': round(diag, 1),
        'per_component': {k: round(v, 5) for k, v in matched.items()},
    }


def diffpair_metrics(cand_verts, pairs):
    """Vertical (Y) separation between the two ports of a declared
    differential pair (e.g. Bp/Bn). This is a proxy for "does the placer
    keep a diff pair on a shared row" — it does NOT check that the two
    traces are equal length or that intermediate components mirror; that
    is out of scope here (see task's OUT-OF-SCOPE list: no attempt to
    reproduce section colouring / intent). A pair whose ports don't both
    exist as `shape=port` cells is reported as unavailable, not as 0."""
    out = {}
    ports_by_name = {}
    for v in cand_verts.values():
        if v['is_port'] and v['value']:
            ports_by_name.setdefault(v['value'], []).append(v)
    for a, b in pairs:
        key = f'{a}/{b}'
        pa, pb = ports_by_name.get(a), ports_by_name.get(b)
        if not pa or not pb:
            out[key] = {'available': False, 'reason': f'port(s) not found: '
                        f'{a if not pa else ""} {b if not pb else ""}'.strip()}
            continue
        # If a net's port glyph is drawn more than once (fanned to two
        # instances), compare the closest pair rather than an arbitrary one.
        best = min(((x, y) for x in pa for y in pb),
                   key=lambda xy: math.hypot(xy[0]['cx'] - xy[1]['cx'], xy[0]['cy'] - xy[1]['cy']))
        out[key] = {'available': True, 'dy_px': round(abs(best[0]['cy'] - best[1]['cy']), 1),
                    'dx_px': round(abs(best[0]['cx'] - best[1]['cx']), 1),
                    'cy_a': round(best[0]['cy'], 1), 'cy_b': round(best[1]['cy'], 1)}
    return out


def flow_monotonicity(cand_verts, edges):
    """Proxy for left-to-right signal flow: for every wire directly joining
    two REAL device bodies (not via a junction dot), flag it as "reversed"
    if its target sits to the LEFT of its source by more than a small
    tolerance. This assumes the netlist's own node order (src listed before
    tgt on each SPICE line, which is also edge src/tgt here) encodes
    upstream->downstream — true for this Pi-ladder-style netlist (source
    net first, ANT/load last) but NOT a general electrical fact; it is a
    heuristic proxy, not a source-to-load graph traversal, and is reported
    as such."""
    tol = 8.0  # px slack — small backward jogs from routing are not "reversed flow"
    reversed_pairs = []
    directed = 0
    for e in edges:
        s, t = cand_verts.get(e['src']), cand_verts.get(e['tgt'])
        if s is None or t is None:
            continue
        if not is_device_body(s) or not is_device_body(t):
            continue
        directed += 1
        if t['cx'] < s['cx'] - tol:
            reversed_pairs.append([s['value'], t['value']])
    return {'reversed_edges': len(reversed_pairs), 'total_directed_edges': directed,
            'reversed_pairs': reversed_pairs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('candidate')
    ap.add_argument('reference_json')
    ap.add_argument('--diffpairs', nargs='*', default=['Bp,Bn', 'rx_Bp,rx_Bn'])
    args = ap.parse_args()

    ref = json.load(open(args.reference_json))
    cand_verts, cand_edges = load_candidate(args.candidate)

    # wiring metrics: reuse beauty.py's xml_metrics verbatim (it already
    # excludes junctions/text/annotations and handles wrapped <object> cells)
    b_verts, b_edges = beauty.load(args.candidate)
    wiring = beauty.xml_metrics(b_verts, b_edges)
    wiring = {k: wiring[k] for k in ('crossings', 'bends', 'excess_bends', 'wire_length', 'min_length')}

    pairs = [tuple(p.split(',')) for p in args.diffpairs]

    result = {
        'candidate': args.candidate,
        'reference': args.reference_json,
        'centroid': centroid_metrics(cand_verts, ref['devices'], ref['canvas']),
        'wiring': wiring,
        'diffpairs': diffpair_metrics(cand_verts, pairs),
        'flow': flow_monotonicity(cand_verts, cand_edges),
    }
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
