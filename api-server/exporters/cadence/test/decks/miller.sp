* two-stage Miller OTA
M1 n1 inm tail 0 nmos W=2u L=0.5u
M2 n2 inp tail 0 nmos W=2u L=0.5u
M3 n1 n1 vdd vdd pmos W=4u L=0.5u
M4 n2 n1 vdd vdd pmos W=4u L=0.5u
M5 tail vb 0 0 nmos W=4u L=1u
M6 out n2 vdd vdd pmos W=16u L=0.5u
M7 out vb 0 0 nmos W=8u L=1u
CC n2 out 2p
VDD vdd 0 1.2
.end
