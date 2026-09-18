# drawio-api-server

REST API on a dedicated port (default **8770**) that exposes this drawio fork
for programmatic schematic work — designed to be driven by an AI assistant
(see `skill/drawio-api/SKILL.md`) or any HTTP client.

Nothing in the drawio editor core is modified: the server is a standalone
Node app that **reuses the fork's own assets**:

- `.drawio` files are plain `mxGraphModel` XML → full editing by direct XML
  manipulation (add/move/rotate/restyle components, wire pins, delete).
- **Autorouting**: the fork's canonical libavoid core
  (`src/main/webapp/js/libavoid-js/`) loaded headless in Node
  (`vm.runInThisContext`, the harness pattern from
  `docs/claude/libavoid-routing.md`) — obstacle-avoiding orthogonal routes
  with fixed pin constraints, rotation-aware.
- **Export**: headless Chromium drives the fork's own export page
  (`src/main/webapp/export3.html`, the page draw.io's image export service
  uses) → pixel-perfect PNG/PDF/SVG.
- **Shape catalog**: the 24 electrical stencil libraries with named pins
  (`src/main/webapp/stencils/electrical/`).

On top, an EDA layer that drawio itself does not have:

| Feature | Endpoint |
|---|---|
| SPICE netlist import → auto placement + wiring + routing | `POST /documents/:id/netlist/import` |
| Netlist extraction (schematic → SPICE) | `GET /documents/:id/netlist` |
| LVS (schematic vs reference netlist, structural net matching) | `POST /documents/:id/lvs` |
| ERC (floating pins, single-terminal nets, anchor issues) | `GET /documents/:id/erc` |
| BOM (JSON/CSV) | `GET /documents/:id/bom` |
| Visual critique by a multimodal model (opt-in judge, never a generator) | `POST /documents/:id/critique` |
| Motif registry: recognised analogue motifs, macro-blocks, uncovered parts | `POST /motifs` |
| LTspice `.asc` export, round-trip LVS verified (409 on mismatch) | `GET /documents/:id/export?format=asc` |

## Run

```bash
cd api-server
npm install
node server.js --port 8770      # or DRAWIO_API_PORT / npm start
```

Requires Node ≥ 20 and a local Chromium/Chrome for PNG/PDF/SVG export
(`CHROME_PATH` env var overrides autodetection; everything else works
without a browser).

## API overview

See `skill/drawio-api/SKILL.md` for the full endpoint reference and typical
sequences. Quick tour:

```bash
curl -X POST :8770/documents -H 'Content-Type: application/json' -d '{}'
curl -X POST :8770/documents/doc1/netlist/import -H 'Content-Type: text/plain' \
  --data-binary $'V1 in 0 DC 5\nR1 in out 10k\nC1 out 0 100n\n.end'
curl -o rc.png ':8770/documents/doc1/export?format=png&scale=2'
curl -X POST :8770/documents/doc1/lvs -H 'Content-Type: text/plain' --data-binary @rc.cir
```

SPICE support: `R C L D V I Q M J E F G B S` elements, `X` instances of
`.subckt` blocks (flattened: `X1.M1`, internal nets `X1.n`) or of an undefined
op-amp-like subckt (drawn as an op-amp, supplies as hidden terminals), `K`
couplings (recorded), `+` continuations, `*` comments; analysis/model
directives are kept silently, value-changing ones (`.param`, `.step`, `.func`,
`.ic`) stay warnings so strict LVS keeps rejecting them. `0`/`GND`/`GROUND` =
ground. BJT pins map NE=collector / W=base / SE=emitter; MOSFET NE=drain /
W=gate / SE=source (bulk persisted as a hidden terminal).

## Layout of a generated schematic

Sources in the left column, then BFS rank over shared nets (`lib/place.js`);
grounded 2-terminal parts are rotated vertical, every ground terminal gets
its own ground symbol, >2-terminal nets get a junction dot (star wiring),
then all wires are autorouted.

## Pin catalog

`node tools/dump-pins.js` regenerates `data/electrical-pins.json` — the exact
terminal coordinates (relative and absolute) of all 529 electrical shapes.
Stencil pin names are positional (NE/SE/W); functional overrides (e.g. the
PMOS stencil is drawn source-up) live in `lib/components.js`
(`PIN_ORDER_OVERRIDES`).

`examples/ota-biquad.sh` builds a complete 2nd-order Gm-C biquad (two OTA
symbols mapped to SPICE `G` elements) and passes LVS against its reference
netlist.

## Netlist → schematic quality loop

`lib/place2.js` places components as vertical **conduction stacks**
(VDD→ground paths) with pattern rules (bias column left, shared tails
centred, floating passives between columns, bus nets distributed along the
bottom). `POST /documents/:id/netlist/import?optimize=N` wraps it in a local
search: each candidate is re-routed, **gated by round-trip LVS**, scored by
`tools/beauty.py` (XML geometry + OpenCV: crossings, component overlaps,
bends, wire length, alignment, ink balance, optional SSIM/ORB against a
reference image; `POST …/beauty`) plus **structural legibility metrics**
computed from the recognized structures (lib/patterns.js): top-down
conduction flow with x-aligned series stacks, grounds at the bottom / VDD
taps at the top, differential pairs on the same row, mirror members aligned
with their diode — so a flat netlist dump can no longer outscore a properly
structured schematic. `tools/run-benchmark.sh` compares the
naive v1 engine, place2 and place2+optimize on `benchmark/netlists/`.

`tools/extract-figures.py` (PyMuPDF) crops the figures of a PDF library by
caption anchoring — used to build the 3900+-figure reference corpus that
feeds the visual comparison.

## Generalisation, coverage, export — session of 2026-09-18

- **Held-out corpus**: `benchmark/holdout-ltspice/` — 131 public LTspice circuits
  (mick001/Circuits-LTSpice) converted by `tools/asc2spice.mjs`, never used to
  derive a rule. `benchmark/run30.py --nets benchmark/holdout-ltspice` measures
  them with the same judge. See its README for the baseline and the gap.
- **Motif coverage**: `node tools/motif-coverage.mjs <dir>` lists which motifs
  (`lib/motifs.js`) a corpus contains and which actives no template covers.
- **Visual critique**: `node tools/critique.mjs schema.xml --netlist c.cir`
  (`ANTHROPIC_API_KEY` or `CRITIC_URL`/`CRITIC_MODEL` for a local vision model).
- **LTspice export**: `node tools/export-asc.mjs schema.xml out.asc` (exit 2 if
  the round-trip LVS fails).
- **YOLO dataset for dgx-osr**: `node tools/gen-yolo-dataset.mjs <dir> <out>
  --debug` — clean vector renders with exact boxes (classes of dgx-osr).
- **Editor plugin**: « Reroute wires (server router) » and an opt-in
  auto-reroute of the wires of moved components (`plugin/eda-validate.js`).
- **Speed**: `?optimize=N` is ~4x faster (warm export page, parallel fast
  candidates); the 43-circuit benchmark runs in ~80 s instead of ~7 min.

## Macro-blocks and hierarchical routing — `engine=v4`, `engine=auto`

`lib/place4.js` places by **macro-block**: `lib/motifs.js` partitions the
netlist into motif instances (quad, latch, cascade, mirror, pair, BJT stage,
op-amp stage…) plus one *rest* block; every block is placed **and routed**
in isolation by place2 (all its templates and rules apply inside a block),
blocks are arranged by signal flow (BFS rank → columns, ≤ 2 blocks per
column, channels widened by the nets crossing them), the block drawings are
transplanted and **only the inter-block nets are wired** (minimum spanning
tree over the closest member pins / place2 ports turned into junction dots)
and routed — intra-block routes are frozen. Single-block netlists fall back
to place2.

`engine=auto` runs place2 and place4 (both optimised when `?optimize=N`) and
keeps the result with fewer independent-checker errors, then the better
score. Measured 2026-09-18 (`tools/compare-engines.mjs`, no optimizer):

| | v2 errors | v4 errors | auto errors | auto circuits at 0 |
|---|---|---|---|---|
| benchmark 43 | 37 | 25 | 13 | 33 (v2: 27) |
| holdout 131 | 985 | 652 | 632 | 50 (v2: 44) |

With the optimizer (`run30.py --engine auto`, same judge):

| | v2 + optimize | auto + optimize |
|---|---|---|
| benchmark 43 (optimize 8) | 40/43 at 0 errors, 3 errors, beauty 74.2, 81 s | **43/43 at 0 errors, 0 errors, beauty 75.1**, 151 s |
| holdout 111 (optimize 2) | 56/111 at 0, 545 errors, beauty 49.4, 248 s | **63/111 at 0, 284 errors, beauty 51.9**, 474 s |

`auto` never loses on errors by construction (it keeps v2 when v2 is better);
the time doubles because both engines are optimised.

Known limits of v4 today: the composition is electrically exact and passes
the geometry judge better than place2 on multi-stage circuits, but reads as
*blocks joined by long wires* — the rest block is one lump far from the
stages it feeds, inter-block wires take the free space libavoid finds rather
than reserved channels. Next: split the rest block into satellites attached
next to their block, channel-reserve inter-block nets, let the optimizer
permute block order.

## Tests

```bash
npm test        # ~240 tests (33 files): model round-trip, SPICE, LVS, ERC, routing, e2e HTTP + PNG
# RF_GOLDEN_DIR=/path/to/golden  -> also runs the 9 tests bound to the two RF golden netlists (skipped otherwise)
```
