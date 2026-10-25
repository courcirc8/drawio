* StrongARM latch comparator (witness)
Mtail t clk 0 0 nmos W=4u L=0.13u
M1 p inp t 0 nmos W=4u L=0.13u
M2 q inn t 0 nmos W=4u L=0.13u
M3 outn outp p 0 nmos W=2u L=0.13u
M4 outp outn q 0 nmos W=2u L=0.13u
M5 outn outp vdd vdd pmos W=2u L=0.13u
M6 outp outn vdd vdd pmos W=2u L=0.13u
M7 outn clk vdd vdd pmos W=1u L=0.13u
M8 outp clk vdd vdd pmos W=1u L=0.13u
M9 p clk vdd vdd pmos W=1u L=0.13u
M10 q clk vdd vdd pmos W=1u L=0.13u
.end
