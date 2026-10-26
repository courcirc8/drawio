* ota2 of the TIA proj5 (tia-butterworth3, our own design, IHP SG13G2): the .subckt body, ports as nets; same topology as ota1 without the power-on kick
* OTA FD a etage d'entree cascode (lv)
IB vdd vbn 1.2e-05
XM0 vbn vbn 0 0 sg13_lv_nmos w=2.7u l=0.5u ng=1 m=1
XM5 tail vbn 0 0 sg13_lv_nmos w=45.9u l=0.5u ng=10 m=3
XM1 d1a inp tail 0 sg13_lv_nmos w=50u l=0.13u ng=10 m=6
XM2 d1b inn tail 0 sg13_lv_nmos w=50u l=0.13u ng=10 m=6
XMCA o1a vcn d1a 0 sg13_lv_nmos w=39u l=0.13u ng=10 m=2
XMCB o1b vcn d1b 0 sg13_lv_nmos w=39u l=0.13u ng=10 m=2
XMPA o1a vcp p1a vdd sg13_lv_pmos w=40u l=0.13u ng=10 m=3
XMPB o1b vcp p1b vdd sg13_lv_pmos w=40u l=0.13u ng=10 m=3
XM3 p1a vcmfb vdd vdd sg13_lv_pmos w=48u l=0.5u ng=10 m=5
XM4 p1b vcmfb vdd vdd sg13_lv_pmos w=48u l=0.5u ng=10 m=5
XM6A outp o1a vdd vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=6
XM6B outn o1b vdd vdd sg13_lv_pmos w=50u l=0.13u ng=10 m=6
XM7A outp vbn 0 0 sg13_lv_nmos w=33.75u l=0.5u ng=10 m=2
XM7B outn vbn 0 0 sg13_lv_nmos w=33.75u l=0.5u ng=10 m=2
XCCA o1a za cap_cmim w=48.94u l=48.94u
XRZA za outp 0 rppd w=0.5u l=0.798u b=0 m=3
XCCB o1b zb cap_cmim w=48.94u l=48.94u
XRZB zb outn 0 rppd w=0.5u l=0.798u b=0 m=3
* polarisation des cascodes (répliques)
XMQ1 vpd vbn 0 0 sg13_lv_nmos w=2.7u l=0.5u ng=1 m=1
XMPD vpd vpd vdd vdd sg13_lv_pmos w=28.2u l=0.5u ng=6 m=1
XMPN vcn vpd vdd vdd sg13_lv_pmos w=28.2u l=0.5u ng=6 m=1
XMBN vcn vcn xbn 0 sg13_lv_nmos w=3.12u l=0.13u ng=1 m=1
XRBN xbn tail 0 rppd w=0.5u l=24.06u b=0 m=1
XRBP vdd ybp 0 rppd w=0.5u l=28.92u b=0 m=1
XMBP vcp vcp ybp vdd sg13_lv_pmos w=4.8u l=0.13u ng=1 m=1
XMQ2 vcp vbn 0 0 sg13_lv_nmos w=2.7u l=0.5u ng=1 m=1
* CMFB
RCMA outp vcms 200000.0
RCMB outn vcms 200000.0
CCMA outp vcms 2e-13
CCMB outn vcms 2e-13
XM10 tcm vbn 0 0 sg13_lv_nmos w=13.5u l=0.5u ng=3 m=1
XM8 vcmfb vcms tcm 0 sg13_lv_nmos w=40.8u l=0.5u ng=9 m=1
XM9 dcm vcmref tcm 0 sg13_lv_nmos w=40.8u l=0.5u ng=9 m=1
XM11 vcmfb vcmfb vdd vdd sg13_lv_pmos w=24u l=0.5u ng=5 m=1
XM12 dcm dcm vdd vdd sg13_lv_pmos w=24u l=0.5u ng=5 m=1
.end
