RCMA outp vcms 200000.0
RCMB outn vcms 200000.0
RDN vcms 0 100000.0
RV1 vcmref vrh 100000.0
RV2 vrh 0 100000.0
M10 tcm vbn 0 0 nmos W=1728u L=0.5u
M8 vcmfb vcms tcm 0 nmos W=10368.8u L=0.5u
M9 dcm vrh tcm 0 nmos W=10368.8u L=0.5u
M11 vcmfb vcmfb vdd vdd pmos W=200u L=1.5u
RST vcmfb 0 200k
M12 dcm dcm vdd vdd pmos W=200u L=1.5u
.end
