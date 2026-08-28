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

draw.io's plugin loader (`App.loadPlugins`, `js/diagramly/App.js`) accepts a
plugin by URL through the `p=` query parameter, or interactively through
**Extras > Edit Diagram... > Plugins** (actually **Extras > Plugins...** in
current builds) which prompts for a URL and remembers it in local storage.
Either path shows draw.io's **plugin security confirmation dialog**
("Plugins can access and modify your data... Only load plugins from sources
you trust") before the code executes — there is no way around this from
inside the plugin itself; it is a draw.io security gate, not something this
plugin controls.

Two ways to load it, once the api-server is serving the file (see "Server
wiring" below):

1. **URL parameter** (best for a fixed dev setup):
   ```
   https://<your-drawio-host>/?p=http://127.0.0.1:8770/plugin/eda-validate.js
   ```
   Accept the security prompt once; draw.io loads and runs the plugin.

2. **Extras > Plugins... dialog**: open draw.io normally, go to
   `Extras > Plugins...`, add `http://127.0.0.1:8770/plugin/eda-validate.js`,
   confirm the security prompt, then reload the diagram (draw.io reloads
   plugins from the stored list on next load, or immediately depending on
   build — check the dialog's own instructions).

### Configuring the api-server URL

Default is `http://127.0.0.1:8770`. To point at a different host/port,
set `window.EDA_VALIDATE_SERVER` **before** the plugin script runs — e.g. via
a second, tiny inline plugin, or a `<script>` tag on a custom draw.io host
page:
```html
<script>window.EDA_VALIDATE_SERVER = 'http://myhost:8770';</script>
```

## Server wiring required (NOT done by this change)

Two things the running `server.js` needs to add — written here for whoever
wires it in, since `server.js` is owned by another agent right now and this
change does not touch it:

1. **Serve the plugin file** so draw.io can fetch it by URL:
   ```js
   app.use('/plugin', express.static(new URL('./plugin', import.meta.url).pathname));
   ```
   (or any equivalent static mount for `api-server/plugin/`). After this,
   `GET http://127.0.0.1:8770/plugin/eda-validate.js` serves the file above.

2. **CORS headers**, since the draw.io page (served from wherever the webapp
   is hosted) and the api-server (`127.0.0.1:8770`) are different origins for
   both the plugin fetch and its `fetch()` calls to `/documents/...`:
   ```js
   app.use((req, res, next) => {
     res.header('Access-Control-Allow-Origin', '*');
     res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
     res.header('Access-Control-Allow-Headers', 'Content-Type');
     if (req.method === 'OPTIONS') return res.sendStatus(204);
     next();
   });
   ```
   Add this near the top of `server.js`, before the route definitions
   (currently there is no CORS middleware at all — confirmed by grep, so
   every plugin `fetch()` call will fail with an opaque CORS error until
   this is added, even though the endpoints themselves work fine from
   `curl` or same-origin tools).

Until both are wired, the plugin's own degrade path still applies: it will
report "api-server unreachable" (a failed/opaque fetch looks the same as a
down server from the browser's point of view) rather than crashing the
canvas.

## Known limitations

- **Plugin security prompt is unavoidable and per-browser-profile** — every
  fresh profile / incognito window re-prompts; there is no way to
  pre-authorize a plugin URL from the plugin's own code.
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
- **Not validated against a real running draw.io instance.** No browser is
  available in this environment. The file was syntax-checked with
  `bun build --target=browser eda-validate.js` (bundles cleanly, confirming
  it parses as valid ES5-ish browser JS matching the style of
  `src/main/webapp/plugins/props.js` and `number.js`), and every draw.io/
  mxGraph API it calls was grepped and confirmed to exist at the cited
  location (`ui.editor.getGraphXml`, `graph.setCellWarning`,
  `ui.actions.addAction`, `ui.menus.get('extras')`, `ui.addButton`,
  `mxWindow`, `graph.getModel().addListener(mxEvent.CHANGE, ...)`) and every
  server endpoint it calls (`POST /documents`, `GET .../erc`,
  `POST .../lvs`, `DELETE /documents/:id`) was read directly from
  `server.js`/`lib/erc.js`/`lib/lvs.js` to match request/response shape
  exactly. But end-to-end behavior in an actual browser — timing of the
  `CHANGE` event, whether `setCellWarning`'s overlay renders visibly in this
  draw.io build, whether the toolbar container exists in the default UI —
  is unverified. Load it in a real draw.io tab and exercise: (a) break a
  wire and confirm a red overlay appears within ~1s, (b) fix it and confirm
  the overlay clears, (c) stop the api-server and confirm the "unreachable"
  message, (d) toggle auto-check off and confirm no repaint happens.
