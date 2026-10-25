* hierarchical test netlist written for drawio hier tests (schemas-lisibles, 2026-10-25)
* two instances of one buffer, each made of two instances of one inverter
.subckt inv in out vdd
M1 out in vdd vdd pmos W=2u L=0.18u
M2 out in 0 0 nmos W=1u L=0.18u
.ends inv
.subckt buf in out vdd
X1 in mid vdd inv
X2 mid out vdd inv
C1 mid 0 10f
.ends buf
VDD vdd 0 1.8
VIN in 0 DC 0.9
XB1 in a vdd buf
XB2 a out vdd buf
RL out 0 10k
.end
