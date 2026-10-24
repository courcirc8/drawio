IB vdd vbn dc 0.0001
M0 vbn vbn 0 0 nmos W=80u L=0.5u
M5 tail vbn 0 0 nmos W=9600u L=0.5u
M1 d1a inp tail 0 nmos W=15600u L=0.13u
M2 d1b inn tail 0 nmos W=15600u L=0.13u
MCNA o1a vcn d1a 0 nmos W=7000u L=0.13u
MCNB o1b vcn d1b 0 nmos W=7000u L=0.13u
MCPA o1a vcp p1a vdd pmos W=8000u L=0.3u
MCPB o1b vcp p1b vdd pmos W=8000u L=0.3u
RBN1 vdd vcn 100000.0
RBN2 vcn 0 500000.0
RBP1 vdd vcp 650000.0
RBP2 vcp 0 550000.0
M3 p1a vcmfb vdd vdd pmos W=2000u L=1.5u
M4 p1b vcmfb vdd vdd pmos W=2000u L=1.5u
M6A outp o1a vdd vdd pmos W=4000u L=0.3u
M6B outn o1b vdd vdd pmos W=4000u L=0.3u
M7A outp vbn 0 0 nmos W=1600u L=0.5u
M7B outn vbn 0 0 nmos W=1600u L=0.5u
CCA o1a za 0.497p
RZA za outp 100
CCB o1b zb 0.497p
RZB zb outn 100
.end
