* 5T OTA with dummies (layout3d format and detected ones)
XM1 x inn tail vss sg13_lv_nmos w=4.375u l=8u
XM2 out inp tail vss sg13_lv_nmos w=4.375u l=8u
XM3 x x vdd vdd sg13_lv_pmos w=2u l=1u
XM4 out x vdd vdd sg13_lv_pmos w=2u l=1u
XM5 tail vb vss vss sg13_lv_nmos w=4u l=2u
XM6 vb vb vss vss sg13_lv_nmos w=4u l=2u
IB vdd vb 10u
XD1 tail vss tail vss sg13_lv_nmos w=4.375u l=8u dummy=1
XD2 tail vss tail vss sg13_lv_nmos w=4.375u l=8u dummy=1
XD3 x vdd x vdd sg13_lv_pmos w=2u l=1u
XD4 vss vss vss vss sg13_lv_nmos w=4u l=2u
* two dummies in series on a net of their own (dn): local to page 2
XD5 tail vss dn vss sg13_lv_nmos w=4u l=2u dummy=1
XD6 dn vss vss vss sg13_lv_nmos w=4u l=2u dummy=1
.end
