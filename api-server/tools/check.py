#!/usr/bin/env python3
"""check.py — vérificateur de règles 100 % Python, INDÉPENDANT du générateur.

Lit le XML drawio brut (mxfile ou mxGraphModel), reconstruit pins/fils/nets
par sa propre géométrie, et vérifie les règles du registre training/RULES.md
sans réutiliser une ligne du code JS (autre langage, autre modèle mental :
c'est l'antidote au biais de l'auteur qui vérifie sa propre sortie).

Usage : check.py fichier.xml [--netlist fichier.cir] [--json]
Sortie : violations {rule, severity, message, at} ; exit 1 si erreurs.
"""
import sys
import json
import math
import re
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------- tolérances
TOL = {
    'net_clearance': 10,     # deux nets différents : écart minimal entre lanes parallèles
    'net_overlap_len': 6,    # ... dès que le recouvrement dépasse cette longueur
    'pin_clearance': 6,      # un fil étranger ne passe pas à moins de N px d'un pin
    'foreign_contact': 2.5,  # sommet de polyligne posé sur un segment étranger
    'body_shrink': 1,        # rétrécissement du corps pour le test « à travers »
    'through_pin_slack': 8,  # pénétration tolérée dans SON PROPRE corps autour du pin
    'dot_snap': 4.5,         # un dot appartient à la géométrie située à moins de N px
    'dot_required': 4,       # un dot exigé doit être à moins de N px du té
    'dot_dup': 12,           # deux dots plus proches = doublon
    'same_net_gap': 14,      # même net : deux conducteurs parallèles sous N px...
    'same_net_len': 20,      # ... sur plus de N px doivent fusionner (règle 29)
    'row_align': 3,          # paires/miroirs : même rangée (règle 14/26)
    'drain_align': 2,        # drains alignés (règle 25)
    'edge_hug_len': 25,      # fil collé au bord d'un corps sur plus de N px
}

# ------------------------------------------------------------------- parsing

def parse(path):
    with open(path, 'r', encoding='utf-8') as f:
        text = f.read()
    if '<!DOCTYPE' in text or '<!ENTITY' in text:
        raise SystemExit('XML avec DOCTYPE/ENTITY refusé (risque XXE) : ' + path)
    root = ET.fromstring(text)
    if root.tag == 'mxGraphModel':
        model = root
    else:
        model = root.find('.//mxGraphModel')
        if model is None:
            raise SystemExit('pas de mxGraphModel dans ' + path)
    verts, edges, dots = {}, [], []
    for c in model.iter('mxCell'):
        cid = c.get('id')
        style = c.get('style') or ''
        smap = dict(kv.split('=', 1) for kv in style.split(';') if '=' in kv)
        g = c.find('mxGeometry')
        if c.get('vertex') == '1' and g is not None and g.get('x') is not None:
            v = {
                'id': cid, 'x': float(g.get('x')), 'y': float(g.get('y')),
                'w': float(g.get('width') or 0), 'h': float(g.get('height') or 0),
                'shape': smap.get('shape', ''), 'value': c.get('value') or '',
                'rotation': float(smap.get('rotation', 0)),
                'flipH': smap.get('flipH') == '1', 'flipV': smap.get('flipV') == '1',
                'vlp': smap.get('verticalLabelPosition'),
                'no_label': smap.get('noLabel') == '1',
                'is_text': style.startswith('text;'),
            }
            if 'contactDot' in smap:
                dots.append({'id': cid, 'x': v['x'] + v['w'] / 2, 'y': v['y'] + v['h'] / 2})
            elif 'drawioApiJunction' in smap:
                v['junction'] = True
                verts[cid] = v
            else:
                verts[cid] = v
        elif c.get('edge') == '1':
            pts = []
            if g is not None:
                arr = g.find("Array[@as='points']")
                if arr is not None:
                    pts = [(float(p.get('x')), float(p.get('y'))) for p in arr.findall('mxPoint')]
            def anchor(pref):
                x, y = smap.get(pref + 'X'), smap.get(pref + 'Y')
                return (float(x), float(y)) if x is not None and y is not None else None
            edges.append({
                'id': cid, 'src': c.get('source'), 'tgt': c.get('target'),
                'exit': anchor('exit'), 'entry': anchor('entry'), 'points': pts,
                'style': smap,
            })
    return verts, edges, dots


def pin_abs(v, rel):
    rx, ry = rel
    if v['flipH']:
        rx = 1 - rx
    if v['flipV']:
        ry = 1 - ry
    t = math.radians(v['rotation'])
    cx, cy = v['x'] + v['w'] / 2, v['y'] + v['h'] / 2
    px, py = v['x'] + rx * v['w'], v['y'] + ry * v['h']
    dx, dy = px - cx, py - cy
    return (cx + dx * math.cos(t) - dy * math.sin(t), cy + dx * math.sin(t) + dy * math.cos(t))


def aabb(v):
    t = math.radians(v['rotation'])
    w = abs(v['w'] * math.cos(t)) + abs(v['h'] * math.sin(t))
    h = abs(v['w'] * math.sin(t)) + abs(v['h'] * math.cos(t))
    cx, cy = v['x'] + v['w'] / 2, v['y'] + v['h'] / 2
    return (cx - w / 2, cy - h / 2, w, h)

# ------------------------------------------------------------- géométrie pure

def d_point_seg(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2))
    return math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy))


def seg_axis(a, b):
    if abs(a[1] - b[1]) < 0.6 and abs(a[0] - b[0]) >= 0.6:
        return 'h'
    if abs(a[0] - b[0]) < 0.6 and abs(a[1] - b[1]) >= 0.6:
        return 'v'
    return 'd'


def clip_seg_rect(a, b, r):
    """Portion (t0,t1) du segment a->b à l'intérieur du rect (Liang-Barsky)."""
    x, y, w, h = r
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] - x), (dx, x + w - a[0]), (-dy, a[1] - y), (dy, y + h - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            if t > t1:
                return None
            t0 = max(t0, t)
        else:
            if t < t0:
                return None
            t1 = min(t1, t)
    if t0 >= t1:
        return None
    return (t0, t1)


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

# ------------------------------------------------------------------- checker

MOS_PINS = {
    # rel coords AVANT flip : (drain, gate, source) — PMOS dessiné source en haut
    'nmos': {'D': (1, 0), 'G': (0, 0.5), 'S': (1, 1)},
    'pmos': {'D': (1, 1), 'G': (0, 0.5), 'S': (1, 0)},
}


def mos_kind(shape):
    s = shape.lower()
    if 'pmos' in s or 'mosfet_p' in s:
        return 'pmos'
    if 'nmos' in s or 'mosfet_n' in s:
        return 'nmos'
    return None


class Checker:
    def __init__(self, verts, edges, dots, netlist_path=None):
        self.verts, self.edges, self.dots = verts, edges, dots
        self.netlist_path = netlist_path
        self.violations = []
        self._build()

    def add(self, rule, severity, message, at=None):
        self.violations.append({'rule': rule, 'severity': severity,
                                'message': message, 'at': at})

    # ---- construction : polylignes, nets, pins
    def _build(self):
        self.polys = {}     # edge id -> [(x,y), ...]
        parent = {}

        def find(k):
            while parent.get(k, k) != k:
                parent[k] = parent.get(parent[k], parent[k])
                k = parent[k]
            return k

        def union(a, b):
            parent.setdefault(a, a)
            parent.setdefault(b, b)
            parent[find(a)] = find(b)

        end_keys = {}
        for e in self.edges:
            pl = []
            keys = []
            for which, cid, rel in (('exit', e['src'], e['exit']), ('entry', e['tgt'], e['entry'])):
                v = self.verts.get(cid)
                if v is None:
                    self.add('dangling', 'error',
                             f"fil {e['id']} : extrémité {which} sans composant ({cid})")
                    pl = None
                    break
                if v.get('junction'):
                    pt = (v['x'] + v['w'] / 2, v['y'] + v['h'] / 2)
                    keys.append(('J', cid))
                elif rel is None:
                    self.add('unanchored', 'warning',
                             f"fil {e['id']} : extrémité {which} sur {cid} sans ancre de pin "
                             '(géométrie rendue imprévisible)')
                    pt = (v['x'] + v['w'] / 2, v['y'] + v['h'] / 2)
                    keys.append(('C', cid, 'center'))
                else:
                    pt = pin_abs(v, rel)
                    keys.append(('P', cid, round(pt[0]), round(pt[1])))
                if which == 'exit':
                    pl = [pt]
                else:
                    pl.extend([(x, y) for x, y in e['points']])
                    pl.append(pt)
            if pl is None:
                continue
            self.polys[e['id']] = pl
            union(keys[0], keys[1])
            end_keys[e['id']] = keys
        self.net = {eid: find(keys[0]) for eid, keys in end_keys.items()}
        # pins câblés : position -> net, cellule
        self.pins = []
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            pl = self.polys[e['id']]
            for cid, pt in ((e['src'], pl[0]), (e['tgt'], pl[-1])):
                self.pins.append({'cell': cid, 'pt': pt, 'net': self.net[e['id']],
                                  'edge': e['id']})

    def segs(self, eid):
        pl = self.polys.get(eid, [])
        return [(pl[i], pl[i + 1]) for i in range(len(pl) - 1)
                if math.hypot(pl[i + 1][0] - pl[i][0], pl[i + 1][1] - pl[i][1]) > 0.5]

    # ---- règle « à travers » : aucun fil dans un corps ; SON corps seulement
    # au voisinage immédiat de son pin (pas de traversée de part en part)
    def check_through(self):
        sh = TOL['body_shrink']
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            pl = self.polys[e['id']]
            for i, (a, b) in enumerate(self.segs(e['id'])):
                for cid, v in self.verts.items():
                    if v.get('junction') or v.get('is_text') or v['w'] < 12:
                        continue
                    x, y, w, h = aabb(v)
                    r = (x + sh, y + sh, w - 2 * sh, h - 2 * sh)
                    if r[2] <= 0 or r[3] <= 0:
                        continue
                    clip = clip_seg_rect(a, b, r)
                    if clip is None:
                        continue
                    p0, p1 = lerp(a, b, clip[0]), lerp(a, b, clip[1])
                    clen = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
                    if cid in (e['src'], e['tgt']):
                        own_pin = pl[0] if cid == e['src'] else pl[-1]
                        far = max(math.hypot(p0[0] - own_pin[0], p0[1] - own_pin[1]),
                                  math.hypot(p1[0] - own_pin[0], p1[1] - own_pin[1]))
                        if far > TOL['through_pin_slack'] and clen > 2:
                            self.add('through', 'error',
                                     f"fil {e['id']} traverse SON composant {cid} au-delà du pin "
                                     f'(pénétration {far:.0f}px)', p0)
                    elif clen > 0.5 or clip[1] - clip[0] > 0:
                        self.add('through', 'error',
                                 f"fil {e['id']} ({e['src']}->{e['tgt']}) traverse le corps de {cid}", p0)

    # ---- règle 22 + variantes : nets différents trop proches / en contact
    def check_net_separation(self):
        eids = [e['id'] for e in self.edges if e['id'] in self.polys]
        seen = set()
        for i, ea in enumerate(eids):
            for eb in eids[i + 1:]:
                if self.net[ea] == self.net[eb]:
                    continue
                for a1, a2 in self.segs(ea):
                    xa = seg_axis(a1, a2)
                    for b1, b2 in self.segs(eb):
                        xb = seg_axis(b1, b2)
                        if xa != xb or xa == 'd':
                            continue
                        if xa == 'h':
                            d = abs(a1[1] - b1[1])
                            lo = max(min(a1[0], a2[0]), min(b1[0], b2[0]))
                            hi = min(max(a1[0], a2[0]), max(b1[0], b2[0]))
                            at = (lo, a1[1])
                        else:
                            d = abs(a1[0] - b1[0])
                            lo = max(min(a1[1], a2[1]), min(b1[1], b2[1]))
                            hi = min(max(a1[1], a2[1]), max(b1[1], b2[1]))
                            at = (a1[0], lo)
                        if d < TOL['net_clearance'] and hi - lo > TOL['net_overlap_len']:
                            key = (ea, eb, xa, round(lo), round(at[1] if xa == 'h' else at[0]))
                            if key in seen:
                                continue
                            seen.add(key)
                            self.add('22', 'error',
                                     f'nets différents à {d:.0f}px sur {hi - lo:.0f}px : '
                                     f'{ea} vs {eb}', at)
        # sommet de polyligne posé sur un segment d'un autre net
        for ea in eids:
            for pt in self.polys[ea]:
                for eb in eids:
                    if ea == eb or self.net[ea] == self.net[eb]:
                        continue
                    for b1, b2 in self.segs(eb):
                        if d_point_seg(pt, b1, b2) < TOL['foreign_contact']:
                            if min(math.hypot(pt[0] - q[0], pt[1] - q[1]) for q in (b1, b2)) < 1:
                                continue  # simple contact bout à bout aux extrémités ? non : flag quand même sauf coïncidence exacte de coin
                            self.add('22-contact', 'error',
                                     f'sommet du fil {ea} posé sur le segment du fil {eb} '
                                     '(nets différents : lecture de court-circuit)', pt)

    # ---- pins : un fil étranger ne frôle pas un pin câblé
    def check_pin_clearance(self):
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            for a, b in self.segs(e['id']):
                for p in self.pins:
                    if p['net'] == self.net[e['id']]:
                        continue
                    d = d_point_seg(p['pt'], a, b)
                    if d < TOL['pin_clearance']:
                        self.add('pin-clearance', 'error',
                                 f"fil {e['id']} passe à {d:.1f}px du pin de {p['cell']} "
                                 '(net différent)', p['pt'])

    # ---- dots : appartenance, orphelins, doublons, dots requis
    def _near_nets(self, pt, tol):
        nets = set()
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            for a, b in self.segs(e['id']):
                if d_point_seg(pt, a, b) < tol:
                    nets.add(self.net[e['id']])
        return nets

    def check_dots(self):
        for d in self.dots:
            pt = (d['x'], d['y'])
            nets = self._near_nets(pt, TOL['dot_snap'])
            if len(nets) == 0:
                self.add('dot-orphan', 'error',
                         f"point de contact {d['id']} posé dans le vide", pt)
            elif len(nets) > 1:
                self.add('dot-foreign', 'error',
                         f"point de contact {d['id']} touche {len(nets)} nets différents "
                         '(lecture de court-circuit)', pt)
        for i, d1 in enumerate(self.dots):
            for d2 in self.dots[i + 1:]:
                if math.hypot(d1['x'] - d2['x'], d1['y'] - d2['y']) < TOL['dot_dup']:
                    self.add('30b', 'warning',
                             f"dots dupliqués {d1['id']} / {d2['id']}", (d1['x'], d1['y']))
        # dots requis : (a) >=2 extrémités même net au même pin de composant
        clusters = []
        for p in self.pins:
            v = self.verts.get(p['cell'])
            if v is None or v.get('junction'):
                continue
            for c in clusters:
                if c['net'] == p['net'] and math.hypot(c['pt'][0] - p['pt'][0], c['pt'][1] - p['pt'][1]) < 3:
                    c['n'] += 1
                    break
            else:
                clusters.append({'pt': p['pt'], 'net': p['net'], 'n': 1})
        for c in clusters:
            if c['n'] >= 2 and not self._dot_at(c['pt']):
                self.add('30', 'error',
                         f"branche à {c['n'] + 1} voies sans point de contact", c['pt'])
        # (b) té : tout sommet (extrémité OU coin) d'un fil posé sur
        # l'intérieur d'un segment du même net = branche -> dot requis
        for ea in self.polys:
            pl = self.polys[ea]
            for pt in pl:
                for eb in self.polys:
                    if ea == eb or self.net[ea] != self.net[eb]:
                        continue
                    for b1, b2 in self.segs(eb):
                        if d_point_seg(pt, b1, b2) < 2.5 and \
                           min(math.hypot(pt[0] - q[0], pt[1] - q[1]) for q in (b1, b2)) > 4:
                            if not self._dot_at(pt):
                                self.add('30', 'error',
                                         f'té {ea} sur {eb} (même net) sans point de contact', pt)

    def _dot_at(self, pt):
        return any(math.hypot(d['x'] - pt[0], d['y'] - pt[1]) < TOL['dot_required']
                   for d in self.dots)

    # ---- règle 29 : même net, conducteurs parallèles non fusionnés
    def check_same_net_parallel(self):
        eids = list(self.polys)
        for i, ea in enumerate(eids):
            for eb in eids[i + 1:]:
                if self.net[ea] != self.net[eb]:
                    continue
                for a1, a2 in self.segs(ea):
                    xa = seg_axis(a1, a2)
                    for b1, b2 in self.segs(eb):
                        if seg_axis(b1, b2) != xa or xa == 'd':
                            continue
                        if xa == 'h':
                            d = abs(a1[1] - b1[1])
                            lo = max(min(a1[0], a2[0]), min(b1[0], b2[0]))
                            hi = min(max(a1[0], a2[0]), max(b1[0], b2[0]))
                            at = (lo, a1[1])
                        else:
                            d = abs(a1[0] - b1[0])
                            lo = max(min(a1[1], a2[1]), min(b1[1], b2[1]))
                            hi = min(max(a1[1], a2[1]), max(b1[1], b2[1]))
                            at = (a1[0], lo)
                        if d < TOL['same_net_gap'] and hi - lo > TOL['same_net_len']:
                            exact = d < 0.6  # superposé exact : rendu = un seul trait
                            self.add('29', 'warning' if exact else 'error',
                                     'même net : conducteurs '
                                     + ('superposés' if exact else f'parallèles à {d:.0f}px')
                                     + f' sur {hi - lo:.0f}px non fusionnés ({ea} / {eb})', at)

    # ---- fil collé au bord d'un corps (cadre de diode du mauvais côté, etc.)
    def check_edge_hug(self):
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            for a, b in self.segs(e['id']):
                ax = seg_axis(a, b)
                if ax == 'd':
                    continue
                for cid, v in self.verts.items():
                    if v.get('junction') or v.get('is_text') or v['h'] < 60:
                        continue
                    x, y, w, h = aabb(v)
                    if ax == 'v' and (abs(a[0] - x) < 2.5 or abs(a[0] - (x + w)) < 2.5):
                        lo, hi = max(min(a[1], b[1]), y), min(max(a[1], b[1]), y + h)
                        if hi - lo > TOL['edge_hug_len']:
                            self.add('edge-hug', 'warning',
                                     f"fil {e['id']} colle le flanc de {cid} sur {hi - lo:.0f}px "
                                     '(se lit comme le symbole)', (a[0], lo))
                    if ax == 'h' and (abs(a[1] - y) < 2.5 or abs(a[1] - (y + h)) < 2.5):
                        lo, hi = max(min(a[0], b[0]), x), min(max(a[0], b[0]), x + w)
                        if hi - lo > TOL['edge_hug_len']:
                            self.add('edge-hug', 'warning',
                                     f"fil {e['id']} colle le bord de {cid} sur {hi - lo:.0f}px",
                                     (lo, a[1]))

    # ---- étiquettes : jamais sur un fil, jamais l'une sur l'autre
    def label_box(self, v):
        txt = v['value']
        if not txt or v.get('no_label'):
            return None
        if v.get('is_text'):
            return (v['x'], v['y'], v['w'], v['h'])
        lw, lh = 7.2 * len(txt) + 6, 16
        cx = v['x'] + v['w'] / 2
        if v.get('vlp') == 'top':
            cy = v['y'] - lh / 2 - 2
        else:
            cy = v['y'] + v['h'] + lh / 2 + 2
        return (cx - lw / 2, cy - lh / 2, lw, lh)

    def check_labels(self):
        boxes = [(cid, self.label_box(v)) for cid, v in self.verts.items()]
        boxes = [(cid, b) for cid, b in boxes if b]
        for cid, b in boxes:
            for e in self.edges:
                if e['id'] not in self.polys:
                    continue
                hit = any(clip_seg_rect(a, bb, b) for a, bb in self.segs(e['id']))
                if hit:
                    self.add('label-on-wire', 'warning',
                             f"étiquette de {cid} barrée par le fil {e['id']}",
                             (b[0] + b[2] / 2, b[1] + b[3] / 2))
                    break
        for i, (c1, b1) in enumerate(boxes):
            for c2, b2 in boxes[i + 1:]:
                if b1[0] < b2[0] + b2[2] and b2[0] < b1[0] + b1[2] and \
                   b1[1] < b2[1] + b2[3] and b2[1] < b1[1] + b1[3]:
                    self.add('label-overlap', 'warning',
                             f'étiquettes de {c1} et {c2} se chevauchent',
                             (b1[0], b1[1]))

    # ---- structures : paires/miroirs (rangée, drains, gates), diode côté drain
    def _mos_pin_net(self, cid, pin):
        v = self.verts[cid]
        kind = mos_kind(v['shape'])
        pt = pin_abs(v, MOS_PINS[kind][pin])
        for p in self.pins:
            if p['cell'] == cid and math.hypot(p['pt'][0] - pt[0], p['pt'][1] - pt[1]) < 2.5:
                return p['net']
        return None

    def check_structures(self):
        mos = {cid: v for cid, v in self.verts.items() if mos_kind(v['shape'])}
        info = {}
        for cid in mos:
            info[cid] = {p: self._mos_pin_net(cid, p) for p in ('D', 'G', 'S')}
        # paires (source partagée) et miroirs (gate partagée + diode)
        by_source, by_gate = {}, {}
        for cid, i in info.items():
            if i['S'] is not None:
                by_source.setdefault(i['S'], []).append(cid)
            if i['G'] is not None:
                by_gate.setdefault(i['G'], []).append(cid)
        groups = []
        for net, refs in by_source.items():
            if len(refs) == 2:
                groups.append(('paire (source commune)', '14', refs))
        for net, refs in by_gate.items():
            if len(refs) >= 2 and any(info[r]['D'] == net for r in refs):
                groups.append(('miroir de courant', '26', refs))
        for label, rule, refs in groups:
            ys = [self.verts[r]['y'] + self.verts[r]['h'] / 2 for r in refs]
            if max(ys) - min(ys) > TOL['row_align']:
                self.add(rule, 'error',
                         f'{label} [{",".join(refs)}] pas à la même rangée '
                         f'(Δy={max(ys) - min(ys):.0f}px)',
                         (self.verts[refs[0]]['x'], min(ys)))
            dys = []
            for r in refs:
                v = self.verts[r]
                dys.append(pin_abs(v, MOS_PINS[mos_kind(v['shape'])]['D'])[1])
            if max(dys) - min(dys) > TOL['drain_align'] and max(ys) - min(ys) <= TOL['row_align']:
                self.add('25', 'error',
                         f'{label} [{",".join(refs)}] : drains désalignés '
                         f'(Δy={max(dys) - min(dys):.1f}px — aligner les DRAINS, pas les centres)',
                         (self.verts[refs[0]]['x'], min(dys)))
        # règle 28 : miroir à 2 transistors -> gates face à face
        for label, rule, refs in groups:
            if rule != '26' or len(refs) != 2:
                continue
            l, r = sorted(refs, key=lambda c: self.verts[c]['x'])
            gl = pin_abs(self.verts[l], MOS_PINS[mos_kind(self.verts[l]['shape'])]['G'])
            gr = pin_abs(self.verts[r], MOS_PINS[mos_kind(self.verts[r]['shape'])]['G'])
            cl = self.verts[l]['x'] + self.verts[l]['w'] / 2
            cr = self.verts[r]['x'] + self.verts[r]['w'] / 2
            if not (gl[0] > cl and gr[0] < cr):
                self.add('28', 'error',
                         f'miroir 2 transistors [{l},{r}] : gates pas face à face vers le centre',
                         gl)
        # règle 32 : self-edge de diode côté drain
        for e in self.edges:
            if e['src'] != e['tgt'] or e['src'] not in mos or e['id'] not in self.polys:
                continue
            v = self.verts[e['src']]
            x, y, w, h = aabb(v)
            drain = pin_abs(v, MOS_PINS[mos_kind(v['shape'])]['D'])
            drain_top = drain[1] <= y + h / 2
            outs = [p for p in e['points'] if p[1] < y - 3 or p[1] > y + h + 3]
            if outs:
                loop_top = outs[0][1] < y
                if loop_top != drain_top:
                    self.add('32', 'error',
                             f"diode {e['src']} : boucle gate-drain côté "
                             f"{'haut' if loop_top else 'bas'}, drain en "
                             f"{'haut' if drain_top else 'bas'}", outs[0])

    # ---- coudes en excès et croisements (lisibilité)
    def check_bends_crossings(self):
        for e in self.edges:
            if e['id'] not in self.polys or self.edges is None:
                continue
            if e['style'].get('edgeStyle') == 'none':
                continue
            pl = self.polys[e['id']]
            segs = self.segs(e['id'])
            if len(segs) < 1:
                continue
            bends = sum(1 for i in range(len(segs) - 1)
                        if seg_axis(*segs[i]) != seg_axis(*segs[i + 1]))
            a, b = pl[0], pl[-1]
            minb = 0 if (abs(a[0] - b[0]) < 1 or abs(a[1] - b[1]) < 1) else 1
            if bends > minb + 2:
                self.add('excess-bends', 'warning',
                         f"fil {e['id']} : {bends} coudes (minimum géométrique {minb})",
                         pl[1] if len(pl) > 1 else a)
        n = 0
        eids = list(self.polys)
        for i, ea in enumerate(eids):
            for eb in eids[i + 1:]:
                if self.net[ea] == self.net[eb]:
                    continue
                for a1, a2 in self.segs(ea):
                    for b1, b2 in self.segs(eb):
                        if seg_axis(a1, a2) == 'h' and seg_axis(b1, b2) == 'v':
                            hx, hy = b1[0], a1[1]
                        elif seg_axis(a1, a2) == 'v' and seg_axis(b1, b2) == 'h':
                            hx, hy = a1[0], b1[1]
                        else:
                            continue
                        if min(a1[0], a2[0]) + 1 < hx < max(a1[0], a2[0]) - 1 and \
                           min(b1[1], b2[1]) + 1 < hy < max(b1[1], b2[1]) - 1 and \
                           min(a1[1], a2[1]) - 1 <= hy <= max(a1[1], a2[1]) + 1 and \
                           min(b1[0], b2[0]) - 1 <= hx <= max(b1[0], b2[0]) + 1:
                            n += 1
        self.crossings = n

    # ---- cohérence avec la netlist SPICE (optionnelle)
    def check_netlist(self):
        if not self.netlist_path:
            return
        names = set()
        with open(self.netlist_path) as f:
            for line in f:
                line = line.strip()
                if not line or line[0] in '*.':
                    continue
                toks = line.split()
                pref = toks[0][0].upper()
                nn = {'R': 2, 'C': 2, 'L': 2, 'D': 2, 'V': 2, 'I': 2, 'Q': 3, 'M': 4, 'G': 4}.get(pref, 2)
                for t in toks[1:1 + nn]:
                    names.add(t.lower())
        power = {n for n in names if re.match(r'^(a?v(dd|cc|ss|ee))$', n)}
        # rails : un tap étiqueté VDD exige un net d'alimentation dans la netlist
        for cid, v in self.verts.items():
            if 'vss2' in v['shape'] or v['value'].upper() in ('VDD', 'VSS', 'VCC'):
                if v['value'] and v['value'].lower() not in names:
                    self.add('rail-mislabel', 'error',
                             f"tap « {v['value']} » ({cid}) : aucun net nommé "
                             f"{v['value'].lower()} dans la netlist — un net de signal "
                             'a été déguisé en rail', (v['x'], v['y']))
        # nets nommés sans étiquette/port sur le schéma
        port_names = {v['value'].lower() for v in self.verts.values()
                      if 'equipotential' in v['shape'] and v['value']}
        for n in sorted(names - power - {'0'}):
            if len(n) >= 2 and not n.isdigit() and not re.match(r'^(net|n)\d+$', n):
                if n not in port_names:
                    self.add('unlabeled-net', 'warning',
                             f'net nommé « {n} » sans port/étiquette sur le schéma')

    def check_comp_overlap(self):
        ids = [cid for cid, v in self.verts.items()
               if not v.get('junction') and not v.get('is_text')
               and v['w'] >= 20 and v['h'] >= 20]
        for i, c1 in enumerate(ids):
            for c2 in ids[i + 1:]:
                x1, y1, w1, h1 = aabb(self.verts[c1])
                x2, y2, w2, h2 = aabb(self.verts[c2])
                ox = min(x1 + w1, x2 + w2) - max(x1, x2)
                oy = min(y1 + h1, y2 + h2) - max(y1, y2)
                if ox > 4 and oy > 4:
                    self.add('comp-overlap', 'error',
                             f'corps de {c1} et {c2} se chevauchent ({ox:.0f}x{oy:.0f}px)',
                             (max(x1, x2), max(y1, y2)))

    def check_wrap(self):
        # DIPÔLE monté à l'envers : le fil part d'un pin qui regarde d'un
        # côté et finit de l'autre côté du corps (Lb1 en Π). Restreint aux
        # 2-terminaux : pour un MOS/OTA le contournement peut être forcé par
        # la topologie (bus de gates, contre-réaction).
        DIPOLES = ('resistors.', 'capacitors.', 'inductors.', 'diodes.')
        for e in self.edges:
            if e['id'] not in self.polys or e['src'] == e['tgt']:
                continue
            pl = self.polys[e['id']]
            for cid, pt, other in ((e['src'], pl[0], pl[-1]), (e['tgt'], pl[-1], pl[0])):
                v = self.verts.get(cid)
                if v is None or not any(t in v['shape'] for t in DIPOLES):
                    continue
                x, y, w, h = aabb(v)
                # pin en COIN : le lead d'une forme paysage est horizontal
                # (côté gauche/droite), celui d'une forme portrait vertical
                if w >= h:
                    if pt[0] <= x + 2:
                        side = 'left'
                    elif pt[0] >= x + w - 2:
                        side = 'right'
                    elif pt[1] <= y + 2:
                        side = 'top'
                    elif pt[1] >= y + h - 2:
                        side = 'bottom'
                    else:
                        continue
                else:
                    if pt[1] <= y + 2:
                        side = 'top'
                    elif pt[1] >= y + h - 2:
                        side = 'bottom'
                    elif pt[0] <= x + 2:
                        side = 'left'
                    elif pt[0] >= x + w - 2:
                        side = 'right'
                    else:
                        continue
                bad = (side == 'top' and other[1] > y + h + 10 and x - 40 <= other[0] <= x + w + 40) or \
                      (side == 'bottom' and other[1] < y - 10 and x - 40 <= other[0] <= x + w + 40) or \
                      (side == 'left' and other[0] > x + w + 10 and y - 40 <= other[1] <= y + h + 40) or \
                      (side == 'right' and other[0] < x - 10 and y - 40 <= other[1] <= y + h + 40)
                if bad:
                    self.add('wrap-around', 'error',
                             f"fil {e['id']} : le pin ({side}) de {cid} regarde à "
                             f"l'opposé de sa destination — dipôle monté à l'envers",
                             pt)

    def run(self):
        self.check_wrap()
        self.check_comp_overlap()
        self.check_through()
        self.check_net_separation()
        self.check_pin_clearance()
        self.check_dots()
        self.check_same_net_parallel()
        self.check_edge_hug()
        self.check_labels()
        self.check_structures()
        self.check_bends_crossings()
        self.check_netlist()
        # dédoublonnage grossier (mêmes rule+message)
        seen, out = set(), []
        for v in self.violations:
            k = (v['rule'], v['message'])
            if k in seen:
                continue
            seen.add(k)
            out.append(v)
        self.violations = out
        return {
            'violations': self.violations,
            'errors': sum(1 for v in self.violations if v['severity'] == 'error'),
            'warnings': sum(1 for v in self.violations if v['severity'] == 'warning'),
            'crossings': getattr(self, 'crossings', 0),
        }


def main():
    args = sys.argv[1:]
    as_json = '--json' in args
    args = [a for a in args if a != '--json']
    netlist = None
    if '--netlist' in args:
        i = args.index('--netlist')
        netlist = args[i + 1]
        del args[i:i + 2]
    if not args:
        raise SystemExit(__doc__)
    verts, edges, dots = parse(args[0])
    result = Checker(verts, edges, dots, netlist).run()
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    else:
        print(f"{result['errors']} erreurs, {result['warnings']} warnings, "
              f"{result['crossings']} croisements")
        for v in result['violations']:
            at = f" @({v['at'][0]:.0f},{v['at'][1]:.0f})" if v.get('at') else ''
            print(f"  [{v['severity'][0].upper()}][{v['rule']}] {v['message']}{at}")
    sys.exit(1 if result['errors'] else 0)


if __name__ == '__main__':
    main()
