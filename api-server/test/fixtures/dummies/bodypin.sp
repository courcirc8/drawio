* vbody: a .subckt pin, on page 1 only as bulk of an NMOS and a PMOS (so not a supply): no standalone port, a
* warning; vbd: a pin only the dummy XD1 uses: its port on page 1. Review #81 (3), (4)
.subckt bp inp out vbody vbd vdd vss
XM1 out inp vss vbody sg13_lv_nmos w=2u l=0.13u
XM2 out inp vdd vbody sg13_lv_pmos w=2u l=0.13u
XD1 vbd vdd vdd vdd sg13_lv_pmos w=2u l=0.13u dummy=1
.ends
.end
