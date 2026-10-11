* CML clocked comparator core (Eric's reference for the latch template, 2026-10-09):
* input pair M1/M2 + cross-coupled pair M3/M4 on the same drains, clock
* switches M5/M6, tail M7, resistive loads. Textbook topology, typed by hand.
R1 vdd n1 5k
R2 vdd n2 5k
M1 n1 vin1 n3 n3 nmos
M2 n2 vin2 n3 n3 nmos
M3 n1 n2 n5 n5 nmos
M4 n2 n1 n5 n5 nmos
M5 n3 clk n4 n4 nmos
M6 n5 clkb n4 n4 nmos
M7 n4 bias gnd gnd nmos
.end
