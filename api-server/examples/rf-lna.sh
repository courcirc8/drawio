#!/usr/bin/env bash
# LNA cascode a degenerescence inductive (Shaeffer & Lee, JSSC mai 1997)
set -euo pipefail
B=${1:-http://127.0.0.1:8770}; J='Content-Type: application/json'
DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }
NM=mxgraph.electrical.transistors.nmos
LV=mxgraph.electrical.inductors.inductor_2
JCT='ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;'

cell '{"id":"M1","shape":"'$NM'","x":300,"y":400,"value":"NMOS"}'
cell '{"id":"M2","shape":"'$NM'","x":300,"y":220,"value":"NMOS"}'
cell '{"id":"L1","shape":"mxgraph.electrical.inductors.inductor_3","x":170,"y":447,"value":"Lg 8n"}'
cell '{"id":"L2","shape":"'$LV'","x":355,"y":540,"value":"Ls 1n"}'
cell '{"id":"L3","shape":"'$LV'","x":355,"y":120,"value":"Ld 4n"}'
cell '{"id":"VT1","shape":"mxgraph.electrical.signal_sources.vss2","x":350,"y":60,"w":40,"h":26,"value":"VDD"}'
cell '{"id":"VB","shape":"mxgraph.electrical.signal_sources.vss2","x":180,"y":180,"w":40,"h":26,"value":"VB"}'
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":355,"y":640,"w":30,"h":20}'
cell '{"id":"IN","shape":"mxgraph.electrical.signal_sources.equipotential","x":98,"y":495,"w":24,"h":24,"value":"IN"}'
cell '{"id":"OUT","shape":"mxgraph.electrical.signal_sources.equipotential","x":450,"y":240,"w":24,"h":24,"value":"OUT"}'
cell '{"id":"J_o","style":"'$JCT'","x":367,"y":197,"w":6,"h":6}'

wire '{"from":{"cell":"IN","pin":"N"},"to":{"cell":"L1","pin":"in"}}'
wire '{"from":{"cell":"L1","pin":"out"},"to":{"cell":"M1","pin":"W"}}'
wire '{"from":{"cell":"M1","pin":"SE"},"to":{"cell":"L2","pin":"in"}}'
wire '{"from":{"cell":"L2","pin":"out"},"to":{"cell":"GND1","pin":"N"}}'
wire '{"from":{"cell":"M2","pin":"SE"},"to":{"cell":"M1","pin":"NE"}}'
wire '{"from":{"cell":"VB","pin":"S"},"to":{"cell":"M2","pin":"W"}}'
wire '{"from":{"cell":"M2","pin":"NE"},"to":{"cell":"J_o"}}'
wire '{"from":{"cell":"L3","pin":"out"},"to":{"cell":"J_o"}}'
wire '{"from":{"cell":"J_o"},"to":{"cell":"OUT","pin":"N"}}'
wire '{"from":{"cell":"VT1","pin":"S"},"to":{"cell":"L3","pin":"in"}}'
curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
echo "$DOC"
