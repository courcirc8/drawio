#!/usr/bin/env python3
"""Harnais d'exigences du checker Python (tools/check.py).

Chaque fixture de benchmark/regression/ (sorties FIGÉES du commit 92fc973,
celles où la revue adversariale a trouvé des fautes) est associée aux
violations que le checker DOIT rapporter. S'y ajoutent les faux négatifs
synthétiques FN-A..FN-F de la revue, reconstruits en XML minimal.

Usage : python3 tools/test-check.py   (exit 1 si une exigence manque)
"""
import json
import math
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REG = os.path.join(HERE, '..', 'benchmark', 'regression')
NL = os.path.join(HERE, '..', 'benchmark', 'netlists')
CHECK = os.path.join(HERE, 'check.py')


def run(xml, netlist=None):
    cmd = [sys.executable, CHECK, xml, '--json']
    if netlist:
        cmd += ['--netlist', netlist]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if not p.stdout.strip():
        raise AssertionError(f'checker sans sortie sur {xml}: {p.stderr}')
    return json.loads(p.stdout)


def expect(result, name, rule, contains=None, near=None, count=1):
    """Exige >= count violations de `rule` (filtrées par sous-chaîne/position)."""
    hits = [v for v in result['violations'] if v['rule'] == rule]
    if contains:
        hits = [v for v in hits if contains in v['message']]
    if near:
        hits = [v for v in hits if v.get('at') and
                math.hypot(v['at'][0] - near[0], v['at'][1] - near[1]) < 25]
    if len(hits) >= count:
        return []
    return [f"{name}: attendu [{rule}]"
            + (f" contenant « {contains} »" if contains else '')
            + (f' près de {near}' if near else '')
            + f' (trouvé {len(hits)}/{count})']


def forbid(result, name, rule):
    hits = [v for v in result['violations'] if v['rule'] == rule]
    if hits:
        return [f'{name}: [{rule}] ne devrait PAS être rapporté : {hits[0]["message"]}']
    return []


FRAME = ('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
         '{cells}</root></mxGraphModel>')
R = ('<mxCell id="{id}" value="{val}" style="shape=mxgraph.electrical.resistors.'
     'resistor_2;html=1;verticalLabelPosition=bottom;verticalAlign=top;" vertex="1"'
     ' parent="1"><mxGeometry x="{x}" y="{y}" width="100" height="20" as="geometry"/></mxCell>')
MOS = ('<mxCell id="{id}" value="{val}" style="shape=mxgraph.electrical.transistors.nmos;'
       'html=1;verticalLabelPosition=bottom;verticalAlign=top;{extra}" vertex="1" parent="1">'
       '<mxGeometry x="{x}" y="{y}" width="70" height="110" as="geometry"/></mxCell>')
WIRE = ('<mxCell id="{id}" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX={ex};exitY={ey};'
        'exitDx=0;exitDy=0;exitPerimeter=0;entryX={nx};entryY={ny};entryDx=0;entryDy=0;'
        'entryPerimeter=0;" edge="1" parent="1" source="{src}" target="{tgt}">'
        '<mxGeometry relative="1" as="geometry">{pts}</mxGeometry></mxCell>')
DOT = ('<mxCell id="{id}" style="ellipse;drawioApiJunction=1;contactDot=1;" vertex="1" '
       'parent="1"><mxGeometry x="{x}" y="{y}" width="6" height="6" as="geometry"/></mxCell>')


def pts(*xy):
    if not xy:
        return ''
    inner = ''.join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in xy)
    return f'<Array as="points">{inner}</Array>'


def synth(name, cells):
    path = os.path.join(tempfile.gettempdir(), f'chk-{name}.xml')
    with open(path, 'w') as f:
        f.write(FRAME.format(cells=''.join(cells)))
    return path


def main():
    fails = []

    # ---------------- fixtures de production (trouvailles de la revue) ----
    g = run(os.path.join(REG, 'gilbert-mixer.xml'), os.path.join(NL, 'gilbert-mixer.cir'))
    fails += expect(g, 'gilbert', 'pin-clearance', near=(345, 385))   # fil net a SUR le pin source de M5
    fails += expect(g, 'gilbert', 'dot-foreign', near=(345, 385))     # dot du net b posé sur le fil du net a
    fails += expect(g, 'gilbert', '29', near=(345, 430))              # w2085/w2086 à 5px sur 190px
    fails += expect(g, 'gilbert', 'label-on-wire')                    # étiquettes NMOS barrées
    fails += expect(g, 'gilbert', 'unlabeled-net', contains='lop')    # entrées LO absentes
    fails += expect(g, 'gilbert', 'unlabeled-net', contains='lom')

    o = run(os.path.join(REG, 'ota-cmos.xml'), os.path.join(NL, 'ota-cmos.cir'))
    fails += expect(o, 'ota', 'through', contains='M8')               # bus de gates à travers M8
    fails += expect(o, 'ota', 'label-on-wire')

    b = run(os.path.join(REG, 'biquad-gmc.xml'), os.path.join(NL, 'biquad-gmc.cir'))
    fails += expect(b, 'biquad', 'rail-mislabel')                     # net in déguisé en VDD
    fails += expect(b, 'biquad', 'through')                           # w1080 à travers gm1

    l = run(os.path.join(REG, 'lna-complet.xml'))
    fails += expect(l, 'lna-complet', 'edge-hug')                     # boucle de diode collée au flanc de M4

    # fixture 2026-08-30 : Lb1 monté à l'envers, fil en Π autour de la bobine
    lw = run(os.path.join(REG, 'lna-complet-wrap.xml'))
    fails += expect(lw, 'lna-complet-wrap', 'wrap-around')

    # fixture 2026-08-30 : dots de simple traversée (2 connexions) — interdits
    l2 = run(os.path.join(REG, 'lna-complet-dot2way.xml'))
    fails += expect(l2, 'lna-complet-dot2way', 'dot-2way', count=3)

    # les 3 restantes ne doivent pas PLANTER, et leurs violations sont listées
    for name in ('vco-lc', 'rc-filter', 'lna-shaeffer-lee'):
        run(os.path.join(REG, name + '.xml'))

    # ---------------- faux négatifs synthétiques de la revue --------------
    # FN-A1 : deux nets parallèles à 8 px sur 230 px
    x = synth('fnA1', [
        R.format(id='A', val='', x=0, y=90), R.format(id='B', val='', x=400, y=90),
        R.format(id='C', val='', x=0, y=290), R.format(id='D', val='', x=400, y=290),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5,
                    pts=pts((150, 100), (380, 100))),
        WIRE.format(id='w2', src='C', tgt='D', ex=1, ey=0.5, nx=0, ny=0.5,
                    pts=pts((150, 108), (380, 108))),
    ])
    fails += expect(run(x), 'FN-A1', '22')

    # FN-A2 : deux nets sur la MÊME lane, recouvrement de 11 px seulement
    x = synth('fnA2', [
        R.format(id='A', val='', x=0, y=370), R.format(id='B', val='', x=200, y=90),
        R.format(id='C', val='', x=250, y=90), R.format(id='D', val='', x=430, y=370),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5,
                    pts=pts((150, 380), (300, 380), (300, 200))),
        WIRE.format(id='w2', src='C', tgt='D', ex=1, ey=0.5, nx=1, ny=0.5,
                    pts=pts((380, 200), (380, 380), (289, 380))),
    ])
    fails += expect(run(x), 'FN-A2', '22')

    # FN-B : fil 2 px à l'intérieur du corps d'un MOS étranger
    x = synth('fnB', [
        R.format(id='A', val='', x=0, y=42), R.format(id='B', val='', x=400, y=42),
        MOS.format(id='M', val='', x=220, y=50, extra=''),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5, pts=''),
    ])
    fails += expect(run(x), 'FN-B', 'through', contains='M')

    # FN-C : té même net sans dot + superposition même net non fusionnée
    x = synth('fnC', [
        R.format(id='A', val='', x=0, y=90), R.format(id='B', val='', x=300, y=90),
        R.format(id='C', val='', x=150, y=290),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5, pts=''),
        WIRE.format(id='w2', src='B', tgt='C', ex=0, ey=0.5, nx=0.5, ny=0,
                    pts=pts((200, 100), (200, 290))),
    ])
    r = run(x)
    fails += expect(r, 'FN-C', '30', near=(200, 100))
    fails += expect(r, 'FN-C', '29')

    # FN-D : fil passant par le pin de gate d'un MOS étranger
    x = synth('fnD', [
        R.format(id='A', val='', x=0, y=95), R.format(id='B', val='', x=400, y=95),
        MOS.format(id='M', val='', x=250, y=50, extra=''),
        R.format(id='E', val='', x=150, y=290),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5, pts=''),
        WIRE.format(id='w2', src='M', tgt='E', ex=0, ey=0.5, nx=0.5, ny=0,
                    pts=pts((200, 105), (200, 290))),
    ])
    fails += expect(run(x), 'FN-D', 'pin-clearance', near=(250, 105))

    # FN-F : paire différentielle décalée de 13 px (source commune)
    x = synth('fnF', [
        MOS.format(id='M1', val='', x=100, y=100, extra=''),
        MOS.format(id='M2', val='', x=400, y=113, extra='flipH=1;'),
        R.format(id='T', val='', x=250, y=400),
        WIRE.format(id='w1', src='M1', tgt='T', ex=1, ey=1, nx=0.5, ny=0, pts=''),
        WIRE.format(id='w2', src='M2', tgt='T', ex=1, ey=1, nx=0.5, ny=0, pts=''),
    ])
    fails += expect(run(x), 'FN-F', '14')

    # anti-faux-positifs : un L propre entre deux composants ne déclenche rien
    x = synth('clean', [
        R.format(id='A', val='1k', x=0, y=90), R.format(id='B', val='2k', x=400, y=290),
        WIRE.format(id='w1', src='A', tgt='B', ex=1, ey=0.5, nx=0, ny=0.5,
                    pts=pts((400, 100))),
    ])
    r = run(x)
    for rule in ('through', '22', 'pin-clearance', '30', '29', '14'):
        fails += forbid(r, 'clean', rule)

    print()
    if fails:
        print(f'✗ {len(fails)} exigence(s) non satisfaite(s) :')
        for f in fails:
            print('  -', f)
        sys.exit(1)
    print('✓ toutes les exigences du harnais sont satisfaites')


if __name__ == '__main__':
    main()
