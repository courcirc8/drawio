* five-transistor OTA with two devices tied to their own rail (all terminals on vss / vdd), written for the
* review r2 (B1): their straight drop to the rail runs along their own body; the rail must stay one line
MB2 ib ib vss vss nmos W=4u L=1u
MB1 tail ib vss vss nmos W=4u L=1u
MA x inp tail vss nmos W=8u L=0.5u
MB out inn tail vss nmos W=8u L=0.5u
MC out x vdd vdd pmos W=6u L=0.5u
MD x x vdd vdd pmos W=6u L=0.5u
ME vss vss vss vss nmos W=2u L=0.5u
MF vdd vdd vdd vdd pmos W=2u L=0.5u
.end
