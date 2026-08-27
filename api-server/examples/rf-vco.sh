#!/usr/bin/env bash
# VCO LC differentiel cross-couple (Hajimiri & Lee, JSSC mai 1999)
set -euo pipefail
B=${1:-http://127.0.0.1:8770}; J='Content-Type: application/json'
DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }
NM=mxgraph.electrical.transistors.nmos
LV=mxgraph.electrical.inductors.inductor_2
JCT='ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;'

cell '{"id":"M1","shape":"'$NM'","x":300,"y":400,"value":"NMOS"}'
cell '{"id":"M2","shape":"'$NM'","x":560,"y":400,"value":"NMOS"}'
cell '{"id":"L1","shape":"'$LV'","x":355,"y":240,"value":"2n"}'
cell '{"id":"L2","shape":"'$LV'","x":615,"y":240,"value":"2n"}'
cell '{"id":"C1","shape":"mxgraph.electrical.capacitors.capacitor_1","x":450,"y":300,"value":"1p"}'
cell '{"id":"I1","shape":"mxgraph.electrical.signal_sources.current_source","x":480,"y":570,"value":"4m"}'
cell '{"id":"VT1","shape":"mxgraph.electrical.signal_sources.vss2","x":350,"y":180,"w":40,"h":26,"value":"VDD"}'
cell '{"id":"VT2","shape":"mxgraph.electrical.signal_sources.vss2","x":610,"y":180,"w":40,"h":26,"value":"VDD"}'
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":485,"y":660,"w":30,"h":20}'
cell '{"id":"OUTP","shape":"mxgraph.electrical.signal_sources.equipotential","x":200,"y":368,"w":24,"h":24,"value":"OUTP"}'
cell '{"id":"OUTM","shape":"mxgraph.electrical.signal_sources.equipotential","x":760,"y":368,"w":24,"h":24,"value":"OUTM"}'
cell '{"id":"J_p","style":"'$JCT'","x":367,"y":327,"w":6,"h":6}'
cell '{"id":"J_m","style":"'$JCT'","x":627,"y":327,"w":6,"h":6}'
cell '{"id":"J_s","style":"'$JCT'","x":497,"y":537,"w":6,"h":6}'

wire '{"from":{"cell":"VT1","pin":"S"},"to":{"cell":"L1","pin":"in"}}'
wire '{"from":{"cell":"VT2","pin":"S"},"to":{"cell":"L2","pin":"in"}}'
wire '{"from":{"cell":"L1","pin":"out"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"L2","pin":"out"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"M1","pin":"NE"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"M2","pin":"NE"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"C1","pin":"in"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"C1","pin":"out"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"J_p"},"to":{"cell":"M2","pin":"W"}}'   # cross-couplage
wire '{"from":{"cell":"J_m"},"to":{"cell":"M1","pin":"W"}}'
wire '{"from":{"cell":"J_p"},"to":{"cell":"OUTP","pin":"N"}}'
wire '{"from":{"cell":"J_m"},"to":{"cell":"OUTM","pin":"N"}}'
wire '{"from":{"cell":"M1","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"M2","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"J_s"},"to":{"cell":"I1","pin":"N"}}'
wire '{"from":{"cell":"I1","pin":"S"},"to":{"cell":"GND1","pin":"N"}}'
curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
echo "$DOC"
