* 5-transistor OTA: NMOS pair, PMOS mirror load, NMOS tail
M1 n1 inp tail 0 nmos W=2u L=0.5u
M2 out inm tail 0 nmos W=2u L=0.5u
M3 n1 n1 vdd vdd pmos W=4u L=0.5u
M4 out n1 vdd vdd pmos W=4u L=0.5u
M5 tail vb 0 0 nmos W=4u L=1u
VDD vdd 0 1.2
.end
