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
"""
import sys, json, math, xml.etree.ElementTree as ET

WEIGHTS = {
    'crossing': 6.0,        # par croisement fil-fil
    'through': 10.0,        # par segment traversant un composant
    'bend': 0.8,            # par coude au-delà de 2 par fil
    'length': 1.5,          # par tranche de 1000 px de fil au-delà du minimum
    'misalign': 12.0,       # (1 - part de composants alignés)
    'unbalance': 8.0,       # écart-type normalisé de la densité d'encre
    'sprawl': 6.0,          # aire de la bbox vs aire "idéale"
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
    for c in cells:
        if c.tag != 'mxCell':
            continue
        cid = c.get('id')
        style = c.get('style') or ''
        g = c.find('mxGeometry')
        if c.get('vertex') == '1' and g is not None:
            rot = 0.0
            for tok in style.split(';'):
                if tok.startswith('rotation='):
                    rot = float(tok.split('=')[1])
            verts[cid] = {'x': float(g.get('x', 0)), 'y': float(g.get('y', 0)),
                          'w': float(g.get('width', 0)), 'h': float(g.get('height', 0)),
                          'rot': rot, 'junction': 'drawioApiJunction' in style}
        elif c.get('edge') == '1':
            st = dict(tok.split('=', 1) for tok in style.split(';') if '=' in tok)
            pts = []
            if g is not None:
                arr = g.find("Array[@as='points']")
                if arr is not None:
                    pts = [(float(p.get('x')), float(p.get('y'))) for p in arr.findall('mxPoint')]
            edges.append({'src': c.get('source'), 'tgt': c.get('target'), 'pts': pts, 'st': st})
    return verts, edges

def anchor(verts, cid, st, pref):
    v = verts.get(cid)
    if v is None:
        return None
    ax, ay = st.get(pref + 'X'), st.get(pref + 'Y')
    rx = float(ax) if ax is not None else 0.5
    ry = float(ay) if ay is not None else 0.5
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

def xml_metrics(verts, edges):
    polys = polylines(verts, edges)
    m = {}
    # coudes + longueur
    bends, length = 0, 0.0
    for pl in polys:
        dirs = []
        for (x1, y1), (x2, y2) in zip(pl, pl[1:]):
            length += math.hypot(x2-x1, y2-y1)
            if abs(x2-x1) < 0.5 and abs(y2-y1) < 0.5:
                continue
            dirs.append('h' if abs(x2-x1) >= abs(y2-y1) else 'v')
        bends += max(0, sum(1 for a, b in zip(dirs, dirs[1:]) if a != b))
    m['bends'] = bends
    m['wire_length'] = round(length, 1)
    # croisements fil-fil (hors jonctions et hors extrémités partagées)
    crossings = 0
    for i in range(len(polys)):
        for j in range(i+1, len(polys)):
            for s1 in zip(polys[i], polys[i][1:]):
                for s2 in zip(polys[j], polys[j][1:]):
                    p = seg_inter(s1[0], s1[1], s2[0], s2[1])
                    if p is not None and not near_junction(p, verts):
                        ends = [s1[0], s1[1], s2[0], s2[1]]
                        if all(math.hypot(p[0]-e[0], p[1]-e[1]) > 3 for e in ends):
                            crossings += 1
    m['crossings'] = crossings
    # segments traversant un composant (hors ses propres terminaux)
    through = 0
    comps = [(cid, v) for cid, v in verts.items() if not v['junction']]
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
                # segment orthogonal : chevauchement suffit
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
        m['min_length'] = round(sum(math.hypot(0, 0) for _ in comps), 1)
    else:
        m['sprawl'] = 0.0
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

def score(m):
    s = 100.0
    s -= WEIGHTS['crossing'] * m.get('crossings', 0)
    s -= WEIGHTS['through'] * m.get('through_component', 0)
    nb = max(0, m.get('bends', 0) - 2*m.get('n_wires', 0))
    s -= WEIGHTS['bend'] * nb
    s -= WEIGHTS['length'] * max(0.0, m.get('wire_length', 0) - 300*m.get('n_wires', 0)/3) / 1000
    s -= WEIGHTS['misalign'] * (1 - m.get('align_ratio', 1))
    s -= WEIGHTS['unbalance'] * m.get('ink_balance', 0)
    s -= WEIGHTS['sprawl'] * m.get('sprawl', 0)
    return round(max(0.0, min(100.0, s)), 1)

if __name__ == '__main__':
    xml_path, png_path = sys.argv[1], sys.argv[2]
    ref = sys.argv[3] if len(sys.argv) > 3 else None
    verts, edges = load(xml_path)
    m = xml_metrics(verts, edges)
    m.update(cv_metrics(png_path, ref))
    print(json.dumps({'score': score(m), 'metrics': m, 'weights': WEIGHTS}))
