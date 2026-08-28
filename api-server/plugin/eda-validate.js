/**
 * eda-validate.js — draw.io runtime plugin: live LVS/ERC feedback for the
 * PySpectre drawio-api-server fork.
 *
 * Loads a red mxCellWarning overlay (graph.setCellWarning, mxGraph.js) on
 * any cell flagged by the api-server's ERC (GET /documents/:id/erc) and,
 * when a golden SPICE netlist is supplied, LVS (POST /documents/:id/lvs)
 * checks. Runs on demand (menu item + toolbar button) and automatically on
 * every model edit, debounced, with an on/off toggle — see README.md for
 * the plugin-URL loading mechanism, the required server-side CORS/serving
 * wiring, and known limitations.
 *
 * Copyright: PySpectre project (api-work fork). Not upstream draw.io code —
 * lives entirely under api-server/, loaded by URL, never bundled into the
 * webapp build. See api-server/plugin/README.md.
 */
Draw.loadPlugin(function(ui)
{
	var graph = ui.editor.graph;

	// ---------------------------------------------------------------
	// Config
	// ---------------------------------------------------------------
	// Overridable before the plugin loads: window.EDA_VALIDATE_SERVER = '...'
	var SERVER = (typeof window.EDA_VALIDATE_SERVER === 'string' && window.EDA_VALIDATE_SERVER !== '')
		? window.EDA_VALIDATE_SERVER : 'http://127.0.0.1:8770';
	var DEBOUNCE_MS = 800;

	var autoCheckEnabled = true;
	var debounceTimer = null;
	var checking = false;         // re-entrancy guard: skip overlapping runs
	var rerunRequested = false;   // a run was requested while one was already in flight
	var goldenSpice = '';         // optional reference netlist for LVS
	var warnedCells = [];         // cells carrying a warning from the last run, so we can clear them

	// ---------------------------------------------------------------
	// Warning overlay bookkeeping
	// ---------------------------------------------------------------

	/** Clears every warning overlay set by a previous run of this plugin. */
	function clearWarnings()
	{
		for (var i = 0; i < warnedCells.length; i++)
		{
			try { graph.setCellWarning(warnedCells[i], null); }
			catch (e) { /* cell may have been deleted since — ignore */ }
		}
		warnedCells = [];
	}

	/**
	 * Paints one overlay per offending cell, merging messages when several
	 * findings point at the same cell (e.g. an unconnected pin AND a
	 * single-terminal net on the same instance).
	 */
	function applyFindings(findings)
	{
		clearWarnings();
		var byCell = {}; // cellId -> array of message strings

		for (var i = 0; i < findings.length; i++)
		{
			var f = findings[i];
			var cellIds = f.cells || [];

			for (var j = 0; j < cellIds.length; j++)
			{
				var id = cellIds[j];
				if (byCell[id] == null) byCell[id] = [];
				byCell[id].push('[' + esc(f.severity) + '] ' + esc(f.code || '') + ': ' + esc(f.message));
			}
		}

		for (var cellId in byCell)
		{
			if (!byCell.hasOwnProperty(cellId)) continue;
			var cell = graph.model.getCell(cellId);
			if (cell == null) continue; // finding refers to a cell no longer in the model

			// setCellWarning wraps the string as-is in <font color=red>...</font>
			// (mxGraph.js:2378) — it does NOT convert '\n' to '<br>' itself
			// (only mxGraph.prototype.validateGraph does that for its own
			// caller, mxGraph.js:9130); join with <br> directly so multiple
			// findings on one cell render as separate lines in the overlay.
			graph.setCellWarning(cell, byCell[cellId].join('<br>'));
			warnedCells.push(cell);
		}
	}

	// ---------------------------------------------------------------
	// Summary window
	// ---------------------------------------------------------------

	var div = document.createElement('div');
	div.style.padding = '8px';
	div.style.fontSize = '12px';
	div.style.fontFamily = 'Arial,Helvetica,sans-serif';
	div.style.overflow = 'auto';
	div.style.height = '100%';
	div.style.boxSizing = 'border-box';

	var statusEl = document.createElement('div');
	statusEl.style.marginBottom = '6px';
	statusEl.style.fontWeight = 'bold';
	statusEl.innerHTML = 'Not run yet.';
	div.appendChild(statusEl);

	var toggleLabel = document.createElement('label');
	toggleLabel.style.display = 'block';
	toggleLabel.style.marginBottom = '6px';
	var toggleBox = document.createElement('input');
	toggleBox.type = 'checkbox';
	toggleBox.checked = true;
	toggleBox.onchange = function()
	{
		autoCheckEnabled = toggleBox.checked;
		if (!autoCheckEnabled && debounceTimer != null)
		{
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	};
	toggleLabel.appendChild(toggleBox);
	toggleLabel.appendChild(document.createTextNode(' auto-check on edit (debounced)'));
	div.appendChild(toggleLabel);

	var runNowBtn = document.createElement('button');
	runNowBtn.textContent = 'Check now';
	runNowBtn.style.marginRight = '6px';
	runNowBtn.onclick = function() { runCheck(); };
	div.appendChild(runNowBtn);

	var clearBtn = document.createElement('button');
	clearBtn.textContent = 'Clear overlays';
	clearBtn.onclick = function() { clearWarnings(); statusEl.innerHTML = 'Overlays cleared.'; };
	div.appendChild(clearBtn);

	var lvsToggleLabel = document.createElement('div');
	lvsToggleLabel.style.marginTop = '10px';
	lvsToggleLabel.style.fontWeight = 'bold';
	lvsToggleLabel.textContent = 'Golden netlist (optional, enables LVS):';
	div.appendChild(lvsToggleLabel);

	var goldenBox = document.createElement('textarea');
	goldenBox.rows = 4;
	goldenBox.style.width = '100%';
	goldenBox.style.boxSizing = 'border-box';
	goldenBox.placeholder = 'Paste a reference SPICE netlist here to run LVS in addition to ERC';
	goldenBox.onchange = function() { goldenSpice = goldenBox.value; };
	div.appendChild(goldenBox);

	var resultsEl = document.createElement('div');
	resultsEl.style.marginTop = '8px';
	div.appendChild(resultsEl);

	var iiw = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
	var win = new mxWindow('Check schematic (LVS/ERC)', div, iiw - 360, 60, 320, 360, true, true);
	win.destroyOnClose = false;
	win.setMaximizable(false);
	win.setResizable(true);
	win.setScrollable(true);
	win.setClosable(true);
	win.contentWrapper.style.overflowY = 'auto';

	function esc(s)
	{
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function renderResults(erc, lvs, serverError)
	{
		if (serverError)
		{
			statusEl.style.color = '#b71c1c';
			statusEl.innerHTML = 'api-server unreachable at ' + esc(SERVER) +
				' — start it (node server.js) and click "Check now".';
			resultsEl.innerHTML = '';
			return;
		}

		var errCount = erc.errors || 0;
		var warnCount = erc.warnings || 0;
		var lvsOk = lvs == null || lvs.match;

		statusEl.style.color = (errCount > 0 || !lvsOk) ? '#b71c1c' : (warnCount > 0 ? '#e65100' : '#2e7d32');
		statusEl.innerHTML = 'ERC: ' + errCount + ' error(s), ' + warnCount + ' warning(s)' +
			(lvs != null ? ' &nbsp;|&nbsp; LVS: ' + (lvs.match ? 'MATCH' : 'MISMATCH') : '');

		var html = '';
		var findings = erc.findings || [];

		if (findings.length === 0 && lvsOk)
		{
			html = '<p style="color:#2e7d32">Clean — no ERC findings' + (lvs != null ? ', LVS matches' : '') + '.</p>';
		}
		else
		{
			html += '<ul style="padding-left:16px;margin:4px 0">';
			for (var i = 0; i < findings.length; i++)
			{
				var f = findings[i];
				var color = f.severity === 'error' ? '#b71c1c' : '#e65100';
				html += '<li style="color:' + color + '">' + esc(f.code || '') + ': ' + esc(f.message) +
					(f.cells && f.cells.length ? ' <i>(' + esc(f.cells.join(', ')) + ')</i>' : '') + '</li>';
			}
			html += '</ul>';

			if (lvs != null && !lvs.match)
			{
				html += '<div style="font-weight:bold;margin-top:6px">LVS mismatches:</div><ul style="padding-left:16px;margin:4px 0">';
				(lvs.missing || []).forEach(function(r) { html += '<li style="color:#b71c1c">missing in schematic: ' + esc(r) + '</li>'; });
				(lvs.extra || []).forEach(function(r) { html += '<li style="color:#b71c1c">extra in schematic: ' + esc(r) + '</li>'; });
				(lvs.type_mismatches || []).forEach(function(m) { html += '<li style="color:#b71c1c">type mismatch ' + esc(m.ref) + ': ' + esc(m.schematic) + ' vs ' + esc(m.netlist) + '</li>'; });
				(lvs.value_mismatches || []).forEach(function(m) { html += '<li style="color:#e65100">value mismatch ' + esc(m.ref) + ': ' + esc(m.schematic) + ' vs ' + esc(m.netlist) + '</li>'; });
				(lvs.net_mismatches || []).forEach(function(m) {
					var netName = m.schematic_net || m.netlist_net;
					html += '<li style="color:#b71c1c">net mismatch ' + esc(netName) + ' (' + esc((m.terminals || []).join(', ')) + ')</li>';
				});
				html += '</ul>';
			}
		}

		resultsEl.innerHTML = html;
	}

	// ---------------------------------------------------------------
	// Core check
	// ---------------------------------------------------------------

	function fetchJson(url, opts)
	{
		return fetch(url, opts).then(function(resp)
		{
			if (!resp.ok)
			{
				return resp.text().then(function(text)
				{
					var err = new Error('HTTP ' + resp.status + ' ' + url + (text ? ' — ' + text : ''));
					err.httpStatus = resp.status;
					throw err;
				});
			}
			return resp.json();
		});
	}

	/**
	 * Serializes the current page, posts it as a fresh throwaway document on
	 * the api-server, runs ERC (+ LVS when a golden netlist is set), paints
	 * the overlays, updates the summary window, and deletes the temp
	 * document again. Never throws — a server-down / network error degrades
	 * to a status message instead.
	 */
	function runCheck()
	{
		if (checking)
		{
			// a run is already in flight — don't overlap requests to the
			// server; remember to run once more right after this one lands,
			// so an edit made mid-check is never silently dropped.
			rerunRequested = true;
			return;
		}
		checking = true;

		var xmlNode = ui.editor.getGraphXml();
		var xml = mxUtils.getXml(xmlNode);
		var docId = null;

		fetchJson(SERVER + '/documents', {
			method: 'POST',
			headers: { 'Content-Type': 'text/xml' },
			body: xml,
		})
		.then(function(created)
		{
			docId = created.id;
			var ercPromise = fetchJson(SERVER + '/documents/' + docId + '/erc');
			var lvsPromise = (goldenSpice && goldenSpice.trim() !== '')
				? fetchJson(SERVER + '/documents/' + docId + '/lvs', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ spice: goldenSpice }),
				}).catch(function(e) { return { match: true, error: String(e), lvs_failed: true }; })
				: Promise.resolve(null);

			return Promise.all([ercPromise, lvsPromise]);
		})
		.then(function(results)
		{
			var erc = results[0];
			var lvs = results[1];
			// NOTE: LVS findings are not painted as canvas overlays — lvs.compare
			// (lib/lvs.js) keys everything by SPICE 'ref' string, not by drawio
			// cell id, and extractNetlist does not thread the cell id through.
			// Only ERC findings (which DO carry cell ids, lib/erc.js) get an
			// overlay; LVS mismatches are surfaced in the summary window only.
			// See README.md "Known limitations" for what it would take to wire
			// LVS into the overlay path too.
			var findings = (erc.findings || []).slice();

			renderResults(erc, (lvs && !lvs.lvs_failed) ? lvs : null, false);
			applyFindings(findings);
		})
		.catch(function(err)
		{
			renderResults({ findings: [], errors: 0, warnings: 0 }, null, true);
			console.warn('[eda-validate] check failed: ' + err.message);
		})
		.then(function()
		{
			checking = false;
			if (docId != null)
			{
				// best-effort cleanup; ignore failures (server may already
				// be gone, or the id may be stale after a reload)
				fetch(SERVER + '/documents/' + docId, { method: 'DELETE' }).catch(function() {});
			}
			if (rerunRequested)
			{
				rerunRequested = false;
				runCheck();
			}
		});
	}

	// ---------------------------------------------------------------
	// Action + menu + toolbar wiring
	// ---------------------------------------------------------------

	mxResources.parse('edaValidate=Check schematic (LVS/ERC)');

	ui.actions.addAction('edaValidate', function()
	{
		win.setVisible(true);
		runCheck();
	});

	if (!ui.editor.isChromelessView())
	{
		var menu = ui.menus.get('extras');
		var oldFunct = menu.funct;

		menu.funct = function(menu, parent)
		{
			oldFunct.apply(this, arguments);
			ui.menus.addMenuItems(menu, ['-', 'edaValidate'], parent);
		};

		// Toolbar button — best-effort: some layouts (chromeless, minimal
		// UI configs) don't expose ui.toolbar, so this must not throw.
		try
		{
			if (ui.toolbar != null && ui.toolbar.container != null)
			{
				ui.addButton(null, mxResources.get('edaValidate'),
					function() { ui.actions.get('edaValidate').funct(); },
					ui.toolbar.container);
			}
		}
		catch (e) { /* no toolbar in this configuration — menu item still works */ }
	}

	// ---------------------------------------------------------------
	// Auto-check on model change, debounced
	// ---------------------------------------------------------------

	graph.getModel().addListener(mxEvent.CHANGE, function()
	{
		if (!autoCheckEnabled) return;

		if (debounceTimer != null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(function()
		{
			debounceTimer = null;
			runCheck();
		}, DEBOUNCE_MS);
	});
});
