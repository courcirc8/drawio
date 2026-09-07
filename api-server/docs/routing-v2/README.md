# Functional routing refinement v2

The opt-in flow now freezes reference inputs, detects structural branch hypotheses, places passive bridges above/below an already horizontal chain, proposes shared trunks for complete nets, and moves colliding owned text labels. The default routePage behavior is unchanged.

## Run locally

From the repository root, with Node dependencies installed in api-server and Python 3 available:

```sh
export CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node api-server/tools/bench-functional.mjs api-server/benchmark/frozen-v2 /tmp/routing-v2-run
python3 api-server/tools/build-functional-gallery.py /tmp/routing-v2-run
REPLAY_ONLY=1 node api-server/tools/bench-functional.mjs /tmp/routing-v2-run /tmp/routing-v2-replay
```

Each output must be new. Open the generated index.html in a browser to inspect all before/after PNGs. The first command runs the 43 sealed reference drawings, six previous development combinations and four separately frozen validation combinations. All failures remain in report.json. The reference fixture includes PNG, XML and SPICE, approximately 1.9 MB total. The manifest is authoritative; editing summary.json cannot redirect the sealed inputs.

To seal another selected corpus:

```sh
node api-server/tools/freeze-routing-corpus.mjs INPUT_CORPUS NEW_SNAPSHOT
```

The source summary must identify each case's `name`, `selected` XML/PNG basename and `source` SPICE path. Hashes detect accidental change, not deliberate replacement of the manifest itself.

## Verified results

Five passes and an identical replay on 53 diagrams. First run: 1,026 candidates. Replay: 939 candidates, zero changed diagrams.

- 43 references: 15 changed, 28 byte-identical; all strict LVS and visible connectivity pass, zero Python geometry errors before/after, crossings remain 19. Thirteen label moves remove 13 detected collisions. Nine whole-net operations accepted. Components and protected buses remain in place.
- Six development cases: four changed. The known bridged-T goes from two body-wrap errors to zero. Three explicit label collisions are removed. All six final geometry checks pass.
- Four independent synthetic combinations: one improves (two net operations and one label move); the RLC bridge remains at two geometry errors. Three pass geometry. All four pass electrical audits. No tuning was performed on this validation set after observing it.
- All 53 electrical audits pass; 52 geometry audits pass. Twenty changed PNG pairs and the failed case were inspected. Existing mirror-bus conventions remain a separate topology pass; this increment does not automatically orient MOS hypotheses.

The independent set is small and synthetic; these observations are not a proof of generalization. The previous six cases are explicitly development data now.

## Tests and limits

56 targeted node:test tests pass (including 14 independent adversarial cases). New branch and net-tree modules have 100% line coverage in that suite; line coverage alone overstates confidence for compact code. Audit subprocess paths are also exercised by the full corpus benchmark, not inferred from unit coverage.

Run the new contract tests:

```sh
node --test api-server/test/frozen-corpus.test.js api-server/test/functional-branches.test.js api-server/test/net-tree.test.js api-server/test/label-clearance.test.js api-server/test/routing-v2-adversarial.test.js
```

Broader verification also included the conservative-cleaning, cleaning, feedback-refinement, gate-bus and generic-refinement test files.

Placement supports bridges around straight horizontal ordered passive paths only; it does not yet optimize whole branches. Search is bounded. MOS mirror/differential/cascode groups are tentative structural hypotheses, not operating-point analysis. Trunks use direct orthogonal projection; body collisions are rejected, not detoured. Label checks use explicit text-cell boxes, not all embedded labels or browser glyph bounds.

Accepted candidates must preserve electrical identity, LVS, visible connectivity, zero geometry errors and label-pair safety. Route changes require per-net visible copper dominance. Existing good placements are frozen. At most two extra excess-bend warnings are permitted solely to eliminate all pre-existing passive placement errors; the exception ends immediately once repaired. Crossings are bounded against the initial baseline, not accumulated. Exact duplicate same-net strokes are excluded from warning budgets. See CONTRACT.md and REVIEW.md.
