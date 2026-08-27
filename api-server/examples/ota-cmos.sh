#!/usr/bin/env bash
# OTA CMOS du 2e ordre (deux étages, compensation Miller) :
#   étage 1 : paire diff NMOS M1/M2, charge miroir PMOS M3/M4, queue M5
#   étage 2 : source commune PMOS M6, puits de courant M7
#   polarisation : M8 diode + I1 ; compensation : CC entre b et out
set -euo pipefail
B=${1:-http://127.0.0.1:8770}
J='Content-Type: application/json'

DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "document: $DOC" >&2
cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }
NM=mxgraph.electrical.transistors.nmos
PM=mxgraph.electrical.transistors.pmos
JCT='ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;'

# --- transistors (70x110) --------------------------------------------------
cell '{"id":"M3","shape":"'$PM'","x":300,"y":140,"value":"PMOS"}'
cell '{"id":"M4","shape":"'$PM'","x":480,"y":140,"value":"PMOS"}'
cell '{"id":"M6","shape":"'$PM'","x":760,"y":140,"value":"PMOS"}'
cell '{"id":"M1","shape":"'$NM'","x":300,"y":320,"value":"NMOS"}'
cell '{"id":"M2","shape":"'$NM'","x":480,"y":320,"value":"NMOS"}'
cell '{"id":"M5","shape":"'$NM'","x":410,"y":500,"value":"NMOS"}'
cell '{"id":"M7","shape":"'$NM'","x":760,"y":500,"value":"NMOS"}'
cell '{"id":"M8","shape":"'$NM'","x":80,"y":500,"value":"NMOS"}'
# --- polarisation + compensation ------------------------------------------
cell '{"id":"I1","shape":"mxgraph.electrical.signal_sources.current_source","x":30,"y":360,"value":"20u"}'
cell '{"id":"CC","shape":"mxgraph.electrical.capacitors.capacitor_1","x":620,"y":345,"value":"2p"}'
# --- taps VDD (pin S en bas, x aligné sur le pin nourri) -------------------
for t in "VT3:350" "VT4:530" "VT6:810"; do
  id=${t%%:*}; x=${t##*:}
  cell '{"id":"'$id'","shape":"mxgraph.electrical.signal_sources.vss2","x":'$x',"y":80,"w":40,"h":26,"value":"VDD"}'
done
cell '{"id":"VTI","shape":"mxgraph.electrical.signal_sources.vss2","x":30,"y":300,"w":40,"h":26,"value":"VDD"}'
# --- masses ----------------------------------------------------------------
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":465,"y":650,"w":30,"h":20}'
cell '{"id":"GND2","shape":"mxgraph.electrical.signal_sources.signal_ground","x":135,"y":650,"w":30,"h":20}'
cell '{"id":"GND3","shape":"mxgraph.electrical.signal_sources.signal_ground","x":815,"y":650,"w":30,"h":20}'
# --- ports -----------------------------------------------------------------
cell '{"id":"INP","shape":"mxgraph.electrical.signal_sources.equipotential","x":216,"y":415,"w":24,"h":24,"value":"INP"}'
cell '{"id":"INM","shape":"mxgraph.electrical.signal_sources.equipotential","x":396,"y":415,"w":24,"h":24,"value":"INM"}'
cell '{"id":"OUT","shape":"mxgraph.electrical.signal_sources.equipotential","x":890,"y":415,"w":24,"h":24,"value":"OUT"}'
# --- jonctions -------------------------------------------------------------
cell '{"id":"J_a","style":"'$JCT'","x":367,"y":282,"w":6,"h":6}'
cell '{"id":"J_b","style":"'$JCT'","x":547,"y":282,"w":6,"h":6}'
cell '{"id":"J_s","style":"'$JCT'","x":457,"y":462,"w":6,"h":6}'
cell '{"id":"J_vb","style":"'$JCT'","x":47,"y":627,"w":6,"h":6}'
cell '{"id":"J_out","style":"'$JCT'","x":827,"y":372,"w":6,"h":6}'

# --- câblage ---------------------------------------------------------------
wire '{"from":{"cell":"M3","pin":"NE"},"to":{"cell":"VT3","pin":"S"}}'   # VDD
wire '{"from":{"cell":"M4","pin":"NE"},"to":{"cell":"VT4","pin":"S"}}'
wire '{"from":{"cell":"M6","pin":"NE"},"to":{"cell":"VT6","pin":"S"}}'
wire '{"from":{"cell":"I1","pin":"N"},"to":{"cell":"VTI","pin":"S"}}'
wire '{"from":{"cell":"M3","pin":"SE"},"to":{"cell":"J_a"}}'             # net a
wire '{"from":{"cell":"M1","pin":"NE"},"to":{"cell":"J_a"}}'
wire '{"from":{"cell":"J_a"},"to":{"cell":"M3","pin":"W"}}'
wire '{"from":{"cell":"J_a"},"to":{"cell":"M4","pin":"W"}}'
wire '{"from":{"cell":"M4","pin":"SE"},"to":{"cell":"J_b"}}'             # net b
wire '{"from":{"cell":"M2","pin":"NE"},"to":{"cell":"J_b"}}'
wire '{"from":{"cell":"J_b"},"to":{"cell":"M6","pin":"W"}}'
wire '{"from":{"cell":"J_b"},"to":{"cell":"CC","pin":"in"}}'
wire '{"from":{"cell":"M1","pin":"SE"},"to":{"cell":"J_s"}}'             # net s
wire '{"from":{"cell":"M2","pin":"SE"},"to":{"cell":"J_s"}}'
wire '{"from":{"cell":"J_s"},"to":{"cell":"M5","pin":"NE"}}'
wire '{"from":{"cell":"I1","pin":"S"},"to":{"cell":"J_vb"}}'             # net vb
wire '{"from":{"cell":"M8","pin":"NE"},"to":{"cell":"J_vb"}}'
wire '{"from":{"cell":"J_vb"},"to":{"cell":"M8","pin":"W"}}'
wire '{"from":{"cell":"J_vb"},"to":{"cell":"M5","pin":"W"}}'
wire '{"from":{"cell":"J_vb"},"to":{"cell":"M7","pin":"W"}}'
wire '{"from":{"cell":"M6","pin":"SE"},"to":{"cell":"J_out"}}'           # net out
wire '{"from":{"cell":"M7","pin":"NE"},"to":{"cell":"J_out"}}'
wire '{"from":{"cell":"CC","pin":"out"},"to":{"cell":"J_out"}}'
wire '{"from":{"cell":"J_out"},"to":{"cell":"OUT","pin":"N"}}'
wire '{"from":{"cell":"M5","pin":"SE"},"to":{"cell":"GND1","pin":"N"}}'  # masses
wire '{"from":{"cell":"M8","pin":"SE"},"to":{"cell":"GND2","pin":"N"}}'
wire '{"from":{"cell":"M7","pin":"SE"},"to":{"cell":"GND3","pin":"N"}}'
wire '{"from":{"cell":"INP","pin":"N"},"to":{"cell":"M1","pin":"W"}}'    # entrées
wire '{"from":{"cell":"INM","pin":"N"},"to":{"cell":"M2","pin":"W"}}'

curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
echo "$DOC"
