# What the beauty score can and cannot see

`beauty.py` combines three independent sources, and — **before 2026-08-28** —
`score()` treated a **missing** term exactly like a **perfect** term: it
never lowered the score just because a metric could not be computed, and it
returned a single bare float with no record of what went into it. Two
documents could get the "same" 87.1 for very different reasons (one because
it was genuinely well laid out, one because half its metrics silently
defaulted to "flawless"), and nothing in the output let a caller tell them
apart. Sections 1-3 below describe which tier each term lives in and what
makes it unavailable; **"Score output contract" at the end describes the
2026-08-28 fix** — read that section before comparing any two numbers this
module produces.

## 1. Geometry only (from the drawio XML) — always available

Computed by `xml_metrics()` from `doc.xml` alone; needs neither a render nor
cv2. Always present, always real, whenever `beauty.py` is given a valid XML:

`crossings`, `through_component`, `bends`, `excess_bends`, `wire_length`,
`min_length`, `too_close`, `label_on_wire`, `label_overlap`, `align_ratio`,
`sprawl`, `n_wires`, `n_components`.

## 2. cv2 on the rendered PNG — needs Chromium + cv2

`cv_metrics()` needs `doc.png`, produced by `lib/render.js` via
`puppeteer-core` driving a headless Chromium/Chrome binary
(`CHROME_PATH` or one of the hardcoded candidates in `render.js:16`), and
needs the `cv2`/`numpy` Python packages beauty.py imports lazily inside the
function.

- `ink_balance` — needs only the rendered PNG (no reference image).
- `ssim`, `orb_match` — need the rendered PNG **and** a reference PNG
  (`reference.png`, the 3rd CLI arg / `{reference}` body field of
  `POST /documents/:id/beauty`). Without a reference, these two keys are
  simply absent from `m` even if rendering succeeded.

**What happens when Chromium is missing**: `lib/render.js:24-25` raises
`no Chromium/Chrome found`, and `lib/beauty.js`'s `scoreDocument()` has no
fallback — `POST /documents/:id/beauty` (and `GET .../export?format=png`)
fail outright with a 500. `beauty.py` run standalone on an XML with a
nonexistent/unreadable PNG path degrades more gracefully: `cv2.imread`
returns `None` and `cv_metrics()` returns `{}` (beauty.py:299-301) instead
of raising — and since 2026-08-28, `score()` reports that explicitly: the
`unbalance` weight lands in `missing_terms` and its 8.0 points move from
`evaluated_weight` to `missing_weight`, instead of silently scoring the
missing `ink_balance` as penalty 0 ("perfectly balanced").

## 3. Structural / "human readability" — needs Node, computed in JS

`flow_ok`, `rails_ok`, `pair_sym`, `mirror_row` are computed by
`structuralMetrics()` in `lib/beauty.js`, **not** in `beauty.py`. They reach
`beauty.py` only as the optional 4th CLI arg (`struct.json`), which
`lib/beauty.js`'s `scoreDocument()` writes and always passes. There is no
Python fallback that recomputes them, and no HTTP endpoint exposes
`structuralMetrics()` on its own — it only ever runs as part of the
same render-then-score path as cv2 metrics above, so it is unavailable
whenever rendering is (this project's Chromium-less benchmark host included).

Before 2026-08-28, `score()` read all four with `m.get(key, 1)` — a missing
structural term scored as **zero penalty on a combined 46-point weight**
(`flow` 22 + `rails` 10 + `pair_sym` 8 + `mirror_row` 6, i.e. nearly half of
`WEIGHTS`'s total mass), the single largest silent gap this score ever had.
A document run through bare `beauty.py` (no `struct.json`) was assumed to
have perfect flow, rails, pair symmetry and mirror alignment, with no trace
of that assumption in the output.

## Score output contract (fixed 2026-08-28)

`score(m)` returns a **dict**, never a bare float:

| Key | Present when | Meaning |
|---|---|---|
| `score_partial` | always | 100 − Σ(weight × penalty) over EVALUATED terms only |
| `score` | `missing_weight == 0.0` | same number as `score_partial`, but only when nothing was skipped — the safe drop-in for the old bare-float return |
| `evaluated_weight` | always | sum of `WEIGHTS[...]` actually applied |
| `missing_weight` | always | sum of `WEIGHTS[...]` skipped (`evaluated_weight + missing_weight == sum(WEIGHTS.values())` always) |
| `missing_terms` | always | list of `WEIGHTS` keys skipped, e.g. `['unbalance','flow','rails','pair_sym','mirror_row']` with no PNG/struct.json |

A term is "missing" iff at least one metric key it needs is absent from `m`
— not merely zero/falsy. `metrics` in the printed JSON also gets an explicit
`'unavailable'` string for every such key (and for `ssim`/`orb_match`, which
carry no weight but were just as silently absent before), so `metrics` reads
consistently on its own.

**Chosen design — `score_partial` + `missing_weight`, not a best/worst
range.** The task offered two options; a range needs a defensible "worst
case" per term. That's well-defined for the four bounded `(1 - ratio)`
structural terms (worst = the full weight), but not for the count-based
geometry terms (crossings, bends, wire_length, …), which have no natural
ceiling — and those are, in practice, never actually missing (they come
straight from the XML, always present). Inventing an arbitrary ceiling to
fill in a range that would never be exercised was rejected as spurious
precision. `score_partial` says exactly what was measured, no more, no less.

## Comparison guard: `beauty.compare(a, b)`

Two `score()` results are only safe to diff when their `missing_terms` sets
are identical. `compare(a, b)` checks that and returns `{'error': ...,
'a_missing': [...], 'b_missing': [...]}` instead of a number when they
differ, or `{'metric': 'score'|'score_partial', 'a': ..., 'b': ...,
'delta': ...}` when they match. Use it for every before/after or
best-candidate comparison — see `tools/gen_baseline.py`'s
`comparisons.tsv` generation for the reference usage (per-circuit
v1-vs-v2-vs-opt, with `opt` correctly falling to `not_run` rather than
being compared as a missing/zero score).

## Net effect: read `missing_terms`, not the number, as the first fact

Any score/metrics blob should be read together with which of the three
tiers above actually ran, and `score()`'s own output now says so directly
instead of requiring this note. `benchmark/results/results.tsv` (generated
by `tools/gen_baseline.py` on a host with no headless Chromium — see that
script's docstring) is the concrete example: `v1`/`v2` rows carry a real
`score_partial` with `score` correctly `unavailable` (5 terms always missing
here) and `missing_terms` spelled out per row; `opt` rows are entirely
`unavailable` because the optimizer's hill-climb itself calls the
render-and-score path internally on every iteration, so
`netlist/import?optimize=N` fails before any document exists to measure.
`benchmark/results/comparisons.tsv` records the guarded pairwise deltas.
