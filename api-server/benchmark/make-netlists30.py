#!/usr/bin/env python3
"""Genere les 30 netlists cibles (benchmark/netlists30/) ancrees sur la
bibliotheque rf-collection (training-set.json topics). Les 6 du benchmark
historique sont copiees, 24 topologies de publication sont ajoutees."""
import os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'netlists30')
os.makedirs(OUT, exist_ok=True)

# 6 existants
for f in os.listdir(os.path.join(HERE, 'netlists')):
    if f.endswith('.cir'):
        shutil.copy(os.path.join(HERE, 'netlists', f), os.path.join(OUT, f))

N = {}

N['ota-5t'] = """* OTA 5 transistors (biblio: ampli/ota, razavi_G_RDec03)
M1 a inp s 0 NMOS
M2 out inm s 0 NMOS
M3 a a vdd vdd PMOS
M4 out a vdd vdd PMOS
M5 s vb 0 0 NMOS
M6 vb vb 0 0 NMOS
I1 vdd vb 20u
.end"""

N['folded-cascode'] = """* OTA folded cascode (biblio: ampli/ota, isscc99p-bendik)
M0 t vb1 vdd vdd PMOS
M1 f1 inp t vdd PMOS
M2 f2 inm t vdd PMOS
M3 f1 vb4 0 0 NMOS
M4 f2 vb4 0 0 NMOS
M5 outm vb3 f1 0 NMOS
M6 outp vb3 f2 0 NMOS
M7 outm vb2 c1 vdd PMOS
M8 outp vb2 c2 vdd PMOS
M9 c1 vb1 vdd vdd PMOS
M10 c2 vb1 vdd vdd PMOS
.end"""

N['telescopic-ota'] = """* OTA telescopique (biblio: ampli/ota, razavi_G_RDec04)
M1 x1 inp s 0 NMOS
M2 x2 inm s 0 NMOS
M3 outm vb2 x1 0 NMOS
M4 outp vb2 x2 0 NMOS
M5 outm vb3 y1 vdd PMOS
M6 outp vb3 y2 vdd PMOS
M7 y1 vb4 vdd vdd PMOS
M8 y2 vb4 vdd vdd PMOS
M9 s vb1 0 0 NMOS
.end"""

N['strongarm-latch'] = """* Comparateur StrongARM (biblio: adc/dac, razavi_S_RJSSC09)
M1 x inp t 0 NMOS
M2 y inm t 0 NMOS
M3 outm outp x 0 NMOS
M4 outp outm y 0 NMOS
M5 outm outp vdd vdd PMOS
M6 outp outm vdd vdd PMOS
M7 outm clk vdd vdd PMOS
M8 outp clk vdd vdd PMOS
M9 t clk 0 0 NMOS
.end"""

N['bandgap-core'] = """* Reference bandgap a BJT (biblio: adc/dac, razavi_BRAug13)
Q1 0 0 e1 PNP
Q2 0 0 e2 PNP
R1 x e2 10k
M1 a a e1 0 NMOS
M2 b a x 0 NMOS
M3 a c vdd vdd PMOS
M4 b b vdd vdd PMOS
M5 c b vdd vdd PMOS
R2 c 0 50k
.end"""

N['beta-multiplier'] = """* Polarisation beta-multiplier (biblio: ampli/ota)
M1 a a 0 0 NMOS
M2 b a s 0 NMOS
R1 s 0 5k
M3 a b vdd vdd PMOS
M4 b b vdd vdd PMOS
.end"""

N['charge-pump'] = """* Pompe de charge PLL (biblio: pll/synth, razavi_A_RMar01)
M1 x vb1 vdd vdd PMOS
M2 out upb x vdd PMOS
M3 out dn y 0 NMOS
M4 y vb2 0 0 NMOS
C1 out 0 10p
.end"""

N['ring-vco3'] = """* VCO en anneau 3 etages (biblio: vco/osc, islped98p-tam)
M1 osc2 osc1 vdd vdd PMOS
M2 osc2 osc1 0 0 NMOS
M3 osc3 osc2 vdd vdd PMOS
M4 osc3 osc2 0 0 NMOS
M5 osc1 osc3 vdd vdd PMOS
M6 osc1 osc3 0 0 NMOS
C1 osc1 0 50f
.end"""

N['colpitts-osc'] = """* Oscillateur Colpitts BJT (biblio: vco/osc, razavi_RCICC2003)
L1 vdd osc 5n
Q1 osc b e NPN
C1 osc e 2p
C2 e 0 4p
R1 vdd b 40k
R2 b 0 20k
R3 e 0 1k
.end"""

N['lna-cs-cascode'] = """* LNA source commune degeneree (biblio: lna, arxiv_1807.10306v1)
L1 in g 8n
M1 x g s 0 NMOS
L2 s 0 1n
M2 out vb1 x 0 NMOS
L3 vdd out 6n
C1 out 0 300f
R1 vb2 g 5k
.end"""

N['lna-common-gate'] = """* LNA grille commune (biblio: lna, VLSI96p-derek)
M1 out vb in 0 NMOS
L1 in 0 4n
L2 vdd out 6n
C1 in rf 1p
C2 out 0 200f
.end"""

N['mixer-passive-ring'] = """* Melangeur passif en anneau (biblio: mixer, arxiv_2212.03162v1)
M1 ifp lop rfp 0 NMOS
M2 ifm lom rfp 0 NMOS
M3 ifm lop rfm 0 NMOS
M4 ifp lom rfm 0 NMOS
C1 ifp 0 1p
C2 ifm 0 1p
.end"""

N['mixer-single-balanced'] = """* Melangeur simple-balance (biblio: mixer, razavi_RISSCC96)
M1 a rf 0 0 NMOS
M2 outp lop a 0 NMOS
M3 outm lom a 0 NMOS
R1 vdd outp 1k
R2 vdd outm 1k
.end"""

N['pa-class-a'] = """* Etage PA classe A (biblio: pa, razavi_RFIC11CK_BR)
L1 vdd d 3n
M1 d g 0 0 NMOS
C1 in g 2p
R1 vb g 10k
C2 d m 1p
L2 m out 2n
C3 out 0 500f
.end"""

N['source-follower'] = """* Suiveur de source polarise (biblio: ampli/ota)
M1 vdd in out 0 NMOS
M2 out vb 0 0 NMOS
M3 vb vb 0 0 NMOS
I1 vdd vb 50u
C1 out 0 1p
.end"""

N['diffpair-resistive'] = """* Paire differentielle a charge resistive (biblio: ampli/ota, mwscas00p-joel)
M1 outp inp s 0 NMOS
M2 outm inm s 0 NMOS
R1 vdd outp 2k
R2 vdd outm 2k
M3 s vb 0 0 NMOS
M4 vb vb 0 0 NMOS
I1 vdd vb 100u
.end"""

N['cherry-hooper'] = """* Amplificateur Cherry-Hooper (biblio: serdes/io, JSSC00MAY-ramin)
M1 a inp s1 0 NMOS
M2 b inm s1 0 NMOS
I1 s1 0 1m
M3 outm a s2 0 NMOS
M4 outp b s2 0 NMOS
I2 s2 0 1m
R1 a outp 800
R2 b outm 800
R3 vdd outp 400
R4 vdd outm 400
.end"""

N['cml-buffer'] = """* Tampon CML (biblio: serdes/io, razavi_Abishek_JSSC17)
M1 outm inp s 0 NMOS
M2 outp inm s 0 NMOS
R1 vdd outm 500
R2 vdd outp 500
M3 s vb 0 0 NMOS
.end"""

N['vco-lc-tail-filter'] = """* VCO LC a filtre de queue (biblio: vco/osc, JSSC99MAY-ali)
L1 vdd outp 2n
L2 vdd outm 2n
C1 outp outm 800f
M1 outp outm s 0 NMOS
M2 outm outp s 0 NMOS
L3 s t 1n
C2 s 0 5p
M3 t vb 0 0 NMOS
.end"""

N['lna-diff-cascode'] = """* LNA differentiel cascode (biblio: lna, arxiv_2509.02224v1)
L1 rfp g1 6n
M1 x1 g1 s1 0 NMOS
L2 s1 0 800p
M2 outp vb1 x1 0 NMOS
L3 vdd outp 4n
L4 rfm g2 6n
M3 x2 g2 s2 0 NMOS
L5 s2 0 800p
M4 outm vb1 x2 0 NMOS
L6 vdd outm 4n
.end"""

N['ota-miller-nulling'] = """* OTA Miller a resistance d annulation (biblio: ampli/ota)
M1 a inp s 0 NMOS
M2 b inm s 0 NMOS
M3 a a vdd vdd PMOS
M4 b a vdd vdd PMOS
M5 s vb 0 0 NMOS
M6 out b vdd vdd PMOS
M7 out vb 0 0 NMOS
M8 vb vb 0 0 NMOS
I1 vdd vb 20u
R1 b z 2k
CC z out 2p
.end"""

N['wilson-mirror'] = """* Miroir de Wilson charge (biblio: ampli/ota)
I1 vdd a 100u
M1 out a b 0 NMOS
M2 a b 0 0 NMOS
M3 b b 0 0 NMOS
R1 vdd out 5k
.end"""

N['pierce-xtal'] = """* Oscillateur Pierce a quartz (biblio: vco/osc, iwdmic98p-raf)
M1 osc xin vdd vdd PMOS
M2 osc xin 0 0 NMOS
R1 xin osc 1meg
L1 xin q1 8m
C1 q1 q2 4f
R2 q2 osc 50
C2 xin 0 12p
C3 osc 0 12p
.end"""

N['sallen-key-gmc'] = """* Filtre Sallen-Key a OTA (biblio: adc/dac, razavi_W_RMar00)
R1 in n1 10k
R2 n1 n2 10k
C1 n1 out 100p
C2 n2 0 100p
G1 out 0 n2 out 1m
R3 out 0 100k
.end"""

for name, txt in N.items():
    with open(os.path.join(OUT, name + '.cir'), 'w') as f:
        f.write(txt + '\n')

print(f"{len(os.listdir(OUT))} netlists dans {OUT}")
