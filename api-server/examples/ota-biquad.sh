#!/usr/bin/env bash
# Trace un filtre passe-bas Gm-C du 2e ordre à 2 OTA (biquad) via l'API.
# Topologie: sC1·V1 = gm1(Vin−Vout) ; sC2·Vout = gm2(V1−Vout)
#   → H(s) = gm1·gm2 / (s²C1C2 + s·C1·gm2 + gm1·gm2)
set -euo pipefail
B=${1:-http://127.0.0.1:8770}
J='Content-Type: application/json'

DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "document: $DOC" >&2

cell() { curl -sf -X POST $B/documents/$DOC/cells -H "$J" -d "$1" >/dev/null; }
wire() { curl -sf -X POST $B/documents/$DOC/wires -H "$J" -d "$1" >/dev/null; }

# --- composants -------------------------------------------------------------
cell '{"id":"V1","shape":"mxgraph.electrical.signal_sources.ac_source","x":60,"y":150,"value":"AC 1"}'
cell '{"id":"G1","shape":"mxgraph.electrical.abstract.ota_1","x":250,"y":120,"value":"gm1"}'
cell '{"id":"G2","shape":"mxgraph.electrical.abstract.ota_1","x":530,"y":120,"value":"gm2"}'
# condensateurs verticaux (rotation 90 : pin "in" en haut, "out" en bas)
cell '{"id":"C1","shape":"mxgraph.electrical.capacitors.capacitor_1","x":390,"y":250,"rotation":90,"value":"10p"}'
cell '{"id":"C2","shape":"mxgraph.electrical.capacitors.capacitor_1","x":670,"y":250,"rotation":90,"value":"10p"}'
# jonctions des nets n1 (3 terminaux) et vout (4 terminaux)
cell '{"id":"J_n1","style":"ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;","x":437,"y":162,"w":6,"h":6}'
cell '{"id":"J_vout","style":"ellipse;fillColor=#000000;strokeColor=#000000;drawioApiJunction=1;","x":717,"y":162,"w":6,"h":6}'
# masses
cell '{"id":"GND1","shape":"mxgraph.electrical.signal_sources.signal_ground","x":75,"y":260,"w":30,"h":20}'
cell '{"id":"GND2","shape":"mxgraph.electrical.signal_sources.signal_ground","x":425,"y":390,"w":30,"h":20}'
cell '{"id":"GND3","shape":"mxgraph.electrical.signal_sources.signal_ground","x":705,"y":390,"w":30,"h":20}'

# --- câblage ----------------------------------------------------------------
wire '{"from":{"cell":"V1","pin":"N"},"to":{"cell":"G1","pin":"in+"}}'          # in
wire '{"from":{"cell":"V1","pin":"S"},"to":{"cell":"GND1","pin":"N"}}'
wire '{"from":{"cell":"G1","pin":"out"},"to":{"cell":"J_n1"}}'                  # n1
wire '{"from":{"cell":"J_n1"},"to":{"cell":"G2","pin":"in+"}}'
wire '{"from":{"cell":"J_n1"},"to":{"cell":"C1","pin":"in"}}'
wire '{"from":{"cell":"C1","pin":"out"},"to":{"cell":"GND2","pin":"N"}}'
wire '{"from":{"cell":"G2","pin":"out"},"to":{"cell":"J_vout"}}'                # vout
wire '{"from":{"cell":"J_vout"},"to":{"cell":"C2","pin":"in"}}'
wire '{"from":{"cell":"C2","pin":"out"},"to":{"cell":"GND3","pin":"N"}}'
wire '{"from":{"cell":"J_vout"},"to":{"cell":"G1","pin":"in-"}}'                # feedback
wire '{"from":{"cell":"J_vout"},"to":{"cell":"G2","pin":"in-"}}'

# --- routage + export -------------------------------------------------------
curl -sf -X POST $B/documents/$DOC/route -H "$J" -d '{}' >/dev/null
echo "$DOC"
