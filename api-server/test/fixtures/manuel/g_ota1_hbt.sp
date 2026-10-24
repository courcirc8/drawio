IB vdd vbn dc 0.0001
M0 vbn vbn 0 0 nmos W=80u L=0.5u
M5 tail vbn 0 0 nmos W=4800u L=0.5u
Q1 o1a inp tail npn W=1u L=1u
Q2 o1b inn tail npn W=1u L=1u
M3 o1a vcmfb vdd vdd pmos W=600u L=1.5u
M4 o1b vcmfb vdd vdd pmos W=600u L=1.5u
M6A outp o1a vdd vdd pmos W=2499.9u L=0.3u
M6B outn o1b vdd vdd pmos W=2499.9u L=0.3u
M7A outp vbn 0 0 nmos W=960u L=0.5u
M7B outn vbn 0 0 nmos W=960u L=0.5u
CCA o1a za 0.497p
RZA za outp 100
CCB o1b zb 0.497p
RZB zb outn 100
RCMA outp vcms 200000.0
RCMB outn vcms 200000.0
RDN vcms 0 100000.0
RV1 vcmref vrh 100000.0
RV2 vrh 0 100000.0
M10 tcm vbn 0 0 nmos W=432u L=0.5u
M8 vcmfb vcms tcm 0 nmos W=2592.2u L=0.5u
M9 dcm vrh tcm 0 nmos W=2592.2u L=0.5u
M11 vcmfb vcmfb vdd vdd pmos W=60u L=1.5u
RST vcmfb 0 200k
M12 dcm dcm vdd vdd pmos W=60u L=1.5u
.end
