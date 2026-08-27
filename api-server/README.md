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

SPICE support: `R C L D V I Q M` elements, `+` continuations, `*` comments,
`.directives` skipped with a warning, `0`/`GND`/`GROUND` = ground. BJT pins
map NE=collector / W=base / SE=emitter; MOSFET NE=drain / W=gate / SE=source
(bulk node ignored).

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

## Tests

```bash
npm test        # 14 tests: model round-trip, SPICE, LVS, ERC, routing, e2e HTTP + PNG
```
