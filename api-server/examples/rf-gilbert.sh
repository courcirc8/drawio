#!/usr/bin/env bash
# Melangeur de Gilbert double equilibre (B. Gilbert, JSSC dec. 1968, version CMOS)
set -euo pipefail
B=${1:-http://127.0.0.1:8770}; J='Content-Type: application/json'
DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }
NM=mxgraph.electrical.transistors.nmos
RZ=mxgraph.electrical.resistors.resistor_2
JCT='ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;'

# quad LO (y=240) et paire RF (y=480)
cell '{"id":"M3","shape":"'$NM'","x":250,"y":240,"value":"NMOS"}'
cell '{"id":"M4","shape":"'$NM'","x":420,"y":240,"value":"NMOS"}'
cell '{"id":"M5","shape":"'$NM'","x":600,"y":240,"value":"NMOS"}'
cell '{"id":"M6","shape":"'$NM'","x":770,"y":240,"value":"NMOS"}'
cell '{"id":"M1","shape":"'$NM'","x":330,"y":480,"value":"NMOS"}'
cell '{"id":"M2","shape":"'$NM'","x":690,"y":480,"value":"NMOS"}'
# charges (verticales) + alim
cell '{"id":"R1","shape":"'$RZ'","x":270,"y":120,"rotation":90,"value":"500"}'
cell '{"id":"R2","shape":"'$RZ'","x":790,"y":120,"rotation":90,"value":"500"}'
cell '{"id":"VT1","shape":"mxgraph.electrical.signal_sources.vss2","x":300,"y":20,"w":40,"h":26,"value":"VDD"}'
cell '{"id":"VT2","shape":"mxgraph.electrical.signal_sources.vss2","x":820,"y":20,"w":40,"h":26,"value":"VDD"}'
# polarisation
cell '{"id":"I1","shape":"mxgraph.electrical.signal_sources.current_source","x":560,"y":680,"value":"2m"}'
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":565,"y":770,"w":30,"h":20}'
# ports
cell '{"id":"RFP","shape":"mxgraph.electrical.signal_sources.equipotential","x":250,"y":570,"w":24,"h":24,"value":"RF+"}'
cell '{"id":"RFM","shape":"mxgraph.electrical.signal_sources.equipotential","x":610,"y":570,"w":24,"h":24,"value":"RF-"}'
cell '{"id":"LOP","shape":"mxgraph.electrical.signal_sources.equipotential","x":168,"y":340,"w":24,"h":24,"value":"LO+"}'
cell '{"id":"LOM","shape":"mxgraph.electrical.signal_sources.equipotential","x":353,"y":150,"w":24,"h":24,"value":"LO-"}'
cell '{"id":"OUTP","shape":"mxgraph.electrical.signal_sources.equipotential","x":150,"y":228,"w":24,"h":24,"value":"IF+"}'
cell '{"id":"OUTM","shape":"mxgraph.electrical.signal_sources.equipotential","x":930,"y":228,"w":24,"h":24,"value":"IF-"}'
# jonctions
cell '{"id":"J_a","style":"'$JCT'","x":397,"y":417,"w":6,"h":6}'
cell '{"id":"J_b","style":"'$JCT'","x":757,"y":417,"w":6,"h":6}'
cell '{"id":"J_lop","style":"'$JCT'","x":177,"y":292,"w":6,"h":6}'
cell '{"id":"J_lom","style":"'$JCT'","x":365,"y":192,"w":6,"h":6}'
cell '{"id":"J_outp","style":"'$JCT'","x":317,"y":197,"w":6,"h":6}'
cell '{"id":"J_outm","style":"'$JCT'","x":837,"y":197,"w":6,"h":6}'
cell '{"id":"J_s","style":"'$JCT'","x":577,"y":637,"w":6,"h":6}'

# alim / charges / sorties IF
wire '{"from":{"cell":"VT1","pin":"S"},"to":{"cell":"R1","pin":"in"}}'
wire '{"from":{"cell":"VT2","pin":"S"},"to":{"cell":"R2","pin":"in"}}'
wire '{"from":{"cell":"R1","pin":"out"},"to":{"cell":"J_outp"}}'
wire '{"from":{"cell":"R2","pin":"out"},"to":{"cell":"J_outm"}}'
wire '{"from":{"cell":"M3","pin":"NE"},"to":{"cell":"J_outp"}}'
wire '{"from":{"cell":"M5","pin":"NE"},"to":{"cell":"J_outp"}}'
wire '{"from":{"cell":"M4","pin":"NE"},"to":{"cell":"J_outm"}}'
wire '{"from":{"cell":"M6","pin":"NE"},"to":{"cell":"J_outm"}}'
wire '{"from":{"cell":"J_outp"},"to":{"cell":"OUTP","pin":"N"}}'
wire '{"from":{"cell":"J_outm"},"to":{"cell":"OUTM","pin":"N"}}'
# LO
wire '{"from":{"cell":"J_lop"},"to":{"cell":"M3","pin":"W"}}'
wire '{"from":{"cell":"J_lop"},"to":{"cell":"M6","pin":"W"}}'
wire '{"from":{"cell":"LOP","pin":"N"},"to":{"cell":"J_lop"}}'
wire '{"from":{"cell":"J_lom"},"to":{"cell":"M4","pin":"W"}}'
wire '{"from":{"cell":"J_lom"},"to":{"cell":"M5","pin":"W"}}'
wire '{"from":{"cell":"LOM","pin":"N"},"to":{"cell":"J_lom"}}'
# nets a et b (sources du quad -> drains paire RF)
wire '{"from":{"cell":"M3","pin":"SE"},"to":{"cell":"J_a"}}'
wire '{"from":{"cell":"M4","pin":"SE"},"to":{"cell":"J_a"}}'
wire '{"from":{"cell":"M1","pin":"NE"},"to":{"cell":"J_a"}}'
wire '{"from":{"cell":"M5","pin":"SE"},"to":{"cell":"J_b"}}'
wire '{"from":{"cell":"M6","pin":"SE"},"to":{"cell":"J_b"}}'
wire '{"from":{"cell":"M2","pin":"NE"},"to":{"cell":"J_b"}}'
# RF + queue
wire '{"from":{"cell":"RFP","pin":"N"},"to":{"cell":"M1","pin":"W"}}'
wire '{"from":{"cell":"RFM","pin":"N"},"to":{"cell":"M2","pin":"W"}}'
wire '{"from":{"cell":"M1","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"M2","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"J_s"},"to":{"cell":"I1","pin":"N"}}'
wire '{"from":{"cell":"I1","pin":"S"},"to":{"cell":"GND1","pin":"N"}}'
curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
echo "$DOC"
