* two-stage Miller OTA, PMOS bias mirror XM11 -> XM10 (tail), XM9 (output); IHP SG13G2 open PDK
XM2 out o1 vss vss sg13_hv_nmos w=70u l=1u
XM4 d3 d3 vss vss sg13_hv_nmos w=40u l=8u
XM5 o1 d3 vss vss sg13_hv_nmos w=40u l=8u
XM7 d3 inp tail vdd sg13_hv_pmos w=200u l=2u
XM8 o1 inn tail vdd sg13_hv_pmos w=200u l=2u
XM9 out vbp vdd vdd sg13_hv_pmos w=14u l=2u
XM10 tail vbp vdd vdd sg13_hv_pmos w=5u l=2u
XM11 vbp vbp vdd vdd sg13_hv_pmos w=2u l=2u
XR12 z out rhigh w=0.5u l=22.53u
XC13 o1 z cap_cmim w=32.19u l=32.19u
.end
