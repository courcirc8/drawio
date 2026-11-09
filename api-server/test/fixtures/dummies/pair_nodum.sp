* no dummy at all: vdd a .subckt pin used only as the pair's bulk; page 2 draws no vdd, so its warning stays.
* Review #81 (1)
.subckt pair inp inm outa outb tail vdd
XM2 outa inp tail vdd sg13_lv_pmos w=5u l=0.13u m=4
XM4 outb inm tail vdd sg13_lv_pmos w=5u l=0.13u m=4
.ends
.end
