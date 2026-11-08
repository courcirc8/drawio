* LOADMIR as layout3d sends it (layout-essais run 20261108-0809-ota5t-loadmir-6, IHP SG13G2 open PDK, fingers merged):
* a PMOS mirror load and a dummy, one supply (power_ana), no ground net; XM5 extracted with its drain on the supply
XM4 von power_ana power_ana power_ana sg13_lv_pmos w=5u l=1u
XM5 power_ana von von power_ana sg13_lv_pmos w=15u l=1u
XM8 vout von power_ana power_ana sg13_lv_pmos w=15u l=1u
.end
