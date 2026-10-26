* fixture from the review of drawio#63 (deploiements/revue-63-scratch/adv/case1.sp, written by the reviewer, 2026-10-25)
* only difference with multi.sp: port names of inv in upper case
.subckt inv IN OUT VDD
M1 OUT IN VDD VDD pmos W=2u L=0.18u
M2 OUT IN 0 0 nmos W=1u L=0.18u
.ends inv
VDD vdd 0 1.8
VIN in 0 DC 0.9
XB1 in a vdd inv
XB2 a out vdd inv
RL out 0 10k
.end
