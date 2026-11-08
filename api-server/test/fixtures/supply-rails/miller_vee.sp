* two-stage Miller OTA on vdd / vee (no 0 net): vee is the bottom rail (Eric 08.11)
IB vdd vb dc 20u
M8 vb vb vee vee nmos W=10u L=1u
M5 tail vb vee vee nmos W=20u L=1u
M1 x inn tail vee nmos W=20u L=vee.5u
M2 o1 inp tail vee nmos W=20u L=vee.5u
M3 x x vdd vdd pmos W=10u L=vee.5u
M4 o1 x vdd vdd pmos W=10u L=vee.5u
M6 out o1 vdd vdd pmos W=80u L=vee.5u
M7 out vb vee vee nmos W=40u L=1u
RZ o1 cz 2k
CC cz out 1p
CL out vee 2p
.end
