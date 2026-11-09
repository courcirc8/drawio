* Review #81 pass 2, probe sf5 (Orchestrator review, deploiements/revue-drawio-81/probe/sf5.sp)
* flat PMOS source follower, bulk tied to source (internal o); dummy drain on o, gate/source/bulk on vdd
XM1 vss vin o o sg13_lv_pmos w=2u l=0.13u
XM2 o vb vdd vdd sg13_lv_pmos w=2u l=0.13u
XD1 o vdd vdd vdd sg13_lv_pmos w=2u l=0.13u dummy=1
.end
