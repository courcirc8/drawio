* two-stage Miller OTA, PMOS input pair, PMOS tail from vdd (witness, generic models)
IB vbp 0 dc 10u
M0 vbp vbp vdd vdd pmos W=1u L=2u
M5 tail vbp vdd vdd pmos W=5u L=2u
M1 x inp tail vdd pmos W=245u L=2u
M2 o1 inn tail vdd pmos W=245u L=2u
M3 x x 0 0 nmos W=28u L=8u
M4 o1 x 0 0 nmos W=28u L=8u
M6 out o1 0 0 nmos W=120u L=0.6u
M7 out vbp vdd vdd pmos W=12u L=2u
RZ o1 cz 56k
CC cz out 1.6p
CL out 0 10p
.end
