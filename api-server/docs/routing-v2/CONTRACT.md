# Routing improvement v2 — execution contract

Scope approved in the conversation: protect existing good schematics, derive rules from topology, jointly place branches, route whole nets, check labels, test unseen combinations, review skeptically. Local Node ESM/Python/Chrome; no paid services, no LLM, no change to check.py, no replacement of routePage default. This is a subsystem increment using existing primitives.

## Inputs and output
All candidates receive serialized draw.io XML and return new XML; never mutate the source. SPICE references use parseSpice's existing structure. Proposals are plain JSON, carry kind/id, and describe changed cells/nets. Fail closed with Error on unsupported geometry, protected bus or missing terminal. An empty proposal set is normal.

## Frozen interfaces / ownership
- passive agent: lib/functional-branches.js, test/functional-branches.test.js. Exports inferCircuitRoles(model,reference) -> {branches:[], mirrors:[], differentialPairs:[], cascodes:[], ambiguous:[]}; passiveBranchProposals(model,reference)->Proposal[]; passiveBranchCandidate(xml,proposal)->xml. Recognize graph structure without claiming circuit operating function. Detect passive bridge between terminals of a degree-two passive chain; propose bounded above/below placements with orientation/terminal side corrections and carry label; preserve reference terminals and unrelated vertices/wires. Reuse localCandidate and invariant. No hardcoded circuit names/values/IDs. MOS role inference can return ambiguous candidates, never a forced rewrite.
- net agent: lib/net-tree.js, test/net-tree.test.js. Exports netTreeProposals(model)->Proposal[]; netTreeCandidate(xml,proposal)->xml. Route only one net collectively via candidates for common horizontal/vertical trunk; retain exact edge endpoint identities, protected bus/fixed routes untouched, vertices fixed except contact decorations, other-net routes unchanged. All candidates require external geometry/LVS/visible audit. Prefer existing terminal coordinates. Do not claim global Steiner optimality.
- root: lib/label-clearance.js and test; lib/refinement-audit.js; tools/bench-functional.mjs; tools/freeze-routing-corpus.mjs; docs, integration/report/gallery. Label metrics explicitly distinguish estimates from browser measured bounds. Keep scopes separate and final acceptance driven by independent audits.

## Acceptance
Regression corpus: immutable XML/PNG/SPICE snapshot and hashes before experiments. Route-only changes retain per-net copper dominance and geometry protection. Placement candidates evaluated only for existing diagnosed defects or explicit new-circuit optimization, never blanket replace good drawings. No change accepted without strict LVS, visible connectivity and unchanged Python checker zero errors. No new label collision, no worse warning-rule counts (exact same-net duplicated strokes excluded). Exception only for repairing an already erroneous passive placement: at most two extra excess-bend warnings may replace body-wrap errors, while all geometry errors must disappear; this does not apply to approved drawings. Crossings secondary, bounded against experiment baseline, not accumulated per operation. Any unsupported or unverified proposal retains original bytes. Full PNG comparison before publishing.

## Runtime and verification
Deterministic bounded candidates and loop limits. No network endpoints added. Tests node:test, external audit check.py, PNG export existing render.js. Frozen new diagnostic netlists distinct from current 43 and six previous development cases; do not tune on final holdout. Include excluded/failed cases in report. Repeat pipeline for stability and document limitations.

## Reuse choices
Existing parse/extract/LVS/invariant/checker/render: reuse (3/3). localCandidate/gate-bus: compose (2.5/3; geometry-specific). net-tee/visible copper union: compose (2.5/3). New graph/branch proposals: build atop these; external graph packages would add integration risk without replacing electrical guards. Existing code is the reference brick; no external clone needed for this bounded increment.

## Delivery
Runnable benchmark and checked corpus comparisons, implementation/test evidence, skeptical findings and limits; opt-in tools, no default route behavior change without evidence. Candidate logs are experiments, not claimed universally better layouts.
