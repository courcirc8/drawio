* DIFFCC with its supply named vp: a supply by its devices only (bulk of the pair's PMOS, no gate, no passive),
* never by its name; XM1 (dummy=1: vp is on its gate, so no rail vote makes it an off device) on page 2. Review #81 (6)
XM1 tail vp vp vp sg13_lv_pmos w=5u l=0.13u m=2 dummy=1
XM2 outa inp tail vp sg13_lv_pmos w=5u l=0.13u m=4
XM4 outb inm tail vp sg13_lv_pmos w=5u l=0.13u m=4
.end
