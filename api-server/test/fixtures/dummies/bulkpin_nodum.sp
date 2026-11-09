* Review #81 pass 3, probe bulkpin_nodum (Orchestrator review, deploiements/revue-drawio-81/probe3/bulkpin_nodum.sp)
* vp a pin, bulk-only on page 1, NO dummy (page 2 'Aucun factice'): rule (b) or a warning?
.subckt bpn inp inm outa outb tail vp
XM2 outa inp tail vp sg13_lv_pmos w=5u l=0.13u m=4
XM4 outb inm tail vp sg13_lv_pmos w=5u l=0.13u m=4
.ends
.end
