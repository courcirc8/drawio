* two-stage Miller OTA (witness, generic models)
IB vdd vb dc 20u
M8 vb vb 0 0 nmos W=10u L=1u
M5 tail vb 0 0 nmos W=20u L=1u
M1 x inn tail 0 nmos W=20u L=0.5u
M2 o1 inp tail 0 nmos W=20u L=0.5u
M3 x x vdd vdd pmos W=10u L=0.5u
M4 o1 x vdd vdd pmos W=10u L=0.5u
M6 out o1 vdd vdd pmos W=80u L=0.5u
M7 out vb 0 0 nmos W=40u L=1u
RZ o1 cz 2k
CC cz out 1p
CL out 0 2p
.end
