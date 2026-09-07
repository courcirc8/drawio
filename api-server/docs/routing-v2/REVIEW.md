# Skeptical review and triage

Independent reviewer wrote 14 adversarial tests, without editing implementations. Existing review skills were not available at the searched hub paths, so the start-project fallback independent review was used.

Accepted and fixed:
1. A cell called LBL_R1 could be an electrical component. Only non-electrical decorative vertices with an existing electrical owner are now eligible.
2. An equidistant label was allowed between two components. Ties now fail closed.
3. Frozen file checks could be bypassed indirectly by redirecting summary.json.source or selected. Sealed jobs now derive exclusively from manifest rows and fixed filenames. Three dedicated integrity tests added; all 43 packaged fixture inputs match the files actually benchmarked.

Clarified contract, not a checker relaxation:
- Duplicate representations of identical same-net conductors are excluded from warning counts, as in the previous conservative flow. check.py is unchanged.
- A passive placement with existing hard errors may gain up to two excess-bend warnings if every geometry error is eliminated. It cannot accumulate: later candidates have zero current errors and do not qualify. It never applies to approved placements.

No critical electrical-safety finding remains from this review. External geometry/LVS/visible audits remain mandatory. New modules do not expose network endpoints or replace the global routePage default.

Explicitly deferred limitations: browser glyph measurement, full-branch placement, obstacle-aware net trees, ambiguous MOS operating roles and the independent RLC bridge failure. They remain visible in the reports. No per-circuit profile was added to hide them.
