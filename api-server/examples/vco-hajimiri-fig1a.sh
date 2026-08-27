#!/usr/bin/env bash
# Reproduction fidèle de la Fig. 1(a) de Hajimiri & Lee, JSSC mai 1999 :
# VCO LC complémentaire (paires cross-couplées PMOS+NMOS, tank L/2+L/2 // C,
# M_tail). Les 4 fils de cross-couplage sont des diagonales droites comme
# dans le papier (edgeStyle=none, non routés).
set -euo pipefail
B=${1:-http://127.0.0.1:8770}; J='Content-Type: application/json'
DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }
patch() { curl -sf -X PATCH $B/documents/$DOC/cells/$1 -H "$J" -d "$2" >/dev/null; }
NM=mxgraph.electrical.transistors.nmos
PM=mxgraph.electrical.transistors.pmos
JCT='ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;'
STRAIGHT='edgeStyle=none;html=1;endArrow=none;endFill=0;'

cell '{"id":"M3","shape":"'$PM'","x":340,"y":150,"value":"M3"}'; patch M3 '{"style":{"flipH":"1"}}'
cell '{"id":"M4","shape":"'$PM'","x":530,"y":150,"value":"M4"}'
patch M3 '{"style":{"verticalLabelPosition":"top","verticalAlign":"bottom"}}'
patch M4 '{"style":{"verticalLabelPosition":"top","verticalAlign":"bottom"}}'
cell '{"id":"M1","shape":"'$NM'","x":340,"y":430,"value":"M1"}'; patch M1 '{"style":{"flipH":"1"}}'
cell '{"id":"M2","shape":"'$NM'","x":530,"y":430,"value":"M2"}'
cell '{"id":"L1","shape":"mxgraph.electrical.inductors.inductor_3","x":360,"y":270,"value":"L/2"}'
cell '{"id":"L2","shape":"mxgraph.electrical.inductors.inductor_3","x":480,"y":270,"value":"L/2"}'
cell '{"id":"C1","shape":"mxgraph.electrical.capacitors.capacitor_1","x":420,"y":300,"value":"C"}'
cell '{"id":"MT","shape":"'$NM'","x":430,"y":560,"value":"Mtail"}'
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":485,"y":700,"w":30,"h":20}'
cell '{"id":"VT1","shape":"mxgraph.electrical.signal_sources.vss2","x":450,"y":54,"w":40,"h":26,"value":"VDD"}'
cell '{"id":"P_vb","shape":"mxgraph.electrical.signal_sources.equipotential","x":318,"y":640,"w":24,"h":24,"value":"VB"}'
cell '{"id":"J_p","style":"'$JCT'","x":337,"y":327,"w":6,"h":6}'
cell '{"id":"J_m","style":"'$JCT'","x":597,"y":327,"w":6,"h":6}'
cell '{"id":"J_s","style":"'$JCT'","x":497,"y":537,"w":6,"h":6}'

wire '{"from":{"cell":"M3","pin":"NE"},"to":{"cell":"VT1","pin":"S"}}'
wire '{"from":{"cell":"M4","pin":"NE"},"to":{"cell":"VT1","pin":"S"}}'
wire '{"from":{"cell":"M3","pin":"SE"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"M4","pin":"SE"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"M1","pin":"NE"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"M2","pin":"NE"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"L1","pin":"in"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"L1","pin":"out"},"to":{"cell":"L2","pin":"in"}}'
wire '{"from":{"cell":"L2","pin":"out"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"C1","pin":"in"},"to":{"cell":"J_p"}}'
wire '{"from":{"cell":"C1","pin":"out"},"to":{"cell":"J_m"}}'
wire '{"from":{"cell":"M1","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"M2","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"J_s"},"to":{"cell":"MT","pin":"NE"}}'
wire '{"from":{"cell":"MT","pin":"SE"},"to":{"cell":"GND1","pin":"N"}}'
wire '{"from":{"cell":"P_vb","pin":"N"},"to":{"cell":"MT","pin":"W"}}'

curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
# diagonales de cross-couplage APRÈS routage (jamais routées orthogonalement)
wire '{"from":{"cell":"M3","pin":"W"},"to":{"cell":"M4","pin":"SE"},"style":"'$STRAIGHT'"}'
wire '{"from":{"cell":"M4","pin":"W"},"to":{"cell":"M3","pin":"SE"},"style":"'$STRAIGHT'"}'
wire '{"from":{"cell":"M1","pin":"W"},"to":{"cell":"M2","pin":"NE"},"style":"'$STRAIGHT'"}'
wire '{"from":{"cell":"M2","pin":"W"},"to":{"cell":"M1","pin":"NE"},"style":"'$STRAIGHT'"}'
  -d '{"wires":["w1","w2","w3","w4","w5","w6","w7","w8","w9","w10","w11","w16","w17","w18","w19","w20"]}' >/dev/null
echo "$DOC"
