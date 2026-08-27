#!/usr/bin/env bash
# Benchmark placement : v1 (naïf) vs v2 (place2) vs v2+optimize.
# Produit rf-collection/benchmark/<net>-<engine>.png + benchmark.html
set -uo pipefail
B=${1:-http://127.0.0.1:8770}
ITER=${2:-12}
HERE=$(cd "$(dirname "$0")/.." && pwd)
OUT=/home/courcirc8/ClaudeCode/test-delegation/rf-collection/benchmark
mkdir -p $OUT
J='Content-Type: application/json'
RES=$OUT/results.tsv
: > $RES
for cir in $HERE/benchmark/netlists/*.cir; do
  name=$(basename $cir .cir)
  for engine in v1 v2 opt; do
    DOC=$(curl -sf -X POST $B/documents -H "$J" -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
    case $engine in
      v1)  url="$B/documents/$DOC/netlist/import?engine=v1" ;;
      v2)  url="$B/documents/$DOC/netlist/import?engine=v2" ;;
      opt) url="$B/documents/$DOC/netlist/import?optimize=$ITER" ;;
    esac
    resp=$(curl -s -X POST "$url" -H 'Content-Type: text/plain' --data-binary @$cir)
    err=$(echo "$resp" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('error',''))
except Exception: print('parse')")
    if [ -n "$err" ]; then
      echo -e "$name\t$engine\tERREUR\t$err" >> $RES
      curl -s -X DELETE $B/documents/$DOC >/dev/null; continue
    fi
    lvs=$(curl -s -X POST $B/documents/$DOC/lvs -H 'Content-Type: text/plain' --data-binary @$cir | python3 -c "import json,sys; print(json.load(sys.stdin)['match'])")
    score=$(curl -s -X POST $B/documents/$DOC/beauty -H "$J" -d '{}' | python3 -c "
import json,sys; r=json.load(sys.stdin); m=r['metrics']
print(f\"{r['score']}\t{m['crossings']}\t{m['through_component']}\t{m['bends']}\t{int(m['wire_length'])}\")")
    curl -s -o $OUT/$name-$engine.png "$B/documents/$DOC/export?format=png&scale=1.5"
    echo -e "$name\t$engine\t$lvs\t$score" >> $RES
    curl -s -X DELETE $B/documents/$DOC >/dev/null
  done
done
python3 - "$RES" "$OUT" <<'PYEOF'
import sys, html
res, out = sys.argv[1], sys.argv[2]
rows = [l.rstrip('\n').split('\t') for l in open(res) if l.strip()]
nets = sorted(set(r[0] for r in rows))
EN = {'v1': 'v1 naïf', 'v2': 'place2', 'opt': 'place2+optimize'}
cards = []
for n in nets:
    cols = []
    for e in ['v1', 'v2', 'opt']:
        r = next((x for x in rows if x[0] == n and x[1] == e), None)
        if r is None or r[2] == 'ERREUR':
            cols.append(f'<div class="c"><h3>{EN[e]}</h3><p class="err">échec : {html.escape(r[3] if r else "?")}</p></div>')
            continue
        lvs = '✔ LVS' if r[2] == 'True' else '✘ LVS'
        cols.append(f'''<div class="c"><h3>{EN[e]} — <b>{r[3]}</b>/100</h3>
<p class="m">{lvs} · {r[4]} crois. · {r[5]} trav. · {r[6]} coudes · {r[7]} px</p>
<a href="benchmark/{n}-{e}.png"><img loading="lazy" src="benchmark/{n}-{e}.png"></a></div>''')
    cards.append(f'<section><h2>{n}</h2><div class="row">{"".join(cols)}</div></section>')
page = f'''<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Benchmark placement</title>
<style>body{{font-family:system-ui,sans-serif;margin:0;background:#f6f8fa;color:#1c2733}}
header{{background:#fff;border-bottom:1px solid #dde4ea;padding:1.4rem 2rem}}
main{{max-width:1400px;margin:0 auto;padding:1rem 2rem 3rem}}
section{{background:#fff;border:1px solid #dde4ea;border-radius:8px;margin:1rem 0;padding:.6rem 1rem 1rem}}
h2{{font-size:1.05rem;margin:.3rem 0 .6rem}} .row{{display:flex;gap:1rem;flex-wrap:wrap}}
.c{{flex:1;min-width:280px}} .c h3{{font-size:.9rem;margin:.2rem 0}} .m{{font-size:.78rem;color:#5b6b7b;margin:.2rem 0}}
.c img{{max-width:100%;border:1px solid #eef2f5}} .err{{color:#b3261e;font-size:.85rem}}</style></head><body>
<header><h1 style="margin:0;font-size:1.3rem">Benchmark : netlist → schéma (score beauté /100, gate LVS)</h1>
<p style="color:#5b6b7b;margin:.3rem 0 0">v1 naïf → place2 (piles de conduction) → place2+optimize (recherche locale)</p></header>
<main>{''.join(cards)}</main></body></html>'''
open(out + '/../benchmark.html', 'w').write(page)
print('benchmark.html généré')
PYEOF
cat $RES
