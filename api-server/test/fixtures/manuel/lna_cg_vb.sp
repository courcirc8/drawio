* differential common-gate LNA with cascodes, inductive loads; vb1 biases both CG gates
* written for the test; no sizes, as in many netlist banks
LD1 vdd outp
LD2 vdd outn
LS1 inp 0
LS2 inn 0
MC1 outp vdd xp 0 nch
MC2 outn vdd xn 0 nch
MG1 xp vb1 inp 0 nch
MG2 xn vb1 inn 0 nch
.end
