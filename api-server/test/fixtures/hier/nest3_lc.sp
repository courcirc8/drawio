* fixture from the review of drawio#63 (deploiements/revue-63-scratch/adv/nest3_lc.sp, written by the reviewer, 2026-10-25)
* adversarial: 3 nested levels, same cell used twice, port-case mismatch, PDK prims with m/nf
.SUBCKT INVX in out vdd vss
XMP out in vdd vdd sg13_lv_pmos w=2u l=0.13u ng=2 m=2
XMN out in vss vss sg13_lv_nmos w=1u l=0.13u ng=1 m=1
.ENDS INVX
.subckt buf2 a y vdd vss
xi1 a mid vdd vss invx
xi2 mid y vdd vss INVX
XC1 mid vss cap_cmim w=5u l=5u m=1
.ends buf2
.subckt chainx in out vdd vss
XB1 in m1 vdd vss BUF2
XB2 m1 out vdd vss buf2
XR1 m1 vss rppd w=0.5u l=4u m=1 b=0
.ends chainx
VDD vdd 0 1.2
VIN in 0 DC 0.6
XTOP1 in o1 vdd 0 chainx
XTOP2 o1 out vdd 0 CHAINX
RL out 0 10k
.end
