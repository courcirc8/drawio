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
