* Brokaw bandgap of analog-design (bandgap-test/bloc.py -> projets/bandgap-brokaw/schemas/bloc.sp, 2026-10-25), our own design
VDD vdd 0 3.3
XR1_0 e2 R1_0 0 rppd w=2.0u l=138.48u m=1
XR1_1 R1_0 e 0 rppd w=2.0u l=138.48u m=1
XR2_0 e R2_0 0 rppd w=2.0u l=550.22u m=1
XR2_1 R2_0 0 0 rppd w=2.0u l=550.22u m=1
XRC1_0 vref RC1_0 0 rppd w=2.0u l=388.17u m=1
XRC1_1 RC1_0 c1 0 rppd w=2.0u l=388.17u m=1
XRC2_0 vref RC2_0 0 rppd w=2.0u l=388.17u m=1
XRC2_1 RC2_0 c2 0 rppd w=2.0u l=388.17u m=1
XRD1_0 vref vb 0 rhigh w=2.0u l=281.43u m=1
XRD20_0 vb vbd1 0 rhigh w=2.0u l=281.43u m=1
XRD21_0 vbd1 vbd2 0 rhigh w=2.0u l=281.43u m=1
XRD22_0 vbd2 vbd3 0 rhigh w=2.0u l=281.43u m=1
XRD23_0 vbd3 vbd4 0 rhigh w=2.0u l=281.43u m=1
XRD24_0 vbd4 0 0 rhigh w=2.0u l=281.43u m=1
XRB_0 vref nb 0 rhigh w=2.0u l=1217.2u m=1
XMN0 nb nb 0 0 sg13_hv_nmos w=2u l=2u ng=1
XMNT tail nb 0 0 sg13_hv_nmos w=1u l=2u ng=1
XM1 d3 c2 tail 0 sg13_hv_nmos w=100u l=2u ng=20
XM2 o1 c1 tail 0 sg13_hv_nmos w=100u l=2u ng=20
XM3 d3 d3 vdd vdd sg13_hv_pmos w=10u l=10u ng=2
XM4 o1 d3 vdd vdd sg13_hv_pmos w=10u l=10u ng=2
XMP vref o1 vdd vdd sg13_hv_pmos w=10u l=1u ng=2
XCC o1 z cap_cmim w=25.77u l=25.77u
CL vref 0 1e-11
XMS vdd gs vref 0 sg13_hv_nmos w=2u l=0.45u ng=1
XMD gs vref 0 0 sg13_hv_nmos w=2u l=0.45u ng=1
XMPL0 pl0 0 vdd vdd sg13_hv_pmos w=0.3u l=30u ng=1
XMPL1 pl1 0 pl0 vdd sg13_hv_pmos w=0.3u l=30u ng=1
XMPL2 pl2 0 pl1 vdd sg13_hv_pmos w=0.3u l=30u ng=1
XMPL3 pl3 0 pl2 vdd sg13_hv_pmos w=0.3u l=30u ng=1
XMPL4 gs 0 pl3 vdd sg13_hv_pmos w=0.3u l=30u ng=1
XQ1 c1 vb e 0 npn13G2 Nx=18
XQ2 c2 vb e2 0 npn13G2 Nx=144
XRZ vref z 0 rppd w=2.0u l=776.34u m=1
.end
