* ota1 of the TIA proj5 (tia-butterworth3, our own design, IHP SG13G2): the .subckt body, ports as nets
* OTA FD a etage d'entree cascode (lv)
IB vdd vbn 0.00024000000000000003
XM0 vbn vbn 0 0 sg13_lv_nmos w=36u l=4u ng=8 m=1
XM5 tail vbn 0 0 sg13_lv_nmos w=49.622u l=4u ng=10 m=37
XM1 d1a inp tail 0 sg13_lv_nmos w=50u l=0.13u ng=10 m=312
XM2 d1b inn tail 0 sg13_lv_nmos w=50u l=0.13u ng=10 m=312
XMCA o1a vcn d1a 0 sg13_lv_nmos w=48.75u l=0.13u ng=10 m=32
XMCB o1b vcn d1b 0 sg13_lv_nmos w=48.75u l=0.13u ng=10 m=32
XMPA o1a vcp p1a vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=48
XMPB o1b vcp p1b vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=48
XM3 p1a vcmfb vdd vdd sg13_lv_pmos w=50u l=1u ng=10 m=80
XM4 p1b vcmfb vdd vdd sg13_lv_pmos w=50u l=1u ng=10 m=80
XM6A outp o1a vdd vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=60
XM6B outn o1b vdd vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=60
XM7A outp vbn 0 0 sg13_lv_nmos w=50u l=4u ng=10 m=9
XM7B outn vbn 0 0 sg13_lv_nmos w=50u l=4u ng=10 m=9
XCCA o1a za cap_cmim w=44.67u l=44.67u
XRZA za outp 0 rppd w=0.5u l=0.6033u b=0 m=3
XCCB o1b zb cap_cmim w=44.67u l=44.67u
XRZB zb outn 0 rppd w=0.5u l=0.6033u b=0 m=3
* polarisation des cascodes (répliques)
XMQ1 vpd vbn 0 0 sg13_lv_nmos w=36u l=4u ng=8 m=1
XMPD vpd vpd vdd vdd sg13_lv_pmos w=47u l=0.5u ng=10 m=12
XMPN vcn vpd vdd vdd sg13_lv_pmos w=47u l=0.5u ng=10 m=12
XMBN vcn vcn xbn 0 sg13_lv_nmos w=31.2u l=0.13u ng=10 m=2
XRBN xbn tail 0 rppd w=0.5u l=0.96u b=0 m=1
XRBP vdd ybp 0 rppd w=0.5u l=1.187u b=0 m=1
XMBP vcp vcp ybp vdd sg13_lv_pmos w=48u l=0.13u ng=10 m=2
XMQ2 vcp vbn 0 0 sg13_lv_nmos w=36u l=4u ng=8 m=1
* CMFB
RCMA outp vcms 200000.0
RCMB outn vcms 200000.0
CCMA outp vcms 2e-13
CCMB outn vcms 2e-13
XM10 tcm vbn 0 0 sg13_lv_nmos w=45u l=4u ng=10 m=4
XM8 vcmfb vcms tcm 0 sg13_lv_nmos w=48u l=0.5u ng=10 m=17
XM9 dcm vcmref tcm 0 sg13_lv_nmos w=48u l=0.5u ng=10 m=17
XM11 vcmfb vcmfb vdd vdd sg13_lv_pmos w=50u l=1u ng=10 m=8
XM12 dcm dcm vdd vdd sg13_lv_pmos w=50u l=1u ng=10 m=8
RPOR vdd por 500000.0
CPOR por 0 2e-11
XKA o1a por vdd vdd sg13_lv_pmos w=1e-05 l=0.13u ng=1 m=1
XKB o1b por vdd vdd sg13_lv_pmos w=1e-05 l=0.13u ng=1 m=1
.end
