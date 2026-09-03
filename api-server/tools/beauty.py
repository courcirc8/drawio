#!/usr/bin/env python3
"""
beauty.py — score de qualité visuelle d'un schéma drawio.

Usage: beauty.py <doc.xml> <rendu.png> [reference.png]
Sortie: JSON {score, metrics{...}} sur stdout.

Deux sources de vérité :
 - géométrie XML (exacte) : croisements, coudes, longueurs, traversées de
   composants, alignements, compacité ;
 - OpenCV sur le PNG rendu : équilibre d'encre, et si une image de référence
   est fournie, SSIM + appariement ORB (ressemblance structurelle).
Les poids sont dans WEIGHTS (réglés par la boucle LLM).

CE QUE LE SCORE NE VOIT PAS (détail : tools/BEAUTY.md) — score() traite un
terme MANQUANT comme un terme PARFAIT, jamais comme "inconnu":
 - géométrie XML : toujours dispo si le XML est valide (aucune dépendance).
 - cv2 (ink_balance, ssim, orb_match) : demandent le PNG rendu (headless
   Chromium via lib/render.js — absent -> POST /beauty échoue tout court côté
   API ; en standalone, cv2.imread(None) -> cv_metrics() retourne {} au lieu
   de lever) ; ssim/orb_match demandent EN PLUS une image de référence.
 - flow_ok/rails_ok/pair_sym/mirror_row : calculés côté JS
   (lib/beauty.js:structuralMetrics), jamais en Python, transmis par le 4e
   argument CLI struct.json ; absents => score() les lit à 1 (poids combiné
   46/100+ compté comme parfait, la plus grosse ardoise silencieuse du score).
"""
import sys, json, math, xml.etree.ElementTree as ET


def is_junction_style(style):
    """Shared predicate (task B, 2026-08-31), mirrors tools/check.py's
    is_junction_cell() / lib/components.js's isJunctionCell(): true for our
    own `drawioApiJunction` marker OR a native drawio `shape=waypoint`
    vertex the user drew by hand. `style` here is the raw ';'-joined style
    string (this module doesn't build a key/value map), so match on tokens
    rather than substring to avoid a false hit on an unrelated key whose
    value happens to contain the word.
    """
    toks = style.split(';')
    return 'drawioApiJunction' in style or 'shape=waypoint' in toks


WEIGHTS = {
    'crossing': 6.0,        # par croisement fil-fil
    'through': 14.0,        # par segment traversant un composant sans s'y connecter
    'bend': 0.15,           # par angle droit (léger : un L est parfois inévitable)
    'excess_bend': 1.4,     # par coude AU-DELÀ du minimum géométrique du fil
                            # (0 si pins alignés, 1 sinon) : les évitements
                            # inutiles du routeur coûtent cher
    'too_close': 5.0,       # par paire de composants trop proches
    'label_on_wire': 3.0,   # par label barré par un fil
    'label_overlap': 4.0,   # par paire de labels qui se chevauchent
    'length': 1.5,          # par tranche de 1000 px de fil au-delà du minimum
    'misalign': 12.0,       # (1 - part de composants alignés)
    'unbalance': 8.0,       # écart-type normalisé de la densité d'encre
    'sprawl': 6.0,          # aire de la bbox vs aire "idéale"
    # structure (lisibilité humaine) — calculée côté JS (lib/beauty.js)
    'flow': 22.0,           # (1 - part des chaînes série haut->bas alignées)
    'rails': 10.0,          # (1 - part des masses en bas / taps VDD en haut)
    'pair_sym': 8.0,        # (1 - paires diff à la même hauteur)
    'mirror_row': 6.0,      # (1 - miroirs alignés sur leur diode)
}

def rot_pt(px, py, cx, cy, deg):
    t = math.radians(deg or 0)
    dx, dy = px - cx, py - cy
    return (cx + dx * math.cos(t) - dy * math.sin(t), cy + dx * math.sin(t) + dy * math.cos(t))

def load(xml_path):
    root = ET.parse(xml_path).getroot()
    model = root.find('.//mxGraphModel')
    cells = model.find('root')
    verts, edges = {}, []
    for outer in cells:
        # A component may be a bare <mxCell>, or an <object refdes=... > wrapper
        # around one (draw.io's "Edit Data" representation, which the api-server
        # now emits so that identity survives a GUI copy/paste). The wrapper puts
        # the mxCell one level DOWN, so the original `c.tag != 'mxCell': continue`
        # dropped every wrapped component from `verts` -- after which every edge
        # anchor resolved to None, polylines() skipped all of them, and n_wires
        # read 0. That silently zeroed EVERY geometry penalty (crossings, bends,
        # wire_length, too_close, labels): an empty drawing scores as a perfect
        # one. Unwrap here; the label lives on the wrapper, the rest on the cell.
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
        style = c.get('style') or ''
        g = c.find('mxGeometry')
        if c.get('vertex') == '1' and g is not None:
            rot = 0.0
            for tok in style.split(';'):
                if tok.startswith('rotation='):
                    rot = float(tok.split('=')[1])
            verts[cid] = {'value': label,
                          'vlp': next((tok.split('=')[1] for tok in style.split(';') if tok.startswith('verticalLabelPosition=')), None),
                          'x': float(g.get('x', 0)), 'y': float(g.get('y', 0)),
                          'w': float(g.get('width', 0)), 'h': float(g.get('height', 0)),
                          'rot': rot, 'junction': is_junction_style(style),
                          'is_text': style.startswith('text;'),
                          # api-server annotation layer (lib/annotate.js,
                          # task 2 2026-08-31): `apiAnnotation=1` marks a
                          # cell DECLARED inert -- decorative colour/text/
                          # amplifier-symbol geometry, never a real
                          # component. Without this, the PA/LNA blocks
                          # (real geometry now: a `shape=triangle` sized to
                          # ENCLOSE their own zone's real components, by
                          # design) get counted by `comps` below as 27
                          # ordinary bodies overlapping everything they
                          # enclose -- measured: through_component 35,
                          # too_close 17, tanking score_raw from -30-ish to
                          # -508.7 for a drawing tools/check.py itself
                          # reports as 0 errors / 12 warnings.
                          'is_annotation': 'apiAnnotation' in style,
                          'no_label': 'noLabel=1' in style,
                          'flipH': 'flipH=1' in style, 'flipV': 'flipV=1' in style}
        elif c.get('edge') == '1':
            st = dict(tok.split('=', 1) for tok in style.split(';') if '=' in tok)
            pts = []
            if g is not None:
                arr = g.find("Array[@as='points']")
                if arr is not None:
                    pts = [(float(p.get('x')), float(p.get('y'))) for p in arr.findall('mxPoint')]
            edges.append({'src': c.get('source'), 'tgt': c.get('target'), 'pts': pts, 'st': st,
                          'straight': st.get('edgeStyle') == 'none'})
    return verts, edges

def anchor(verts, cid, st, pref):
    v = verts.get(cid)
    if v is None:
        return None
    ax, ay = st.get(pref + 'X'), st.get(pref + 'Y')
    rx = float(ax) if ax is not None else 0.5
    ry = float(ay) if ay is not None else 0.5
    if v.get('flipH'): rx = 1 - rx
    if v.get('flipV'): ry = 1 - ry
    cx, cy = v['x'] + v['w'] / 2, v['y'] + v['h'] / 2
    return rot_pt(v['x'] + rx * v['w'], v['y'] + ry * v['h'], cx, cy, v['rot'])

def exit_axis(st, pref):
    ax, ay = st.get(pref + 'X'), st.get(pref + 'Y')
    if ax is None or ay is None:
        return None
    x, y = float(ax), float(ay)
    if x in (0.0, 1.0) and y not in (0.0, 1.0):
        return 'h'
    if y in (0.0, 1.0) and x not in (0.0, 1.0):
        return 'v'
    return None

def orthogonalize(pts, first_axis):
    """insère les coudes en équerre entre points non alignés (rendu
    orthogonalEdgeStyle) ; le premier tronçon suit l'axe de sortie du pin."""
    out = [pts[0]]
    axis = first_axis
    for p in pts[1:]:
        q = out[-1]
        if abs(p[0]-q[0]) < 0.5 or abs(p[1]-q[1]) < 0.5:
            out.append(p)
            axis = 'h' if abs(p[1]-q[1]) < 0.5 else 'v'
            continue
        if axis == 'v':
            out.append((q[0], p[1]))
        else:
            out.append((p[0], q[1]))
        out.append(p)
        axis = None
        axis = 'h' if abs(out[-1][1]-out[-2][1]) < 0.5 else 'v'
    return out

def polylines(verts, edges):
    out = []
    for e in edges:
        a = anchor(verts, e['src'], e['st'], 'exit')
        b = anchor(verts, e['tgt'], e['st'], 'entry')
        if a is None or b is None:
            continue
        pl = [a] + e['pts'] + [b]
        if e.get('straight'):
            out.append(pl)  # fil diagonal volontaire : rendu en ligne droite
        else:
            out.append(orthogonalize(pl, exit_axis(e['st'], 'exit')))
    return out

def seg_inter(p1, p2, p3, p4):
    def d(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
    d1, d2 = d(p3, p4, p1), d(p3, p4, p2)
    d3, d4 = d(p1, p2, p3), d(p1, p2, p4)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        t = d1 / (d1 - d2)
        return (p1[0] + t*(p2[0]-p1[0]), p1[1] + t*(p2[1]-p1[1]))
    return None

def near_junction(pt, verts, r=9):
    for v in verts.values():
        if v['junction']:
            cx, cy = v['x'] + v['w']/2, v['y'] + v['h']/2
            if abs(pt[0]-cx) <= r and abs(pt[1]-cy) <= r:
                return True
    return False

def edge_nets(edges, polys):
    """Union-find par position ABSOLUE des extrémités : deux fils du même
    net ne font pas un croisement, leurs superpositions ne comptent pas."""
    parent = {}
    def find(k):
        while parent.get(k, k) != k:
            k = parent[k]
        return k
    def union(a, b):
        parent.setdefault(a, a); parent.setdefault(b, b)
        parent[find(a)] = find(b)
    keys = []
    for e, pl in zip(edges, polys):
        ka = (e['src'], round(pl[0][0]/3), round(pl[0][1]/3))
        kb = (e['tgt'], round(pl[-1][0]/3), round(pl[-1][1]/3))
        union(ka, kb)
        keys.append(ka)
    return [find(k) for k in keys]

def xml_metrics(verts, edges):
    polys = polylines(verts, edges)
    nets = edge_nets(edges, polys)
    m = {}
    # coudes + longueur + coudes excédentaires (vs minimum géométrique)
    # (les self-loops de liaison diode sont un idiome délibéré, comme les
    # diagonales : exemptés)
    bends, excess, length = 0, 0, 0.0
    body_boxes = []
    for cid, v in verts.items():
        if v['junction'] or v.get('is_text') or v.get('is_annotation') or v['w'] < 12:
            continue
        t = math.radians(v['rot'] or 0)
        w = abs(v['w']*math.cos(t)) + abs(v['h']*math.sin(t))
        h = abs(v['w']*math.sin(t)) + abs(v['h']*math.cos(t))
        cx, cy = v['x']+v['w']/2, v['y']+v['h']/2
        body_boxes.append((cid, cx-w/2+1.5, cy-h/2+1.5, cx+w/2-1.5, cy+h/2-1.5))
    def seg_blocked(e, p, q):
        for cid, x1, y1, x2, y2 in body_boxes:
            if cid in (e['src'], e['tgt']):
                continue
            if max(p[0], q[0]) > x1 and min(p[0], q[0]) < x2 and \
               max(p[1], q[1]) > y1 and min(p[1], q[1]) < y2:
                return True
        return False
    for e, pl in zip(edges, polys):
        if e['src'] is not None and e['src'] == e['tgt']:
            continue
        dirs = []
        for (x1, y1), (x2, y2) in zip(pl, pl[1:]):
            length += math.hypot(x2-x1, y2-y1)
            if abs(x2-x1) < 0.5 and abs(y2-y1) < 0.5:
                continue
            dirs.append('h' if abs(x2-x1) >= abs(y2-y1) else 'v')
        wb = max(0, sum(1 for a, b in zip(dirs, dirs[1:]) if a != b))
        bends += wb
        if e.get('straight') or 'drawioApiFixedRoute' in e['st']:
            continue  # diagonales volontaires et tracés figés : pas d'excès
        a, z = pl[0], pl[-1]
        # minimum RÉALISABLE (règle 43) : droit s'il est libre, sinon L
        # s'il est libre, sinon le détour est optimal (pas d'excès)
        if abs(a[0]-z[0]) < 1 or abs(a[1]-z[1]) < 1:
            needed = 0 if not seg_blocked(e, a, z) else 2
        else:
            needed = 3
            for corner in ((a[0], z[1]), (z[0], a[1])):
                if not seg_blocked(e, a, corner) and not seg_blocked(e, corner, z):
                    needed = 1
                    break
        excess += max(0, wb - needed)
    m['bends'] = bends
    m['excess_bends'] = excess
    m['wire_length'] = round(length, 1)
    # BUG (fixed): was `sum(math.hypot(0, 0) for _ in comps)` — always 0.0,
    # a dead metric that neither summed anything real nor was fed by wires.
    # Intent per WEIGHTS['length'] comment ("par tranche de 1000 px de fil
    # au-delà du minimum"): the geometric lower bound on wire length is the
    # straight-line (Manhattan-free, Euclidean) distance between each wire's
    # two connection anchors, ignoring the actual routed path. score() below
    # now penalises wire_length beyond THIS real minimum instead of the old
    # `300*n_wires/3` flat per-wire budget, which had no relation to geometry.
    m['min_length'] = round(sum(math.hypot(pl[-1][0]-pl[0][0], pl[-1][1]-pl[0][1]) for pl in polys), 1)
    # croisements fil-fil (hors jonctions et hors extrémités partagées)
    cross_pts = set()
    for i in range(len(polys)):
        for j in range(i+1, len(polys)):
            if edges[i].get('straight') or edges[j].get('straight'):
                continue  # diagonale volontaire : ses croisements sont assumés
            if nets[i] == nets[j]:
                continue  # même net : superposition/té, pas un croisement
            for s1 in zip(polys[i], polys[i][1:]):
                for s2 in zip(polys[j], polys[j][1:]):
                    p = seg_inter(s1[0], s1[1], s2[0], s2[1])
                    if p is not None and not near_junction(p, verts):
                        ends = [s1[0], s1[1], s2[0], s2[1]]
                        if all(math.hypot(p[0]-e[0], p[1]-e[1]) > 3 for e in ends):
                            cross_pts.add((round(p[0]/3), round(p[1]/3)))
    m['crossings'] = len(cross_pts)
    # segments traversant un composant (hors ses propres terminaux)
    through = 0
    comps = [(cid, v) for cid, v in verts.items()
             if not v['junction'] and not v.get('is_text') and not v.get('is_annotation')]
    for e, pl in zip(edges, polys):
        for (x1, y1), (x2, y2) in zip(pl, pl[1:]):
            for cid, v in comps:
                if cid in (e['src'], e['tgt']):
                    continue
                # bbox tournée approx : AABB
                t = math.radians(v['rot'] or 0)
                w = abs(v['w']*math.cos(t)) + abs(v['h']*math.sin(t))
                h = abs(v['w']*math.sin(t)) + abs(v['h']*math.cos(t))
                cx, cy = v['x']+v['w']/2, v['y']+v['h']/2
                bx0, by0, bx1, by1 = cx-w/2+3, cy-h/2+3, cx+w/2-3, cy+h/2-3
                lo_x, hi_x = min(x1, x2), max(x1, x2)
                lo_y, hi_y = min(y1, y2), max(y1, y2)
                if hi_x < bx0 or lo_x > bx1 or hi_y < by0 or lo_y > by1:
                    continue
                # intersection RÉELLE segment-rectangle (les diagonales ne
                # doivent compter que si la ligne traverse vraiment le corps)
                inside = (bx0 <= x1 <= bx1 and by0 <= y1 <= by1) or                          (bx0 <= x2 <= bx1 and by0 <= y2 <= by1)
                if not inside:
                    rect_edges = [((bx0, by0), (bx1, by0)), ((bx1, by0), (bx1, by1)),
                                  ((bx1, by1), (bx0, by1)), ((bx0, by1), (bx0, by0))]
                    if not any(seg_inter((x1, y1), (x2, y2), a, b) for a, b in rect_edges):
                        continue
                through += 1
    m['through_component'] = through
    # alignement : part des composants partageant un axe (centre x ou y) avec un autre
    centers = [(v['x']+v['w']/2, v['y']+v['h']/2) for _, v in comps]
    aligned = 0
    for i, (cx, cy) in enumerate(centers):
        if any(i != j and (abs(cx-ox) < 5 or abs(cy-oy) < 5) for j, (ox, oy) in enumerate(centers)):
            aligned += 1
    m['align_ratio'] = round(aligned / max(1, len(centers)), 3)
    # compacité
    if comps:
        xs0 = min(v['x'] for _, v in comps); ys0 = min(v['y'] for _, v in comps)
        xs1 = max(v['x']+v['w'] for _, v in comps); ys1 = max(v['y']+v['h'] for _, v in comps)
        bbox = (xs1-xs0) * (ys1-ys0)
        ideal = sum(v['w']*v['h'] for _, v in comps) * 6  # ~facteur d'aération raisonnable
        m['sprawl'] = round(max(0.0, bbox/max(ideal, 1) - 1.0), 3)
    else:
        m['sprawl'] = 0.0
    # labels : près du device (ancré par drawio), mais JAMAIS sur un fil ni
    # sur un autre label
    def label_box(v):
        txt = v.get('value', '')
        if not txt or v.get('no_label'):
            return None
        if v.get('is_text') or v.get('is_annotation'):
            return (v['x'], v['y'], v['x']+v['w'], v['y']+v['h'])
        lw, lh = 7.2*len(txt)+6, 16
        cx = v['x'] + v['w']/2
        vlp = v.get('vlp')
        if vlp == 'top':
            cy = v['y'] - lh/2 - 2
        elif vlp == 'bottom' or vlp is None:
            # BUG (fixed): was `vlp == 'bottom' or vlp is None and False` —
            # `and` binds tighter than `or`, so `vlp is None and False` is
            # always False and this elif collapsed to `vlp == 'bottom'` only.
            # Every mxgraph.* shape emitted by lib/model.js:228 sets
            # verticalLabelPosition=bottom explicitly, so vlp is None only for
            # hand-edited cells or bare `style=` vertices (e.g. junctions) —
            # those should get the same "label below" placement, not fall
            # through to the centred-label case, which put the estimated
            # label box at the wrong y for those cells.
            cy = v['y'] + v['h'] + lh/2 + 2
        else:
            cy = v['y'] + v['h']/2
        return (cx-lw/2, cy-lh/2, cx+lw/2, cy+lh/2)
    lboxes = []
    for cid, v in verts.items():
        lb = label_box(v)
        if lb is not None:
            lboxes.append((cid, lb))
    lab_wire = 0
    for cid, lb in lboxes:
        hit = False
        for e, pl in zip(edges, polys):
            if cid in (e['src'], e['tgt']):
                # BUG (fixed): was a bare `pass`, so this component's own wire
                # was never excluded and fell through into the segment-vs-box
                # test below. A wire legitimately terminates inside/next to its
                # own component's label anchor, so it always "hit" the label
                # box — inflating label_on_wire for essentially every labelled
                # component with a connection. `continue` skips this edge.
                continue
            for (x1, y1), (x2, y2) in zip(pl, pl[1:]):
                if max(x1, x2) < lb[0] or min(x1, x2) > lb[2] or max(y1, y2) < lb[1] or min(y1, y2) > lb[3]:
                    continue
                hit = True
                break
            if hit:
                break
        if hit:
            lab_wire += 1
    m['label_on_wire'] = lab_wire
    lab_overlap = 0
    for i in range(len(lboxes)):
        a = lboxes[i][1]
        for j in range(i+1, len(lboxes)):
            bb = lboxes[j][1]
            if a[0] < bb[2] and a[2] > bb[0] and a[1] < bb[3] and a[3] > bb[1]:
                lab_overlap += 1
    m['label_overlap'] = lab_overlap
    # promiscuité : paires de composants dont les AABB (gonflées de 12 px)
    # se chevauchent — un schéma humain respire
    def aabb(v, margin):
        t = math.radians(v['rot'] or 0)
        w = abs(v['w']*math.cos(t)) + abs(v['h']*math.sin(t))
        h = abs(v['w']*math.sin(t)) + abs(v['h']*math.cos(t))
        cx, cy = v['x']+v['w']/2, v['y']+v['h']/2
        return (cx-w/2-margin, cy-h/2-margin, cx+w/2+margin, cy+h/2+margin)
    close = 0
    for i in range(len(comps)):
        a = aabb(comps[i][1], 6)
        for j in range(i+1, len(comps)):
            bb = aabb(comps[j][1], 6)
            if a[0] < bb[2] and a[2] > bb[0] and a[1] < bb[3] and a[3] > bb[1]:
                close += 1
    m['too_close'] = close
    m['n_wires'] = len(polys)
    m['n_components'] = len(comps)
    return m

def cv_metrics(png_path, ref_path=None):
    import cv2, numpy as np
    m = {}
    img = cv2.imread(png_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return m
    ink = (img < 200).astype(np.uint8)
    H, W = ink.shape
    gs = 8
    cells = []
    for gy in range(gs):
        for gx in range(gs):
            c = ink[gy*H//gs:(gy+1)*H//gs, gx*W//gs:(gx+1)*W//gs]
            cells.append(float(c.mean()))
    occ = [c for c in cells if c > 0.001]
    m['ink_balance'] = round(float(np.std(occ) / (np.mean(occ) + 1e-9)), 3) if occ else 0.0
    if ref_path:
        ref = cv2.imread(ref_path, cv2.IMREAD_GRAYSCALE)
        if ref is not None:
            a = cv2.resize(img, (512, 512)); b = cv2.resize(ref, (512, 512))
            a = cv2.GaussianBlur(a.astype(np.float64), (11, 11), 1.5)
            bb = cv2.GaussianBlur(b.astype(np.float64), (11, 11), 1.5)
            mu1, mu2 = a.mean(), bb.mean()
            s1, s2 = a.var(), bb.var()
            s12 = ((a-mu1)*(bb-mu2)).mean()
            C1, C2 = (0.01*255)**2, (0.03*255)**2
            m['ssim'] = round(float(((2*mu1*mu2+C1)*(2*s12+C2)) / ((mu1**2+mu2**2+C1)*(s1+s2+C2))), 3)
            orb = cv2.ORB_create(500)
            k1, d1 = orb.detectAndCompute(img, None)
            k2, d2 = orb.detectAndCompute(ref, None)
            if d1 is not None and d2 is not None and len(k1) and len(k2):
                bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
                good = [x for x in bf.match(d1, d2) if x.distance < 40]
                m['orb_match'] = round(len(good) / max(len(k1), len(k2)), 3)
    return m

# Each entry: (WEIGHTS key, metric keys it needs, penalty(m) in the same
# units as WEIGHTS — i.e. multiplied by the weight inside score()).
# A term counts as "missing" (never "computed to be zero") iff ANY of its
# metric keys is absent from `m`. This is what lets score() tell "perfect"
# apart from "never evaluated" — see the module docstring and tools/BEAUTY.md.
SCORE_TERMS = [
    ('crossing',      ('crossings',),               lambda m: m['crossings']),
    ('through',       ('through_component',),       lambda m: m['through_component']),
    ('bend',          ('bends',),                    lambda m: m['bends']),
    ('excess_bend',   ('excess_bends',),             lambda m: m['excess_bends']),
    ('too_close',     ('too_close',),                lambda m: m['too_close']),
    ('label_on_wire', ('label_on_wire',),            lambda m: m['label_on_wire']),
    ('label_overlap', ('label_overlap',),            lambda m: m['label_overlap']),
    ('length',        ('wire_length', 'min_length'), lambda m: max(0.0, m['wire_length'] - m['min_length']) / 1000),
    ('misalign',      ('align_ratio',),              lambda m: 1 - m['align_ratio']),
    ('unbalance',     ('ink_balance',),               lambda m: m['ink_balance']),
    ('sprawl',        ('sprawl',),                    lambda m: m['sprawl']),
    ('flow',          ('flow_ok',),                   lambda m: 1 - m['flow_ok']),
    ('rails',         ('rails_ok',),                  lambda m: 1 - m['rails_ok']),
    ('pair_sym',      ('pair_sym',),                  lambda m: 1 - m['pair_sym']),
    ('mirror_row',    ('mirror_row',),                lambda m: 1 - m['mirror_row']),
]
# Metric keys that feed a SCORE_TERMS entry, plus ssim/orb_match which are
# purely informational (no WEIGHTS entry) but were also silently absent
# whenever no reference PNG was given — surfaced the same way in `metrics`.
_ALL_METRIC_KEYS = sorted({k for _, needs, _ in SCORE_TERMS for k in needs} | {'ssim', 'orb_match'})

def score(m):
    """
    Returns a dict, NOT a bare number — see the module docstring and
    tools/BEAUTY.md ("what the score cannot see"). Chosen design (option B
    of the two the task offered): report `score_partial` + `missing_weight`
    and refuse to call an incomplete result `score`, rather than a
    best/worst RANGE. A range needs a defensible "worst case" per term;
    that is well-defined for the four bounded (1 - ratio) structural terms
    (worst = the full weight) but NOT for the count-based geometry terms
    (crossings, bends, wire_length, …) which have no natural ceiling — and
    in practice those are the ones that are never actually missing (they
    come straight from the XML). Inventing an arbitrary ceiling just to
    fill in a range that will never be exercised was rejected as spurious
    precision; `score_partial` says exactly what was measured, no more.

    Fields:
      score_partial   — always present; computed ONLY over evaluated terms.
      score           — present ONLY when missing_weight == 0.0 (nothing was
                         skipped); this is the drop-in replacement for the
                         old bare-float return, so a caller that only ever
                         checks for `score` gets the old all-or-nothing
                         guarantee back for free instead of silently reading
                         a number computed over a different term set.
      evaluated_weight / missing_weight — sum of WEIGHTS actually applied /
                         skipped; missing_weight + evaluated_weight ==
                         sum(WEIGHTS.values()) always.
      missing_terms   — WEIGHTS keys that were skipped, e.g. ['flow',
                         'rails', 'pair_sym', 'mirror_row', 'unbalance']
                         when no PNG/struct.json was supplied. This is the
                         "say what you dropped" fix from AGENTS.md domain
                         correction #13 (verdict-ceiling-hidden-by-dc-blocks
                         is the prior incident this generalises from).
    """
    s = 100.0
    evaluated_weight = 0.0
    missing_weight = 0.0
    missing_terms = []
    for weight_key, needs, penalty_fn in SCORE_TERMS:
        w = WEIGHTS[weight_key]
        if any(k not in m for k in needs):
            missing_terms.append(weight_key)
            missing_weight += w
            continue
        evaluated_weight += w
        s -= w * penalty_fn(m)
    score_partial = round(max(0.0, min(100.0, s)), 1)
    # BUG (2026-08-28): score_partial's clamp to [0,100] destroys the gradient
    # once total penalties exceed 100 -- which is every RF matching netlist,
    # since through_component alone is weighted 14/hit and a rough ladder
    # layout racks up several. lib/optimize.js hill-climbs on `score`, so
    # every candidate clamped to identical 0.0 was indistinguishable and the
    # optimizer accepted none of them (?optimize=N returned the unoptimized
    # import byte-for-byte). score_raw is `s` BEFORE the clamp, over the same
    # evaluated terms as score_partial -- may be negative, may exceed 100 --
    # so a caller that needs the gradient (the optimizer) can use it while
    # score_partial/score keep their existing human-facing [0,100] meaning.
    # Honesty about missing terms is carried by the existing missing_weight/
    # missing_terms fields alongside this one, exactly as for score_partial.
    score_raw = round(s, 1)
    out = {
        'score_partial': score_partial,
        'score_raw': score_raw,
        'evaluated_weight': round(evaluated_weight, 2),
        'missing_weight': round(missing_weight, 2),
        'missing_terms': missing_terms,
    }
    if missing_weight == 0.0:
        out['score'] = score_partial
    return out

def compare(result_a, result_b):
    """
    Refuse to compare two score() result dicts whose `missing_terms` sets
    differ — comparing e.g. an 87.1 computed over all 15 terms with an 87.1
    computed over 11 of them (4 structural terms silently defaulted to
    "perfect") is exactly the trap this exists to catch. Use this wherever a
    before/after or best-candidate comparison is made (see
    tools/gen_baseline.py's per-circuit v1/v2/opt comparisons).

    Returns {'error': ...} rather than raising, so a caller iterating many
    candidates can log-and-skip an incomparable pair instead of aborting the
    whole run on one bad comparison.
    """
    ma, mb = set(result_a.get('missing_terms', [])), set(result_b.get('missing_terms', []))
    if ma != mb:
        return {'error': 'incomparable: missing_terms differ',
                'a_missing': sorted(ma), 'b_missing': sorted(mb)}
    key = 'score' if ('score' in result_a and 'score' in result_b) else 'score_partial'
    a_val, b_val = result_a[key], result_b[key]
    return {'metric': key, 'a': a_val, 'b': b_val, 'delta': round(b_val - a_val, 1),
            'missing_terms': sorted(ma)}

if __name__ == '__main__':
    xml_path, png_path = sys.argv[1], sys.argv[2]
    ref = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != '-' else None
    verts, edges = load(xml_path)
    m = xml_metrics(verts, edges)
    if png_path != '-':
        m.update(cv_metrics(png_path, ref))
    if len(sys.argv) > 4:
        m.update(json.load(open(sys.argv[4])))
    result = score(m)
    # `metrics` gets the same explicit 'unavailable' marker for every metric
    # key a score term needed but `m` doesn't have, so it reads consistently
    # whether inspected on its own or via `missing_terms` above.
    metrics_out = dict(m)
    for k in _ALL_METRIC_KEYS:
        metrics_out.setdefault(k, 'unavailable')
    print(json.dumps({**result, 'metrics': metrics_out, 'weights': WEIGHTS}))
