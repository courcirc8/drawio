# Rendering with strict electrical checks

Run from `api-server`:

```sh
node tools/schematic-to-netlist.mjs final.drawio --reference golden.cir --strict --visual --out extracted.cir --report lvs.json
```

The extractor reads the saved XML. Exit 2 means electrical mismatch; exit 1 means a command/input error. Unsupported SPICE directives, missing omitted-terminal metadata, changed values/models, pin multiplicity, named ports and ground discrepancies fail the strict comparison. MOS bulk and the omitted VCCS negative output are persisted separately from visible placement pins. Old documents without that information need regeneration or explicit correction, not inference from the reference at extraction time.

`electrical_match` is documentary LVS. Optional `visual_audit` reconstructs visible pin groups from stored vector segments and compares them with documentary groups. Hidden terminals are excluded. Implicit mxGraph routes that cannot be evaluated produce a null verdict. This is not a PNG/OCR extractor or a transistor-layout LVS engine; inspect actual rendered PNGs too.

Geometry trials snapshot the entire document, including wires, and restore it on rejection or exception. The invariant includes effective values, symbol identity and anchor coordinates. Route clearance repair only moves interior orthogonal lanes while preserving endpoints and existing contacts.

Shared external nets named VB/VBIAS with optional numeric suffixes, connected exclusively to MOS gates, may use one local named port per gate. Occupied placements fall back to the ordinary router. Set `localBiasPorts: false` in place2 options to compare the previous bus representation. The later boundary-port pass must skip those nets to avoid duplicate global buses.

Validation loop: saved-document LVS → unchanged independent geometry checker → rendered before/after inspection → accept or restore. Do not tune the checker to accept a rendering regression. Report individual circuits and unresolved defects alongside aggregate scores.

Port family A is the default for new imports: named arrow tags for input/output and double-ended tags for inout. Use `portDirections: { VIN: "input", VOUT: "output", RF: "inout" }` to specify electrical intent; name-based guesses are only a fallback. Unknown names remain inout. The electrical port role and net name are preserved independently of the visible shape. Existing documents are not migrated automatically.

The v3 fallback selects PMOS model variants and their source-up terminal order; the saved-netlist regression test checks both symbol polarity and connectivity.

Optional floorplan exploration (no change to default imports):

```sh
CHROME_PATH=/path/to/chrome node tools/compare-floorplans.mjs /tmp/floorplans benchmark/netlists30/folded-cascode.cir
```

`reservedChannels: true` in place2 reserves additional row/column whitespace according to visible non-rail net demand. It does not force each wire into an exclusive lane. `branchOrders` reuses existing motif detection and conduction ancestry to propose branch permutations. The explorer tries the original order, channel widths and up to three alternative orders, with and without channels. Every candidate is rebuilt independently and checked from saved XML. Only documentary LVS **and** visible connectivity audit true qualify for selection. Rank by errors, orthogonal crossings, then warnings; retain the original on ties. The checker does not count diagonal intersections. Render baseline and selected candidate for human inspection. Geometry errors can remain in the best candidate; eligibility is not a declaration of drawing perfection.

User alignment rules (optional `signalAlignment: true` on place2):

- Mirror an input MOS around its absolute drain/source axis, compensating the cell translation; gate moves, D/S do not. Externally terminated passive input branches can move to make room for the mirrored body. Shared transistor-gate and feedback networks are not automatically reinterpreted.
- Align an unbranched passive input chain and its port using stencil pin coordinates, not bounding-box centres. Obstructed proposals are skipped.
- Place an AC-coupled series output chain horizontally to the right of a drain, retaining supply branches and moving grounded output shunts below it. This rule requires a named OUT/VOUT endpoint and a chain starting with a capacitor; it is not a universal RF topology recognizer.
- Align directly attached ports vertically to their neighbour's actual pin when space permits.

Set `SIGNAL_ALIGNMENT=1` when running `compare-floorplans.mjs` to compare each floorplan with and without this pass. The selector now ranks errors, orthogonal crossings, direct gate-port jogs, then warnings. The new jog audit is an additional placement metric, not a relaxation of the independent checker. Documentary LVS and visible connectivity must both be true. Some selected drawings still contain geometry errors; these remain recorded. Transistor label placement, feedback geometry, and occupied-port fallbacks need further improvement.
