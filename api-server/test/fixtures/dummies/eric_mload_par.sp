* MLOAD flat with dummies and parasitic estimates (lvs_ignore=1, Eric 08.11)
XM3 d3 d3 vss vss sg13_hv_nmos w=35u l=8u ng=8
XM4 o1 d3 vss vss sg13_hv_nmos w=35u l=8u ng=8
XM5 vss vss vss vss sg13_hv_nmos w=4.375u l=8u dummy=1
XM6 d3 vss d3 vss sg13_hv_nmos w=4.375u l=8u dummy=1
XM7 o1 vss o1 vss sg13_hv_nmos w=4.375u l=8u dummy=1
Cp1 d3 vss 12.5f lvs_ignore=1
Cp2 o1 vss 8.1f lvs_ignore=1
Cp3 d3 o1 0.9f lvs_ignore=1
.end
