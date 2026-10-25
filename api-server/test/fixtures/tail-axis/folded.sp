* folded cascode, PMOS input, PMOS tail transistor (witness)
M0 t vbt vdd vdd pmos W=20u L=1u
M1 fa inp t vdd pmos W=10u L=0.5u
M2 fb inn t vdd pmos W=10u L=0.5u
M3 fa vb4 0 0 nmos W=10u L=1u
M4 fb vb4 0 0 nmos W=10u L=1u
M5 o1 vb1 fa 0 nmos W=5u L=0.5u
M6 o2 vb1 fb 0 nmos W=5u L=0.5u
M7 o1 vb2 p1 vdd pmos W=10u L=0.5u
M8 o2 vb2 p2 vdd pmos W=10u L=0.5u
M9 p1 vb3 vdd vdd pmos W=10u L=1u
M10 p2 vb3 vdd vdd pmos W=10u L=1u
.end
