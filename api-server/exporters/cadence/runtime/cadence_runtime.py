# cadence_runtime.py — the part of a generated Cadence script that runs at the
# user's site, inside Virtuoso through skillbridge (exporters/cadence, drawio).
#
# The generated file is: PLAN (the neutral schematic in Virtuoso user units,
# y up) + DEFAULT_MAP (analogLib symbols) + this file. It reads the symbols'
# REAL pins in the masters (terminals, dbTransformBBox): no pin coordinate of
# any library is stored in the plan. It then:
#   1. places every instance in the orientation (of 8) that puts its pins
#      nearest the planned pins, on the grid;
#   2. joins each pin to its planned point by a short L wire when they differ,
#      draws the planned wires (already cut at every connection point:
#      Virtuoso connects wire ends only), labels, ground symbols, pins, bulks;
#   3. runs schCheck and compares Virtuoso's connectivity with the SOURCE
#      deck (no open, no short, ground on gnd!, ports named, instance count);
#   4. writes a report made of COUNTS only (no library, cell, parameter or
#      path name: foundry kits are under NDA). Nothing is sent anywhere.
import argparse
import hashlib
import json
import sys

ORIENTS = ["R0", "R90", "R180", "R270", "MY", "MYR90", "MX", "MXR90"]
EPS = 1e-6


def xf(p, orient):
    """A master point in an orientation (Cadence convention, y up)."""
    x, y = p
    return {"R0": (x, y), "R90": (-y, x), "R180": (-x, -y), "R270": (y, -x),
            "MY": (-x, y), "MX": (x, -y), "MYR90": (-y, -x), "MXR90": (y, x)}[orient]


def same(a, b):
    return abs(a[0] - b[0]) < EPS and abs(a[1] - b[1]) < EPS


def centre(bbox):
    (x0, y0), (x1, y1) = bbox
    return ((x0 + x1) / 2.0, (y0 + y1) / 2.0)


def snap(v, g):
    return round(round(v / g) * g, 9)


def on_segment(p, a, b):
    """p on the closed orthogonal (or any) segment a-b."""
    if p[0] < min(a[0], b[0]) - EPS or p[0] > max(a[0], b[0]) + EPS:
        return False
    if p[1] < min(a[1], b[1]) - EPS or p[1] > max(a[1], b[1]) + EPS:
        return False
    return abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < EPS


# ---------------------------------------------------------------- the map

def parse_map(text, into=None):
    """`key = value` lines (# comments). Later lines override earlier ones."""
    m = dict(into or {})
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        k, v = line.split("=", 1)
        m[k.strip()] = v.strip()
    return m


def symbol_entry(m, comp):
    """The map entry of a component: `model.<deck model> = <key>` first, else its role."""
    key = m.get("model." + str(comp.get("model") or "").lower()) or comp["role"]
    lib, cell = m.get(key + ".lib"), m.get(key + ".cell")
    if not lib or not cell:
        return None
    params = {k[len(key) + 7:]: v for k, v in m.items() if k.startswith(key + ".param.")}
    return {"key": key, "lib": lib, "cell": cell, "view": m.get(key + ".view", "symbol"),
            "terms": m.get(key + ".terms", "").split(), "params": params}


def param_value(comp, source):
    """A parameter's value taken from the deck line only (never invented)."""
    p = comp.get("params") or {}
    if source in ("model", "value", "dc"):
        return p.get(source)
    return (p.get("kv") or {}).get(source.lower())


# ---------------------------------------------------------------- export

class Export:
    def __init__(self, ws, plan, m, lib, cell, overwrite=False):
        self.ws, self.plan, self.m, self.lib, self.cell = ws, plan, m, lib, cell
        self.overwrite = overwrite
        self.g = float(plan.get("grid", 0.0625))
        self.stats = {"stubs": 0, "stub_length": 0.0, "label_fallbacks": 0, "bulk_labels": 0,
                      "params_set": 0, "params_skipped": 0, "segments": 0, "labels": 0}
        self.problems = []      # generic messages (no names)
        self.local = []         # detailed messages, printed only with --detail
        self.masters = {}
        self.profile = {}       # role -> symbol terminals (written only with --write-profile)
        self.insts = {}         # ref -> (inst, {spice index: actual point}, entry)
        self.taken = []         # (a, b, net): segments / points (a == b) already drawn or planned

    # -- helpers
    def master(self, lib, cell, view="symbol"):
        k = (lib, cell, view)
        if k not in self.masters:
            self.masters[k] = self.ws.db.open_cell_view_by_type(lib, cell, view, None, "r")
        return self.masters[k]

    def term_offsets(self, master):
        out = {}
        for t in master.terminals or []:
            pins = t.pins or []
            if pins:
                out[t.name] = centre(pins[0].fig.b_box)
        return out

    def wire(self, points, net):
        pts = [list(p) for i, p in enumerate(points) if i == 0 or not same(p, points[i - 1])]
        if len(pts) < 2:
            return []
        segs = self.ws.sch.create_wire(self.cv, "draw", "full", pts, self.g, self.g, 0.0) or []
        self.stats["segments"] += len(segs)
        for i in range(1, len(pts)):
            self.taken.append((tuple(pts[i - 1]), tuple(pts[i]), net))
        return segs

    def label(self, seg, at, text):
        self.ws.sch.create_wire_label(self.cv, seg, list(at), text, "lowerCenter", "R0", "stick", self.g, None)
        self.stats["labels"] += 1

    def free(self, path, net):
        """No point or segment of another net touches this polyline."""
        for i in range(1, len(path)):
            a, b = path[i - 1], path[i]
            for (p, q, n) in self.taken:
                if n == net:
                    continue
                if on_segment(p, a, b) or on_segment(q, a, b) or on_segment(a, p, q) or on_segment(b, p, q):
                    return False
        return True

    def stub_out(self, inst, at, net, text):
        """A short wire outward from a pin, then a label: connection by name."""
        bb = self.ws.db.transform_b_box(inst.master.b_box, inst.transform)
        c = centre(bb)
        dx, dy = at[0] - c[0], at[1] - c[1]
        dirs = [(1 if dx >= 0 else -1, 0), (0, 1 if dy >= 0 else -1)] if abs(dx) >= abs(dy) else \
               [(0, 1 if dy >= 0 else -1), (1 if dx >= 0 else -1, 0)]
        dirs += [(-d[0], -d[1]) for d in dirs]
        for d in dirs:
            for n in (2, 3, 4, 6):
                end = (snap(at[0] + d[0] * n * self.g, self.g), snap(at[1] + d[1] * n * self.g, self.g))
                if self.free([at, end], net):
                    segs = self.wire([at, end], net)
                    if segs:
                        self.label(segs[-1], end, text)
                        return True
        self.problems.append("no free place for a label stub")
        return False

    # -- steps
    def open(self):
        if not self.ws.dd.get_obj(self.lib):
            raise SystemExit("work library not found (see --lib)")
        old = self.ws.db.open_cell_view_by_type(self.lib, self.cell, "schematic", None, "r")
        if old and not self.overwrite:
            raise SystemExit("the schematic already exists: choose another --cell or add --overwrite")
        self.cv = self.ws.db.open_cell_view_by_type(self.lib, self.cell, "schematic", "schematic", "w")
        if not self.cv:
            raise SystemExit("could not open the schematic for writing")

    def place(self):
        for comp in self.plan["components"]:
            e = symbol_entry(self.m, comp)
            if e is None:
                self.problems.append("no symbol in the map for role " + comp["role"])
                continue
            mst = self.master(e["lib"], e["cell"], e["view"])
            if not mst:
                self.problems.append("symbol not found for role " + comp["role"])
                continue
            offs = self.term_offsets(mst)
            if comp["role"] not in self.profile:
                self.profile[comp["role"]] = {"order": e["terms"], "bbox": [list(p) for p in mst.b_box],
                                              "terms": {t: list(offs[t]) for t in e["terms"] if t in offs}}
            need = [p["index"] for p in comp["pins"]] + [h["index"] for h in comp.get("hidden", [])]
            if any(i >= len(e["terms"]) or e["terms"][i] not in offs for i in need):
                self.problems.append("symbol terminals do not match the map for role " + comp["role"])
                continue
            drawn = [(e["terms"][p["index"]], p["at"]) for p in comp["pins"]]
            best = None
            for o in ORIENTS:
                if drawn:
                    ts = [xf(offs[t], o) for t, _ in drawn]
                    ox = snap(sum(P[0] - t[0] for (_, P), t in zip(drawn, ts)) / len(ts), self.g)
                    oy = snap(sum(P[1] - t[1] for (_, P), t in zip(drawn, ts)) / len(ts), self.g)
                    cost = sum((ox + t[0] - P[0]) ** 2 + (oy + t[1] - P[1]) ** 2 for (_, P), t in zip(drawn, ts))
                else:
                    ox, oy, cost = comp["at"][0], comp["at"][1], 0.0
                if best is None or cost < best[0] - 1e-9:
                    best = (cost, o, [ox, oy])
            inst = self.ws.db.create_inst(self.cv, mst, comp["ref"], best[2], best[1])
            if not inst:
                self.problems.append("an instance could not be created")
                continue
            for name, source in sorted(e["params"].items()):
                v = param_value(comp, source)
                if v is None or v == "":
                    self.stats["params_skipped"] += 1
                    continue
                self.ws.db.replace_prop(inst, name, "string", str(v))
                self.stats["params_set"] += 1
            actual = {}
            for t in mst.terminals or []:
                if t.pins:
                    bb = self.ws.db.transform_b_box(t.pins[0].fig.b_box, inst.transform)
                    actual[t.name] = centre(bb)
            pts = {i: actual[e["terms"][i]] for i in need}
            self.insts[comp["ref"]] = (inst, pts, e)
            nets = {p["index"]: p["net"] for p in comp["pins"]}
            nets.update({h["index"]: h["net"] for h in comp.get("hidden", [])})
            for i, a in pts.items():
                self.taken.append((a, a, nets[i]))

    def planned(self):
        for w in self.plan["wires"]:
            for i in range(1, len(w["points"])):
                self.taken.append((tuple(w["points"][i - 1]), tuple(w["points"][i]), w["net"]))
        for comp in self.plan["components"]:
            for p in comp["pins"]:
                self.taken.append((tuple(p["at"]), tuple(p["at"]), p["net"]))
        for x in self.plan.get("ports", []) + self.plan.get("grounds", []):
            self.taken.append((tuple(x["at"]), tuple(x["at"]), x["net"]))

    def stubs(self):
        """Each drawn pin to its planned point: an L wire, else a label on both sides."""
        self.need_label = []    # (planned point, net, text) when a stub could not be drawn
        for comp in self.plan["components"]:
            if comp["ref"] not in self.insts:
                continue
            inst, pts, _ = self.insts[comp["ref"]]
            for p in comp["pins"]:
                A, P = pts[p["index"]], tuple(p["at"])
                if same(A, P):
                    continue
                done = False
                for path in ([A, (P[0], A[1]), P], [A, (A[0], P[1]), P]):
                    path = [q for i, q in enumerate(path) if i == 0 or not same(q, path[i - 1])]
                    if self.free(path, p["net"]):
                        self.wire(path, p["net"])
                        self.stats["stubs"] += 1
                        self.stats["stub_length"] += sum(abs(path[i][0] - path[i - 1][0]) + abs(path[i][1] - path[i - 1][1]) for i in range(1, len(path)))
                        done = True
                        break
                if not done:
                    self.stats["label_fallbacks"] += 1
                    self.local.append("label fallback: %s pin %d" % (comp["ref"], p["index"]))
                    self.stub_out(inst, A, p["net"], p["label"])
                    self.need_label.append((P, p["net"], p["label"]))

    def draw(self):
        self.segs = []          # (a, b, wire object) of the planned wires
        for w in self.plan["wires"]:
            for s in self.wire(w["points"], w["net"]):
                self.segs.append((tuple(s.points[0]), tuple(s.points[1]), s))
        for lab in self.plan.get("labels", []):
            self.label_at(lab["at"], lab["net"], lab["text"], lab.get("pin"))
        for P, net, text in self.need_label:
            self.label_at(P, net, text, None)
        # bulks and other terminals the drawing does not show: by name
        for comp in self.plan["components"]:
            if comp["ref"] not in self.insts:
                continue
            inst, pts, _ = self.insts[comp["ref"]]
            for h in comp.get("hidden", []):
                if self.stub_out(inst, pts[h["index"]], h["net"], h["label"]):
                    self.stats["bulk_labels"] += 1

    def label_at(self, at, net, text, pin):
        at = tuple(at)
        for a, b, s in self.segs:
            if on_segment(at, a, b):
                self.label(s, at, text)
                return
        if pin and pin["ref"] in self.insts:
            inst, pts, _ = self.insts[pin["ref"]]
            self.stub_out(inst, pts[pin["index"]], net, text)
            return
        self.problems.append("a label has no wire to sit on")

    def symbols(self):
        g = symbol_entry(self.m, {"role": "gnd"})
        if self.plan.get("grounds"):
            mst = self.master(g["lib"], g["cell"], g["view"]) if g else None
            offs = list(self.term_offsets(mst).values()) if mst else []
            if not offs:
                self.problems.append("ground symbol not found")
            for i, r in enumerate(self.plan.get("grounds", []) if offs else []):
                t = offs[0]
                self.ws.db.create_inst(self.cv, mst, "GNDC%d" % i, [snap(r["at"][0] - t[0], self.g), snap(r["at"][1] - t[1], self.g)], "R0")
        if self.plan.get("ports"):
            pe = symbol_entry(self.m, {"role": "pin"})
            mst = self.master(pe["lib"], pe["cell"], pe["view"]) if pe else None
            offs = list(self.term_offsets(mst).values()) if mst else []
            if not offs:
                self.problems.append("pin symbol not found")
                return
            t = offs[0]
            for p in self.plan["ports"]:
                self.ws.sch.create_pin(self.cv, mst, p["name"], self.m.get("pin.direction", "inputOutput"), None,
                                       [snap(p["at"][0] - t[0], self.g), snap(p["at"][1] - t[1], self.g)], "R0")

    def check(self):
        r = self.ws.sch.check(self.cv) or [0, 0]
        self.errors, self.warnings = int(r[0] or 0), int(r[1] or 0)
        self.ws.db.save(self.cv)
        exp = self.plan["expected"]
        node_nets, net_nodes = {}, {}
        missing = 0
        for x in exp["terminals"]:
            got = self.insts.get(x["ref"])
            name = None
            if got:
                inst, _, e = got
                tname = e["terms"][x["index"]] if x["index"] < len(e["terms"]) else None
                for it in inst.inst_terms or []:
                    if it.name == tname and it.net is not None:
                        name = it.net.name
            if name is None:
                missing += 1
                self.local.append("unconnected: %s terminal %d" % (x["ref"], x["index"]))
                name = "?open:%s:%d" % (x["ref"], x["index"])
            node_nets.setdefault(x["node"], set()).add(name)
            net_nodes.setdefault(name, set()).add(x["node"])
        opens = sum(1 for s in node_nets.values() if len(s) > 1) + missing
        shorts = sum(1 for s in net_nodes.values() if len(s) > 1)
        for n, s in node_nets.items():
            if len(s) > 1:
                self.local.append("open: deck node %s on %d nets" % (n, len(s)))
        for n, s in net_nodes.items():
            if len(s) > 1:
                self.local.append("short: %s joins %s" % (n, ", ".join(sorted(s))))
        gnd_bad = sum(1 for n in exp.get("ground", []) if node_nets.get(n, set()) != {"gnd!"})
        ports_ok = sum(1 for p in exp.get("ports", []) if node_nets.get(p["node"], set()) == {p["name"]})
        refs = {c["ref"] for c in self.plan["components"]}
        names = [i.name for i in (self.cv.instances or [])]
        created = sum(1 for n in names if n in refs)
        self.result = {
            "instances_expected": len(refs), "instances_created": created,
            "nets_expected": len(node_nets), "nets_found": len(net_nodes),
            "opens": opens, "shorts": shorts, "ground_wrong": gnd_bad,
            "ports_ok": ports_ok, "ports_expected": len(exp.get("ports", [])),
            "sch_errors": self.errors, "sch_warnings": self.warnings,
            "problems": len(self.problems), "overlaps": self.overlaps(),
        }
        r = self.result
        self.ok = (created == len(refs) and opens == 0 and shorts == 0 and gnd_bad == 0
                   and ports_ok == r["ports_expected"] and self.errors == 0 and not self.problems)
        return self.ok

    def overlaps(self):
        boxes = []
        for inst, _, _ in self.insts.values():
            boxes.append(self.ws.db.transform_b_box(inst.master.b_box, inst.transform))
        n = 0
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0][0] < b[1][0] - EPS and b[0][0] < a[1][0] - EPS and a[0][1] < b[1][1] - EPS and b[0][1] < a[1][1] - EPS:
                    n += 1
        return n

    def run(self):
        self.open()
        self.place()
        self.planned()
        self.stubs()
        self.draw()
        self.symbols()
        return self.check()

    def write_profile(self, path):
        """The real terminal points of each role's symbol: stays on this machine."""
        with open(path, "w") as f:
            json.dump({"format": "cadence-profile/1", "warning": "LOCAL FILE: pin positions of your symbols (foundry kit under NDA). Never send it.", "grid": self.g, "symbols": self.profile}, f, indent=1, sort_keys=True)

    def report(self):
        r, s = self.result, self.stats
        roles = {}
        for c in self.plan["components"]:
            roles[c["role"]] = roles.get(c["role"], 0) + 1
        h = self.plan.get("id") or hashlib.sha256(json.dumps(self.plan, sort_keys=True).encode()).hexdigest()[:12]
        lines = [
            "cadence-export report (schema-neutre/1 -> Virtuoso), runtime %s" % RUNTIME_VERSION,
            "plan: %s" % h,
            "result: %s" % ("PASS" if self.ok else "FAIL"),
            "instances: expected %d, created %d" % (r["instances_expected"], r["instances_created"]),
            "nets (deck): %d, found %d" % (r["nets_expected"], r["nets_found"]),
            "opens: %d, shorts: %d, ground wrong: %d" % (r["opens"], r["shorts"], r["ground_wrong"]),
            "ports: %d/%d" % (r["ports_ok"], r["ports_expected"]),
            "schCheck: errors %d, warnings %d" % (r["sch_errors"], r["sch_warnings"]),
            "wires: segments %d, stubs %d (length %.4g), label fallbacks %d, bulk labels %d, labels %d" % (
                s["segments"], s["stubs"], s["stub_length"], s["label_fallbacks"], s["bulk_labels"], s["labels"]),
            "params: set %d, skipped %d" % (s["params_set"], s["params_skipped"]),
            "instance overlaps: %d" % r["overlaps"],
            "roles: " + ", ".join("%s %d" % kv for kv in sorted(roles.items())),
        ]
        lines += ["problem: " + p for p in sorted(set(self.problems))]
        return "\n".join(lines) + "\n"


RUNTIME_VERSION = "0.1"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draw the schematic in Virtuoso (skillbridge) and check it against the deck.")
    ap.add_argument("--lib", required=True, help="work library (must exist)")
    ap.add_argument("--cell", default=PLAN.get("cell", "schematic"))
    ap.add_argument("--map", help="local symbol map (key = value), overrides the analogLib defaults")
    ap.add_argument("--report", default="cadence-report.txt")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--direct", action="store_true", help="run from the CIW with pyRunScript")
    ap.add_argument("--write-profile", help="write the symbols' terminal points (LOCAL file, for a second exact pass)")
    ap.add_argument("--detail", action="store_true", help="print instance names of mismatches (LOCAL only)")
    a = ap.parse_args(argv)
    m = parse_map(DEFAULT_MAP)
    if a.map:
        with open(a.map) as f:
            m = parse_map(f.read(), m)
    from skillbridge import Workspace
    ws = Workspace.open(direct=a.direct) if a.direct else Workspace.open()
    ex = Export(ws, PLAN, m, a.lib, a.cell, a.overwrite)
    ex.run()
    if a.write_profile:
        ex.write_profile(a.write_profile)
    text = ex.report()
    with open(a.report, "w") as f:
        f.write(text)
    sys.stdout.write(text)
    if a.detail and ex.local:
        sys.stdout.write("--- LOCAL DETAIL: do not send ---\n" + "\n".join(ex.local) + "\n")
    return 0 if ex.ok else 1
