* DIFFCC as one .subckt: vbd is a pin only a dummy uses (XD1, page 2); vdd a supply pin
.subckt diffcc inp inm outa outb tail vbd vdd
XM1 tail vdd vdd vdd sg13_lv_pmos w=5u l=0.13u m=2
XM2 outa inp tail vdd sg13_lv_pmos w=5u l=0.13u m=4
XM4 outb inm tail vdd sg13_lv_pmos w=5u l=0.13u m=4
XD1 vbd vdd vdd vdd sg13_lv_pmos w=5u l=0.13u dummy=1
.ends
.end
