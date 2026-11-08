* MLOAD with dummies (layout3d format)
.subckt MLOAD d3 o1 vss
XM3 d3 d3 vss vss sg13_hv_nmos w=35u l=8u ng=8
XM4 o1 d3 vss vss sg13_hv_nmos w=35u l=8u ng=8
XM5 vss vss vss vss sg13_hv_nmos w=4.375u l=8u dummy=1
XM6 d3 vss d3 vss sg13_hv_nmos w=4.375u l=8u dummy=1
XM7 o1 vss o1 vss sg13_hv_nmos w=4.375u l=8u dummy=1
.ends
.end
