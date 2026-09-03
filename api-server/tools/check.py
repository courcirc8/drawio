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

def is_junction_cell(smap):
    """Shared predicate (task B, 2026-08-31): a cell is a junction if it
    carries our own `drawioApiJunction` marker OR is a native drawio
    `shape=waypoint` vertex the USER drew with draw.io's own "insert
    waypoint" tool. Mirrors lib/components.js::isJunctionCell() -- keep both
    in sync. Before this, only `drawioApiJunction`/`contactDot` were
    recognized, so a hand-drawn waypoint junction (12 of them in the real
    BOM_2446 hand file) read back as an ordinary unconnected vertex: every
    wire touching it became a single-terminal-net / unconnected-pin ERC
    finding instead of joining the net it visually belongs to.
    """
    return 'drawioApiJunction' in smap or smap.get('shape') == 'waypoint'


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
    # BUG (2026-08-31): this iterated bare <mxCell> only. draw.io wraps a cell
    # that carries user data in <object id=... label=...><mxCell/></object>, and
    # the id then lives on the WRAPPER -- the inner mxCell has none. Every
    # vertex the api-server tags with refdes/spice_value is wrapped, so cid was
    # None, the vertex never entered `verts`, and every wire touching it was
    # reported as `dangling`. Measured on the two RF matching sheets: 26 and 29
    # false `dangling` errors plus the `dot-orphan`s that follow from them, on
    # documents whose LVS round-trip matches and whose ERC is 0/0. Same trap as
    # model.js's mxCellOf(): resolve the wrapper, never assume a bare mxCell.
    def _cells(mdl):
        # yields (id, mxCell element, label) for every cell, wrapper-aware
        wrapped = set()
        for obj in mdl.iter('object'):
            mx = obj.find('mxCell')
            if mx is None:
                continue
            wrapped.add(id(mx))
            yield obj.get('id'), mx, (obj.get('label') or '')
        for mx in mdl.iter('mxCell'):
            if id(mx) in wrapped:
                continue
            yield mx.get('id'), mx, (mx.get('value') or '')
    for cid, c, cvalue in _cells(model):
        style = c.get('style') or ''
        smap = dict(kv.split('=', 1) for kv in style.split(';') if '=' in kv)
        g = c.find('mxGeometry')
        if c.get('vertex') == '1' and g is not None and g.get('x') is not None:
            v = {
                'id': cid, 'x': float(g.get('x')), 'y': float(g.get('y')),
                'w': float(g.get('width') or 0), 'h': float(g.get('height') or 0),
                'shape': smap.get('shape', ''), 'value': cvalue,
                'rotation': float(smap.get('rotation', 0)),
                'flipH': smap.get('flipH') == '1', 'flipV': smap.get('flipV') == '1',
                'vlp': smap.get('verticalLabelPosition'),
                'no_label': smap.get('noLabel') == '1',
                'is_text': style.startswith('text;'),
                # api-server annotation layer (lib/annotate.js, task 2
                # 2026-08-31): a cell carrying `apiAnnotation=1` is
                # DECLARED electrically/DRC inert -- decorative colour,
                # text or the PA/LNA amplifier symbol, never real
                # component geometry. Every `is_text`-gated exclusion
                # below (through/edge-hug/comp-overlap/_seg_feasible)
                # also excludes `is_annotation`, because an annotation
                # can now carry a REAL shape (e.g. `shape=triangle` for
                # the amplifier block) that would otherwise be
                # indistinguishable from an actual component body.
                'is_annotation': 'apiAnnotation' in smap,
            }
            # DEFECT (2026-08-31): only `contactDot` cells were indexed as dots,
            # so `_dot_at()` could not see place3's own `J_<net>` junction dots
            # (style `drawioApiJunction=1;`, no `contactDot` -- only route.js's
            # addContactDots pass writes that marker). Rule 30 therefore demanded
            # "un point de contact" at a point where a dot was already DRAWN:
            # on the 2446 sheet, `J_Up` sits at exactly the reported (361,340),
            # distance 0 from the branch, and was still reported as missing.
            # Both kinds are the same glyph with the same electrical meaning; the
            # marker only records WHICH pass emitted it. A junction cell is still
            # registered as a vertex as well, because the dot-membership and
            # dot-orphan rules below reason about it as a cell.
            # `apiJunctionHidden` : cellule de jonction dont le glyphe est
            # ETEINT (route.js hideDegenerateJunctions) -- aucun point n'est
            # dessiné là, donc elle ne doit compter ni comme dot présent
            # (règle 30) ni comme dot interdit (dot-2way).
            if 'apiJunctionHidden' in smap:
                pass
            elif 'contactDot' in smap or is_junction_cell(smap):
                dots.append({'id': cid, 'x': v['x'] + v['w'] / 2, 'y': v['y'] + v['h'] / 2})
            if is_junction_cell(smap):
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
                    if v.get('junction') or v.get('is_text') or v.get('is_annotation') or v['w'] < 12:
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

    def _dir8(self, a, b):
        if math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5:
            return None
        return (round(math.atan2(b[1] - a[1], b[0] - a[0]) / math.pi * 4)) % 8

    def _dirs_at(self, pt):
        """Directions de cuivre distinctes au point pt : segments (intérieur
        = 2 directions, extrémité = 1) + broches de composants (vers le
        corps)."""
        dirs = set()
        for eid, pl in self.polys.items():
            for k in range(len(pl) - 1):
                a, b = pl[k], pl[k + 1]
                if d_point_seg(pt, a, b) >= 4.5:
                    continue
                da = math.hypot(pt[0] - a[0], pt[1] - a[1])
                db = math.hypot(pt[0] - b[0], pt[1] - b[1])
                if da > 4 and db > 4:
                    d1 = self._dir8(a, b)
                    if d1 is not None:
                        dirs.add(d1)
                        dirs.add((d1 + 4) % 8)
                elif da <= 4:
                    d1 = self._dir8(a, b)
                    if d1 is not None:
                        dirs.add(d1)
                elif db <= 4:
                    d1 = self._dir8(b, a)
                    if d1 is not None:
                        dirs.add(d1)
        for p2 in self.pins:
            if math.hypot(p2['pt'][0] - pt[0], p2['pt'][1] - pt[1]) >= 4:
                continue
            v = self.verts.get(p2['cell'])
            if v is None or v.get('junction') or v.get('is_text') or v.get('is_annotation'):
                continue
            d1 = self._dir8(pt, (v['x'] + v['w'] / 2, v['y'] + v['h'] / 2))
            if d1 is not None:
                dirs.add(d1)
        return dirs

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
            elif len(self._dirs_at(pt)) < 3:
                # RÈGLE UTILISATEUR : un point au milieu d'une ligne
                # (2 connexions au lieu de 3) est INTERDIT
                self.add('dot-2way', 'error',
                         f"point de contact {d['id']} sur une simple traversée "
                         f'({len(self._dirs_at(pt))} directions) — interdit', pt)
        for i, d1 in enumerate(self.dots):
            for d2 in self.dots[i + 1:]:
                if math.hypot(d1['x'] - d2['x'], d1['y'] - d2['y']) < TOL['dot_dup']:
                    self.add('30b', 'warning',
                             f"dots dupliqués {d1['id']} / {d2['id']}", (d1['x'], d1['y']))
        # dots REQUIS : tout point à >=3 directions distinctes (clusters
        # d'extrémités aux pins, et tés sur segment du même net)
        clusters = []
        for w in self.edges:
            pl = self.polys.get(w['id'])
            if pl is None or math.hypot(pl[-1][0] - pl[0][0], pl[-1][1] - pl[0][1]) < 3:
                continue
            for pt, cid in ((pl[0], w['src']), (pl[-1], w['tgt'])):
                net = self.net[w['id']]
                c0 = next((m for m in clusters if m['net'] == net and
                           math.hypot(m['pt'][0] - pt[0], m['pt'][1] - pt[1]) < 5), None)
                if c0 is None:
                    clusters.append({'net': net, 'pt': pt, 'n': 1})
                else:
                    c0['n'] += 1
        for c in clusters:
            if c['n'] < 2:
                continue
            if len(self._dirs_at(c['pt'])) >= 3 and not self._dot_at(c['pt']):
                self.add('30', 'error',
                         'branche à >=3 directions sans point de contact', c['pt'])
        # té : sommet d'un fil sur l'intérieur d'un segment du même net,
        # avec une direction incidente NON colinéaire au segment hôte
        for ea in self.polys:
            pl = self.polys[ea]
            for pi, pt in enumerate(pl):
                inc = []
                if pi > 0:
                    d1 = self._dir8(pt, pl[pi - 1])
                    if d1 is not None:
                        inc.append(d1)
                if pi < len(pl) - 1:
                    d1 = self._dir8(pt, pl[pi + 1])
                    if d1 is not None:
                        inc.append(d1)
                for eb in self.polys:
                    if ea == eb or self.net[ea] != self.net[eb]:
                        continue
                    for b1, b2 in self.segs(eb):
                        if d_point_seg(pt, b1, b2) < 2.5 and \
                           min(math.hypot(pt[0] - q[0], pt[1] - q[1]) for q in (b1, b2)) > 4:
                            horiz = abs(b1[1] - b2[1]) < 0.6
                            axis = (0, 4) if horiz else (2, 6)
                            if inc and all(d1 in axis for d1 in inc):
                                continue
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

    # ---- fil collé au bord d'un corps ; sur le FLANC d'un transistor
    #      (canal/leads) c'est une ERREUR (règle utilisateur : on sort du
    #      nœud horizontalement, jamais le long du canal)
    def check_edge_hug(self):
        for e in self.edges:
            if e['id'] not in self.polys:
                continue
            for a, b in self.segs(e['id']):
                ax = seg_axis(a, b)
                if ax == 'd':
                    continue
                for cid, v in self.verts.items():
                    if v.get('junction') or v.get('is_text') or v.get('is_annotation') or v['h'] < 60:
                        continue
                    x, y, w, h = aabb(v)
                    if ax == 'v' and (abs(a[0] - x) < 2.5 or abs(a[0] - (x + w)) < 2.5):
                        lo, hi = max(min(a[1], b[1]), y), min(max(a[1], b[1]), y + h)
                        if mos_kind(v['shape']) and hi - lo > 12 and e['src'] != e['tgt']:
                            self.add('channel-hug', 'error',
                                     f"fil {e['id']} longe le CANAL de {cid} sur {hi - lo:.0f}px "
                                     '— sortir du nœud horizontalement', (a[0], lo))
                        elif hi - lo > TOL['edge_hug_len']:
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
        if v.get('is_text') or v.get('is_annotation'):
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
    def _seg_feasible(self, e, net, a, b, p, q):
        """Un segment candidat est licite : pas de corps traversé (le sien :
        8 px autour du pin), pas de pin étranger à <5 px, pas de lane
        étrangère à <10 px sur >6 px."""
        for cid, v in self.verts.items():
            if v.get('junction') or v.get('is_annotation') or v['w'] < 12:
                continue
            x, y, w, h = aabb(v)
            r = (x + 1.5, y + 1.5, w - 3, h - 3)
            if r[2] <= 0 or r[3] <= 0:
                continue
            clip = clip_seg_rect(p, q, r)
            if clip is None:
                continue
            if v.get('is_text'):
                return False  # une étiquette bloque aussi (pire qu'un coude)
            if cid not in (e['src'], e['tgt']):
                return False
            own = a if cid == e['src'] else b
            p0, p1 = lerp(p, q, clip[0]), lerp(p, q, clip[1])
            far = max(math.hypot(p0[0] - own[0], p0[1] - own[1]),
                      math.hypot(p1[0] - own[0], p1[1] - own[1]))
            if far > 8:
                return False
        for pp in self.pins:
            if pp['net'] != net and d_point_seg(pp['pt'], p, q) < 5:
                return False
        ax = seg_axis(p, q)
        if ax != 'd':
            for oid, opl in self.polys.items():
                if oid == e['id'] or self.net.get(oid) == net:
                    continue
                for k in range(len(opl) - 1):
                    b1, b2 = opl[k], opl[k + 1]
                    if seg_axis(b1, b2) != ax:
                        continue
                    if ax == 'h':
                        dl = abs(p[1] - b1[1])
                        lo = max(min(p[0], q[0]), min(b1[0], b2[0]))
                        hi = min(max(p[0], q[0]), max(b1[0], b2[0]))
                    else:
                        dl = abs(p[0] - b1[0])
                        lo = max(min(p[1], q[1]), min(b1[1], b2[1]))
                        hi = min(max(p[1], q[1]), max(b1[1], b2[1]))
                    if dl < 10 and hi - lo > 6:
                        return False
        return True

    def _min_bends(self, e, net, a, b):
        """Minimum RÉALISABLE : droit si licite, sinon L, sinon 2 (U) /
        3 (Z contraint) — un U sur lane séparée n'est pas un excès."""
        aligned = abs(a[0] - b[0]) < 1 or abs(a[1] - b[1]) < 1
        if aligned:
            return 0 if self._seg_feasible(e, net, a, b, a, b) else 2
        for c in ((a[0], b[1]), (b[0], a[1])):
            if self._seg_feasible(e, net, a, b, a, c) and self._seg_feasible(e, net, a, b, c, b):
                return 1
        return 3

    def check_bends_crossings(self):
        for e in self.edges:
            if e['id'] not in self.polys or self.edges is None:
                continue
            if e['style'].get('edgeStyle') == 'none':
                continue
            if e['src'] == e['tgt']:
                continue  # cadre de diode : 3 coudes IMPOSÉS (règle 24/32)
            pl = self.polys[e['id']]
            segs = self.segs(e['id'])
            if len(segs) < 1:
                continue
            bends = sum(1 for i in range(len(segs) - 1)
                        if seg_axis(*segs[i]) != seg_axis(*segs[i + 1]))
            a, b = pl[0], pl[-1]
            minb = self._min_bends(e, self.net.get(e['id']), a, b)
            if bends > minb:
                self.add('excess-bends', 'warning',
                         f"fil {e['id']} : {bends} coudes (minimum réalisable {minb})",
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
               if not v.get('junction') and not v.get('is_text') and not v.get('is_annotation')
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

    def check_annotation_clear(self):
        """Un TEXTE d'annotation ne doit pas se poser sur le corps d'un composant.

        DEFECT (2026-08-31) : les cellules `apiAnnotation=1` ont ete exemptees des
        regles de corps (`through`, `too_close`, `edge-hug`, `comp-overlap`) — a
        raison pour les BLOCS, dont le metier est justement d'encadrer des pieces
        et d'etre traverses par des fils. Mais l'exemption a aussi couvert le
        texte, et plus rien ne gardait son placement : seul le nudge interne
        d'`annotate.js` s'en chargeait, c'est-a-dire l'emetteur se certifiant
        lui-meme. Prouve par un test de DEPLACEMENT — poser l'annotation « PA » en
        plein milieu du corps de C9 laissait check.py ET beauty.py rigoureusement
        inchanges (0 err / 12 warn, through=0, too_close=2, label_overlap=0).

        On ne retire pas l'exemption des blocs ; on rend seulement le TEXTE
        mesurable, ce qui est le seul des deux cas ou le chevauchement est un
        defaut et non l'intention.
        """
        texts = [(cid, v) for cid, v in self.verts.items()
                 if v.get('is_annotation') and v.get('is_text')]
        bodies = [(cid, v) for cid, v in self.verts.items()
                  if not v.get('is_annotation') and not v.get('is_text')
                  and not v.get('junction') and v['w'] >= 12]
        # `aabb()` et NON la geometrie brute : un composant tourne (`rotation=90`,
        # la moitie de cette feuille) a une boite brute couchee la ou il est
        # debout. Premiere version de cette regle, comparee au brut, a signale
        # l'annotation « PA » sur L3 : L3 est en fait a x 336..344 une fois
        # tournee, l'annotation a 264..290 — un faux positif pur.
        # Tolerance `ov`: un contact d'une fraction de pixel n'est pas lisible;
        # on ne signale qu'un recouvrement d'au moins 2 px sur les DEUX axes.
        for tid, t in texts:
            tb = aabb(t)
            for bid, b in bodies:
                bb = aabb(b)
                ovx = min(tb[0] + tb[2], bb[0] + bb[2]) - max(tb[0], bb[0])
                ovy = min(tb[1] + tb[3], bb[1] + bb[3]) - max(tb[1], bb[1])
                if ovx >= 2 and ovy >= 2:
                    self.add('annotation-on-body', 'warning',
                             f"annotation {tid} posee sur le corps de {bid} "
                             f"(recouvrement {ovx:.0f}x{ovy:.0f} px)",
                             (tb[0] + tb[2] / 2, tb[1] + tb[3] / 2))
                    break

    def check_orthogonal(self):
        """EXIGENCE UTILISATEUR (2026-08-31) : que des segments HORIZONTAUX ou
        VERTICAUX. Aucune diagonale, nulle part.

        Le routeur emet deja de l'orthogonal (`edgeStyle=orthogonalEdgeStyle`) et
        la mesure au moment ou cette regle a ete ecrite donnait 0 diagonale sur
        54 et 55 segments. C'est donc une GARDE, pas un correctif : elle existe
        pour qu'une future retouche du routeur, du compacteur ou de l'optimiseur
        ne puisse pas reintroduire une oblique en silence. Erreur, pas
        avertissement -- l'utilisateur l'a posee comme une contrainte, pas comme
        une preference.
        """
        for eid, pl in self.polys.items():
            for k in range(len(pl) - 1):
                a, b = pl[k], pl[k + 1]
                dx, dy = abs(b[0] - a[0]), abs(b[1] - a[1])
                if dx < 0.6 and dy < 0.6:
                    continue          # segment degenere, traite ailleurs
                if dx >= 0.6 and dy >= 0.6:
                    self.add('diagonal', 'error',
                             f"fil {eid} : segment oblique ({dx:.0f}x{dy:.0f} px) "
                             '— seuls horizontal et vertical sont autorises',
                             ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))

    def run(self):
        self.check_wrap()
        self.check_comp_overlap()
        self.check_through()
        self.check_net_separation()
        self.check_pin_clearance()
        self.check_dots()
        self.check_annotation_clear()
        self.check_orthogonal()
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
