* simple self-biased bandgap reference (witness, generic models)
M3 a a vdd vdd pmos W=20u L=2u
M4 b a vdd vdd pmos W=20u L=2u
M1 a b e1 0 nmos W=10u L=2u
M2 b b r1 0 nmos W=80u L=2u
Q1 0 0 e1 pnp
R1 r1 e2 10k
Q2 0 0 e2 pnp area=8
M5 vref a vdd vdd pmos W=20u L=2u
R2 vref e3 80k
Q3 0 0 e3 pnp
.end
