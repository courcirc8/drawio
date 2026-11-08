* ota5t cell as layout3d sends it (our own IHP SG13G2 layout run, 20261108-1637-ota5t-43): fingers, dummies, one .subckt
.subckt cellule ground_ana vtail vout vinn von vinp ibias power_ana
XM25 vtail ground_ana ground_ana ground_ana sg13_lv_nmos w=5u l=2u m=2
XM26 vout vinn vtail ground_ana sg13_lv_nmos w=5u l=2u m=8
XM28 von vinp vtail ground_ana sg13_lv_nmos w=5u l=2u m=8
XM85 ground_ana ibias ground_ana ground_ana sg13_lv_nmos w=3u l=1.5u m=6
XM88 ibias ibias ground_ana ground_ana sg13_lv_nmos w=3u l=1.5u m=4
XM90 vtail ibias ground_ana ground_ana sg13_lv_nmos w=3u l=1.5u m=8
XM154 von power_ana power_ana power_ana sg13_lv_pmos w=7.5u l=1u m=2
XM155 power_ana von von power_ana sg13_lv_pmos w=7.5u l=1u m=2
XM156 vout von power_ana power_ana sg13_lv_pmos w=7.5u l=1u m=2
XM1 ground_ana ground_ana ground_ana ground_ana sg13_lv_nmos w=5u l=2u dummy=1 m=48
XM67 ground_ana ground_ana ground_ana ground_ana sg13_lv_nmos w=3u l=1.5u dummy=1 m=54
XM139 power_ana power_ana power_ana power_ana sg13_lv_pmos w=7.5u l=1u dummy=1 m=30
.ends
.end
