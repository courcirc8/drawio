* internal net mid: drain/source on page 1; the dummy XD1 (gate and source on vdd: always off) has its drain and
* its bulk (a well tie) on mid. Only a dummy's vote could make mid a supply: it must stay a signal, labelled on
* both pages; named on page 2 and erased from page 1, it is a 422. Review #81 (2)
XM1 out vin mid vss sg13_lv_nmos w=2u l=0.13u
XM2 mid vb vss vss sg13_lv_nmos w=2u l=0.13u
XD1 mid vdd vdd mid sg13_lv_pmos w=2u l=0.13u dummy=1
.end
