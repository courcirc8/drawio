* diffcc_bulk as one .subckt with vp a pin: vp, a supply by its devices only (no supply name), is no global
* supply; page 1 does not name it (bulks only), so as a pin it gets its port on page 1 (b). Review #81 pass 2
.subckt diffccb inp inm outa outb tail vp
XM1 tail vp vp vp sg13_lv_pmos w=5u l=0.13u m=2 dummy=1
XM2 outa inp tail vp sg13_lv_pmos w=5u l=0.13u m=4
XM4 outb inm tail vp sg13_lv_pmos w=5u l=0.13u m=4
.ends
.end
