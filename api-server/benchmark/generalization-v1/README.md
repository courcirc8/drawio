# Conservative route cleaning, experiment v1

These six synthetic combinations were frozen before evaluating the new conservative selector. They are additional diagnostic cases, not paper extractions and not a statistically representative blind test. No circuit-name selector is used by conservative-cleaning.js. Existing imported placement and other legacy modules may contain assumptions; this experiment does not certify the entire generator as universal.

## Rule boundaries

- First establish electrical topology and drawing intent (e.g. multi-output mirror buses). For an existing approved drawing, the route-only pass freezes all non-contact vertices and protected wires. It cannot fix a placement error by itself.
- Compare the union of visible horizontal/vertical segments per electrical net, not the sum of redundant XML edge paths. A branch tee is not a degree-two elbow. Reject diagonal candidates.
- Require at least one visible improvement, with no increase in either visible length or elbow count on any other net. This Pareto condition deliberately abstains from many tradeoffs.
- Independently enforce terminal fingerprint, strict LVS, visible connectivity, the unchanged Python geometry checker, no worsening of each existing feedback/cleaning metric or warning-rule count. Exact redundant same-net strokes are excluded from warning comparisons. At most two extra crossings per accepted operation are permitted; they cannot justify worse net geometry.
- Accepted geometry must be checked in PNG. Numeric dominance is not proof of human preference: existing labels and a schematic's intent can escape the metrics.

## Reproduction

From api-server's parent repository, set CHROME_PATH to the installed browser and run:

```
node --test api-server/test/conservative-cleaning.test.js api-server/test/cleaning.test.js api-server/test/feedback-refinement.test.js api-server/test/gate-bus.test.js api-server/test/generic-refinement.test.js
node api-server/tools/bench-conservative.mjs INPUT_CORPUS NEW_OUTPUT
REPLAY_ONLY=1 node api-server/tools/bench-conservative.mjs NEW_OUTPUT NEW_REPLAY_OUTPUT
```

INPUT_CORPUS contains summary.json with name, source SPICE path and selected XML/PNG id. The benchmark runs five passes: conduction projection, local minimum-bend routing, conduction-axis proposals, compact local routing, final conduction projection. Full audits gate every accepted candidate. The replay is an empirical fixed-point check, not a termination proof. A second execution with no accepted changes preserves the original XML bytes.

For fresh circuits, the existing `tools/refine-gate-buses.mjs CORPUS` separately applies the explicit topology convention. Do not run it blindly over approved layouts: it may intentionally change reference orientation or accept longer copper to obtain the required common bus. This separation was exercised without modifying that algorithm on the two new mirror fixtures.

## Observations, 2026-09-07

43 previous drawings: 813 proposals across all 49 cases; 8 accepted operations in 5 previous drawings, 38 previous drawings byte-identical. All 43 pass LVS, visible connectivity and geometry. Visible length decreases by 679.5 drawing units and seven degree-two elbows disappear. Crossings 18 → 19; raw warnings 323 → 316. Second pass: 815 proposals, no changes. 27 targeted tests pass.

Six new fixtures: initial LVS and visible connectivity pass in all six, geometry passes in five. Conservative cleaning alone changes none. Existing topology normalization gives a common bus with correctly facing reference on both three-output mirrors (zero geometry errors and electrical audits pass). Bridged-T remains blocked by two wrap-around errors; relocating/rotating a passive bridge is outside the route-only contract. RC load labels remain visually crowded despite zero geometry errors. These are explicit failures/limits, not hidden by the score or removed from the sample.

The new code is opt-in through a reusable module and benchmark, not wired into the global routePage default. Promotion to the default router needs broader independent topologies and a placement-aware contract.
