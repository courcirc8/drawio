# eda-validate — live LVS/ERC feedback in the draw.io canvas

`eda-validate.js` is a runtime draw.io plugin (`Draw.loadPlugin(...)`, loaded
by URL — nothing under `src/main/webapp/` is modified). It closes the loop
where an LLM generates a schematic from a netlist and a human then edits it
blind: it re-checks the current page against the api-server's ERC (and,
optionally, LVS) engine and paints failures directly on the offending cells.

## What it checks

- **ERC** (`GET /documents/:id/erc`, `lib/erc.js`): unconnected pins,
  floating ground/tap symbols, single-terminal nets, plus whatever
  `connectivity()` (`lib/netlist.js`) itself flags as an issue.
- **LVS** (`POST /documents/:id/lvs`, `lib/lvs.js`), only when you paste a
  reference SPICE netlist into the "Golden netlist" box in the plugin
  window: missing/extra components, type and value mismatches, structural
  net mismatches.

Findings are rendered two ways:
1. A **summary window** ("Check schematic (LVS/ERC)", opened from
   `Extras > Check schematic (LVS/ERC)` or the toolbar button) listing every
   finding with its severity, code, message and cell id(s), plus the full
   LVS report when a golden netlist is supplied.
2. A **red warning overlay** on each offending cell, via mxGraph's built-in
   (but otherwise unused-by-draw.io) `graph.setCellWarning(cell, message)` —
   hover the cell to see the message. Overlays are cleared and repainted on
   every run, so nothing goes stale silently.

It re-runs automatically on every model edit, **debounced ~800 ms**, and can
be toggled off with the checkbox in the summary window — a stale green
verdict left on screen while you keep editing is worse than no verdict, so
turning auto-check off also stops repainting old overlays.

If the api-server is not reachable at the configured URL, the summary window
says so plainly ("api-server unreachable at ..., start it and click
Check now") instead of throwing or silently doing nothing.

## Loading the plugin into draw.io

**The supported way is `/editor`** (`server.js`): open
`http://<api-server-host>:<port>/editor/` and the plugin is already loaded —
no URL param, no dialog, nothing to paste. This is a real HTTP route on the
api-server, not a doc convention: it serves the fork's own
`src/main/webapp/index.html`, rewritten **per response** (nothing on disk
under `src/` is touched — `git diff` against upstream outside `api-server/`
stays empty) to add `<base href="/editor/">` and inject the plugin script.
Same origin as the API itself, so the plugin's `fetch()` calls to
`/documents/...` are same-origin and `window.EDA_VALIDATE_SERVER` is set
automatically to match whatever host/port the server is actually running on
(see "why this needed fixing" below) — nothing to configure.

### Why a dedicated route, and not `?p=` or the Plugins dialog

**Found 2026-08-28**, the first time this plugin was ever loaded in a
browser: the two loading paths draw.io itself documents do **not** work in
this fork's build.

- **`?p=<url>` is a registry-key lookup, not a raw-URL loader.**
  `urlParams['p']` is handed to `App.loadPlugins` (the *static* function,
  `js/diagramly/App.js:1653`), which does `App.pluginRegistry[plugins[i]]` —
  i.e. it treats the `p=` value as a **key** into the built-in plugin
  registry (`App.pluginRegistry`, `App.js:326`), never as a URL to fetch.
  `eda-validate` is not in that registry, so
  `?p=http://127.0.0.1:8770/plugin/eda-validate.js` logs
  `Unknown plugin: http://127.0.0.1:8770/plugin/eda-validate.js` to the
  console and loads nothing. Confirmed live: Chrome for Testing 147 via
  Puppeteer, `console` capture, no other output.
- **The Extras > Plugins... dialog cannot accept a custom URL either**, for
  the same reason one layer up: the dialog's inline "Add" control only lists
  entries from `App.pluginRegistry` (`Dialogs.js:15756-15797`), and the
  "Custom..." button that would let you type an arbitrary URL only renders
  `if (ALLOW_CUSTOM_PLUGINS)` (`Dialogs.js:15799`). `ALLOW_CUSTOM_PLUGINS`
  defaults to `false` (`js/diagramly/Init.js:76`) and nothing in this fork's
  webapp sets it — so the button is simply absent from the dialog. (Even if
  it were enabled, that path feeds `mxSettings`'s plugin list, which is
  checked separately in `App.js:988-1058` against `App.isSameDomain` — a
  second gate the `p=` path never even reaches.)

Registering `eda-validate` in `App.pluginRegistry`, or flipping
`ALLOW_CUSTOM_PLUGINS`, would both touch `src/main/webapp/js/diagramly/`,
breaking the "fork stays a sidecar" rule this change was built under. `/editor`
sidesteps both: it goes straight through `Draw.loadPlugin` (the plugin's own
single entry point, unrelated to either gate above), which is a queue until
the App/EditorUi instance exists and an **immediate invoke** after
(`App.js:161`) — any script that calls it runs the moment it does, regardless
of how it got onto the page. draw.io's plugin security confirmation dialog
does **not** appear on this path (it is a gate on the two mechanisms above,
not on `Draw.loadPlugin` itself), so there is no prompt to accept.

### Two more bugs `/editor` itself needed fixing (found + fixed 2026-08-28)

Both in `server.js`'s `wrapEditor`, both covered by
`api-server/test/plugin.test.js` so they can't silently regress:

1. **`ReferenceError: Draw is not defined`, 100% reproducible.** The first
   version of `/editor` injected a plain
   `<script src="/plugin/eda-validate.js"></script>` right before `</body>`.
   index.html's own last script (`js/main.js`, also right before `</body>`)
   is a synchronous, blocking `<script src>`: the browser runs it to
   completion, in source order, before moving on to the injected tag
   immediately after it. But `js/main.js` is only the entry point for this
   fork's unbundled dev build — it does not itself build the App/EditorUi
   instance. `window.Draw` is created by `App.initPluginCallback()`
   (`App.js:1627`), called from deep inside App's own async bootstrap
   (`App.js:1015`, behind config/`mxSettings` loading the surrounding code
   comments say can be deferred) — well after `js/main.js`'s script tag has
   already returned. Re-ordering the injection point relative to `</body>`
   would **not** have fixed this, since App.js's own async chain, not DOM
   position, decides when `Draw` appears. Fix: the injected snippet now
   polls for `window.Draw.loadPlugin` (20 ms interval) before creating the
   real `<script>` tag, instead of assuming it exists.
2. **Hardcoded default `SERVER` silently pointed at the wrong origin.** The
   plugin's own default (`eda-validate.js:26`,
   `'http://127.0.0.1:8770'`) is correct only when the api-server happens to
   run on its historical default port. `/editor` is same-origin with the API
   by design, but the first version of the injected snippet never actually
   set `window.EDA_VALIDATE_SERVER` — so on any other port the plugin quietly
   talked to whatever (if anything) was listening on 8770 instead of the
   server it was served from. This went undetected in the first round of
   manual testing purely because another api-server instance happened to be
   on 8770 at the time; since mxfile cell ids (`R1`, `R2`, ...) are embedded
   in the posted XML itself, not server-assigned, the wrong server returned
   matching-looking ERC results by coincidence. On a host with nothing on
   8770 this degrades to "api-server unreachable" pointing at the wrong port
   while a reachable server sits one line above it. Fixed: `wrapEditor` now
   derives the origin from the request (`req.protocol` + `req.get('host')`,
   proxy-safe) and injects `window.EDA_VALIDATE_SERVER` set to it.

### Configuring the api-server URL for OTHER hosting setups

If you serve `eda-validate.js` some other way (not via `/editor`) — e.g. a
custom host page that injects it itself — set `window.EDA_VALIDATE_SERVER`
**before** the plugin script runs:
```html
<script>window.EDA_VALIDATE_SERVER = 'http://myhost:8770';</script>
```
`/editor` needs none of this; it sets it for you (see above).

## Known limitations

- **Plugin security prompt does not apply to the loading path that actually
  works.** The two paths where draw.io shows a "Plugins can access and
  modify your data..." confirmation (the `p=` URL param and the Extras >
  Plugins... dialog) turned out, on inspection and live testing, not to load
  this plugin at all in this fork's build — see "Loading the plugin into
  draw.io" above. The `page.addScriptTag` / `<script src>` injection path
  that DOES work goes straight through `Draw.loadPlugin`, which has no
  security gate of its own.
- **LVS pseudo-findings are not (yet) mapped to cell overlays.** ERC findings
  carry drawio cell ids directly (`lib/erc.js` builds `cells: [cell.id, ...]`
  from the live model), so those get precise overlays. LVS findings
  (`lib/lvs.js`) are keyed by SPICE `ref` strings from `extractNetlist`, not
  drawio cell ids — the summary window lists them in full, but no
  cell-id-to-`ref` reverse lookup is implemented, so LVS mismatches do not
  currently paint a canvas overlay, only ERC ones do. Wiring this up would
  need `extractNetlist`'s per-component cell id to be threaded through
  `lvs.compare`'s output (it currently drops it), which is out of scope for
  this change.
- **Every check run creates and deletes a throwaway document** on the
  server (`POST /documents` then `DELETE /documents/:id`), since the server
  has no "validate this XML without persisting it" endpoint. Harmless
  (documents are in-memory and cheap) but means the server's document list
  briefly shows one extra entry per keystroke-triggered check; the DELETE
  is best-effort (fire-and-forget, errors ignored) so a server restart
  mid-run cannot leave the plugin stuck.
- **Browser-verified 2026-08-28** (Chrome for Testing 147 via Puppeteer,
  `findChrome()` in `lib/render.js`; the fork's own
  `src/main/webapp/index.html` served over `http://127.0.0.1` — file:// was
  not tried since http:// worked directly and is closer to real deployment).
  Loaded via the `Draw.loadPlugin` injection path documented above, driving
  the actual `js/diagramly/App.js` / `mxgraph` source (this build serves
  unbundled `js/main.js`, not `app.min.js`). All four items this section used
  to list as unverified now have a direct answer:
  - (a) breaking a wire (`DELETE .../cells/:id` on the connecting wire, then
    loading the resulting XML with `ui.editor.setGraphXml`) and running the
    check paints a real overlay: `graph.getCellOverlays(cell)` returns a
    tooltip string built from the ERC findings, and it is visibly rendered —
    a warning triangle on the offending pin in a full-page screenshot.
  - (b) reconnecting the wire and re-running the check drops the overlay
    count on the fixed cells back to 0 while leaving it on a cell that is
    still broken (verified on a 3-component RC chain: breaking R2↔C1 gives
    all three cells 1 overlay each; reconnecting it gives R2 and C1 zero
    overlays while R1, still floating, keeps its 1).
  - (c) pointing `EDA_VALIDATE_SERVER` at a dead port and running the check
    shows the exact "api-server unreachable at ... — start it ... and click
    'Check now'" status text, styled red, with no thrown exception.
  - (d) unchecking "auto-check on edit (debounced)" and then mutating the
    model (`graph.model.setValue`) produces **zero** requests to the
    api-server over 1.5 s (> the 800 ms debounce) — confirmed by watching
    Puppeteer's `request` events, not by reading the code.
  - The menu entry, toolbar button, and summary window (title, ERC count,
    findings list, LVS mismatch list) were all confirmed present with real
    DOM/screenshot evidence, including a live LVS mismatch report (missing
    component + net mismatches) against a deliberately wrong golden netlist.
  - What was NOT re-verified: the `p=` URL param and Extras > Plugins...
    dialog do not work at all in this build (see above) — that supersedes,
    rather than answers, the old "load it via `p=`" instruction.
