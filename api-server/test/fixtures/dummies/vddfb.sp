* Review #81 pass 3, probe vddfb (Orchestrator review, deploiements/revue-drawio-81/probe3/vddfb.sp)
* signal named vdd_fb (feedback divider tap) with a dummy on it: name-recognised as a supply
XM1 out vin vdd_fb vss sg13_lv_nmos w=2u l=0.13u
XM2 vdd_fb vb vss vss sg13_lv_nmos w=2u l=0.13u
XD1 vdd_fb vdd vdd vdd sg13_lv_pmos w=2u l=0.13u dummy=1
.end
