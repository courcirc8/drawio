* Brokaw bandgap of analog-design (projets/bandgap-brokaw, 2026-10-25): the netlist of its
* verifier drawing, net names restored from bloc.sp (our own design, IHP SG13G2 models)
Q1 c1 vb e npn13g2 m=18
Q2 c2 vb e2 npn13g2 m=144
R1 e2 e 142.6k
R2 e 0 571.4k
RC1 vref c1 399.2k
RC2 vref c2 399.2k
RD1_0 vref vb 832.4k
RD24_0 vbd4 0 832.4k
RB_0 vref nb 3599k
MN0 nb nb 0 0 sg13_hv_nmos w=2u l=2u
MNT tail nb 0 0 sg13_hv_nmos w=1u l=2u
M1 d3 c2 tail 0 sg13_hv_nmos w=100u l=2u
M2 o1 c1 tail 0 sg13_hv_nmos w=100u l=2u
M3 d3 d3 vdd vdd sg13_hv_pmos w=10u l=10u
M4 o1 d3 vdd vdd sg13_hv_pmos w=10u l=10u
MP vref o1 vdd vdd sg13_hv_pmos w=10u l=1u
CL vref 0 1e-11
MS vdd gs vref 0 sg13_hv_nmos w=2u l=0.45u
MD gs vref 0 0 sg13_hv_nmos w=2u l=0.45u
MPL0 pl0 0 vdd vdd sg13_hv_pmos w=0.3u l=30u
MPL1 pl1 0 pl0 vdd sg13_hv_pmos w=0.3u l=30u
MPL2 pl2 0 pl1 vdd sg13_hv_pmos w=0.3u l=30u
MPL3 pl3 0 pl2 vdd sg13_hv_pmos w=0.3u l=30u
MPL4 gs 0 pl3 vdd sg13_hv_pmos w=0.3u l=30u
RD20_0 vb vbd1 832.4k
RD21_0 vbd1 vbd2 832.4k
RD22_0 vbd2 vbd3 832.4k
RD23_0 vbd3 vbd4 832.4k
CC o1 z 1000f
RZ z vref 399.2k
.end
