"""Fake Virtuoso database + SKILL function table (stdlib only)."""


def _snake_to_camel(s):
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


class Obj:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        camel = _snake_to_camel(name)
        try:
            return object.__getattribute__(self, camel)
        except AttributeError:
            raise AttributeError(name)


class Fig(Obj):
    def __init__(self, bBox):
        self.bBox = bBox


class Pin(Obj):
    def __init__(self, fig):
        self.fig = fig


class Term(Obj):
    def __init__(self, name, pins=None):
        self.name = name
        self.pins = pins if pins is not None else []


class Net(Obj):
    def __init__(self, name):
        self.name = name
        self.inst_terms = []


class InstTerm(Obj):
    def __init__(self, name, term, inst):
        self.name = name
        self.term = term
        self.inst = inst
        self.net = None

    def point(self):
        p = self.term.pins[0].fig.bBox
        x0, y0 = p[0]
        x1, y1 = p[1]
        cx = (x0 + x1) / 2.0
        cy = (y0 + y1) / 2.0
        return _transform_point((cx, cy), self.inst.transform)


class Wire(Obj):
    objType = "line"

    def __init__(self, points):
        self.points = points
        self.net = None


class Label(Obj):
    objType = "label"

    def __init__(self, xy, text, parent):
        self.theLabel = text
        self.xy = xy
        self.parent = parent
        self.net = None


def _orient_pt(orient, x, y):
    if orient == "R0":
        return (x, y)
    if orient == "R90":
        return (-y, x)
    if orient == "R180":
        return (-x, -y)
    if orient == "R270":
        return (y, -x)
    if orient == "MY":
        return (-x, y)
    if orient == "MX":
        return (x, -y)
    if orient == "MYR90":
        return (-y, -x)
    if orient == "MXR90":
        return (y, x)
    raise ValueError("invalid orient %r" % (orient,))


def _transform_point(pt, transform):
    origin, orient, _scale = transform
    x, y = _orient_pt(orient, pt[0], pt[1])
    return (x + origin[0], y + origin[1])


def _transform_bbox(bBox, transform):
    (x0, y0), (x1, y1) = bBox
    pts = [_transform_point((x, y), transform) for x, y in
           ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [[min(xs), min(ys)], [max(xs), max(ys)]]


class Inst(Obj):
    objType = "inst"

    def __init__(self, master, name, origin, orient):
        self.master = master
        self.name = name
        self.origin = origin
        self.orient = orient
        self.transform = [origin, orient, 1.0]
        self.inst_terms = [InstTerm(t.name, t, self) for t in master.terminals]
        self.bBox = _transform_bbox(master.bBox, self.transform)
        self.props = {}


# --------------------------------------------------------------------------
# Library
# --------------------------------------------------------------------------
_LIBS = {}
_USER_CV = {}
_MASTER_CV = {}


def _halfside_pin():
    return 1.0 / 32.0


def _make_pin(point):
    hs = _halfside_pin()
    x0, y0 = point
    fig = Fig([[x0 - hs, y0 - hs], [x0 + hs, y0 + hs]])
    return Pin(fig)


class _MasterCV(Obj):
    objType = "cellView"

    def __init__(self, lib, cell, view, terminals, bbox):
        self.libName = lib
        self.cellName = cell
        self.viewName = view
        self.terminals = terminals
        self.bBox = bbox
        self.instances = []
        self.shapes = []
        self.nets = []


def _build_master(lib, cell, terms, bbox):
    terminals = []
    for name, point in terms.items():
        t = Term(name)
        t.pins.append(_make_pin(point))
        terminals.append(t)
    cv = _MasterCV(lib, cell, "symbol", terminals, bbox)
    _MASTER_CV[(lib, cell)] = cv
    _LIBS[lib] = True


def register_master(lib, cell, terms, bbox):
    _build_master(lib, cell, dict(terms), bbox)


def register_library(name):
    _LIBS[name] = True


def _default_library():
    _build_master("analogLib", "nmos4",
                  {"D": (0.125, 0.25), "G": (-0.125, 0), "S": (0.125, -0.25),
                   "B": (0.25, 0)},
                  [[-0.125, -0.25], [0.25, 0.25]])
    _build_master("analogLib", "pmos4",
                  {"D": (0.125, -0.25), "G": (-0.125, 0), "S": (0.125, 0.25),
                   "B": (0.25, 0)},
                  [[-0.125, -0.25], [0.25, 0.25]])
    for cell in ("res", "cap", "ind"):
        _build_master("analogLib", cell,
                      {"PLUS": (0, 0.25), "MINUS": (0, -0.25)},
                      [[-0.0625, -0.25], [0.0625, 0.25]])
    for cell in ("vdc", "idc", "vsin"):
        _build_master("analogLib", cell,
                      {"PLUS": (0, 0.25), "MINUS": (0, -0.25)},
                      [[-0.125, -0.25], [0.125, 0.25]])
    _build_master("analogLib", "gnd",
                  {"gnd!": (0, 0)},
                  [[-0.0625, -0.125], [0.0625, 0]])
    _build_master("analogLib", "vdd",
                  {"vdd!": (0, 0)},
                  [[-0.0625, 0], [0.0625, 0.125]])
    for cell in ("aipin", "opin", "iopin"):
        _build_master("basic", cell,
                      {"pin": (0, 0)},
                      [[-0.0625, -0.0625], [0.0625, 0.0625]])
    _LIBS["analogLib"] = True
    _LIBS["basic"] = True


def reset():
    _LIBS.clear()
    _USER_CV.clear()
    _MASTER_CV.clear()
    _CALLS.clear()
    _default_library()


# --------------------------------------------------------------------------
# SKILL call log
# --------------------------------------------------------------------------
_CALLS = []


def _log(name, args):
    _CALLS.append((name, args))


# --------------------------------------------------------------------------
# SKILL functions
# --------------------------------------------------------------------------
class _LibMarker(Obj):
    def __init__(self, lib):
        self.libName = lib


def ddGetObj(lib, cell=None, view=None):
    if lib not in _LIBS:
        _log("ddGetObj", (lib, cell, view))
        return None
    if cell is not None:
        if (lib, cell) not in _MASTER_CV:
            _log("ddGetObj", (lib, cell, view))
            return None
        cv = _MASTER_CV[(lib, cell)]
        if view is not None and cv.viewName != view:
            _log("ddGetObj", (lib, cell, view))
            return None
    _log("ddGetObj", (lib, cell, view))
    if cell is None:
        return _LibMarker(lib)
    return _MASTER_CV.get((lib, cell))


def dbOpenCellViewByType(lib, cell, view, viewType=None, mode="r"):
    _log("dbOpenCellViewByType", (lib, cell, view, viewType, mode))
    if mode == "r":
        if lib not in _LIBS or (lib, cell) not in _USER_CV:
            if lib not in _LIBS or (lib, cell) not in _MASTER_CV:
                return None
            cv = _MASTER_CV[(lib, cell)]
            if view is not None and cv.viewName != view:
                return None
            return cv
        return _USER_CV[(lib, cell)]
    if lib not in _LIBS:
        return None
    cv = _MasterCV(lib, cell, view, [], [[0, 0], [0, 0]])
    _USER_CV[(lib, cell)] = cv
    return cv


def dbCreateInst(cv, master, name, origin, orient):
    _log("dbCreateInst", (cv, master, name, origin, orient))
    if name in [i.name for i in cv.instances]:
        return None
    try:
        _orient_pt(orient, 0, 0)
    except ValueError:
        return None
    inst = Inst(master, name, origin, orient)
    cv.instances.append(inst)
    return inst


def dbReplaceProp(obj, name, type, value):
    _log("dbReplaceProp", (obj, name, type, value))
    obj.props[name] = value
    return True


def dbTransformPoint(pt, transform):
    _log("dbTransformPoint", (pt, transform))
    return list(_transform_point(pt, transform))


def dbTransformBBox(bBox, transform):
    _log("dbTransformBBox", (bBox, transform))
    return _transform_bbox(bBox, transform)


def schCreateWire(cv, entryMode, routeMethod, points, xSpacing, ySpacing, width):
    _log("schCreateWire", (cv, entryMode, routeMethod, points, xSpacing,
                           ySpacing, width))
    wires = []
    for i in range(len(points) - 1):
        p0 = points[i]
        p1 = points[i + 1]
        if p0 == p1:
            continue
        w = Wire([list(p0), list(p1)])
        cv.shapes.append(w)
        wires.append(w)
    return wires


def schCreateWireLabel(cv, wire, xy, text, justify, orient, font, height,
                       isAbove):
    _log("schCreateWireLabel", (cv, wire, xy, text, justify, orient, font,
                                height, isAbove))
    lab = Label(xy, text, wire)
    cv.shapes.append(lab)
    return lab


def schCreatePin(cv, master, name, direction, offSheet, origin, orient):
    _log("schCreatePin", (cv, master, name, direction, offSheet, origin, orient))
    inst = Inst(master, name, origin, orient)
    cv.instances.append(inst)
    term = Term(name)
    cv.terminals.append(term)
    return inst


def dbSave(cv):
    _log("dbSave", (cv,))
    return True


def dbClose(cv):
    _log("dbClose", (cv,))
    return True


# --------------------------------------------------------------------------
# schCheck
# --------------------------------------------------------------------------
def _eq(a, b, eps=1e-6):
    return abs(a[0] - b[0]) < eps and abs(a[1] - b[1]) < eps


def _seg_contains_point(seg, pt, eps=1e-6):
    (x0, y0), (x1, y1) = seg
    cross = (pt[0] - x0) * (y1 - y0) - (pt[1] - y0) * (x1 - x0)
    if abs(cross) > eps * (1 + abs(x1 - x0) + abs(y1 - y0)):
        return False
    if (min(x0, x1) - eps <= pt[0] <= max(x0, x1) + eps and
            min(y0, y1) - eps <= pt[1] <= max(y0, y1) + eps):
        return True
    return False


def _strictly_inside(seg, pt, eps=1e-6):
    if not _seg_contains_point(seg, pt, eps):
        return False
    if _eq(pt, seg[0], eps) or _eq(pt, seg[1], eps):
        return False
    return True


def schCheck(cv):
    _log("schCheck", (cv,))
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    wires = [s for s in cv.shapes if s.objType == "line"]
    labels = [s for s in cv.shapes if s.objType == "label"]
    it_nodes = [(inst, t) for inst in cv.instances for t in inst.inst_terms]

    # 1: wire endpoint equality (shared corner)
    eq_endpoints = {}
    for i, w in enumerate(wires):
        for ep in (0, 1):
            pt = tuple(w.points[ep])
            eq_endpoints.setdefault(pt, []).append(("we", i, ep))
    for ids in eq_endpoints.values():
        for k in range(1, len(ids)):
            union(ids[0], ids[k])

    # 2: T — an endpoint of one segment strictly inside another segment
    for i in range(len(wires)):
        p0, p1 = wires[i].points
        for j in range(len(wires)):
            if i == j:
                continue
            q0, q1 = wires[j].points
            if _strictly_inside((q0, q1), p0):
                union(("we", i, 0), ("we", j, 0))
            if _strictly_inside((q0, q1), p1):
                union(("we", i, 1), ("we", j, 0))

    # a single wire segment is one conductor: its two endpoints share a net
    for i in range(len(wires)):
        union(("we", i, 0), ("we", i, 1))

    # 3: an InstTerm point equal to a wire ENDPOINT (a pin on the middle of a
    #    wire does NOT connect)
    for (inst, t) in it_nodes:
        pt = t.point()
        for i, w in enumerate(wires):
            if _eq(pt, w.points[0]):
                union(("it", id(inst), t.name), ("we", i, 0))
            if _eq(pt, w.points[1]):
                union(("it", id(inst), t.name), ("we", i, 1))

    # 4: two InstTerm points equal (abutment)
    for a in range(len(it_nodes)):
        for b in range(a + 1, len(it_nodes)):
            ia, ta = it_nodes[a]
            ib, tb = it_nodes[b]
            if _eq(ta.point(), tb.point()):
                union(("it", id(ia), ta.name), ("it", id(ib), tb.name))

    # 5: a label with its parent wire
    for k, lab in enumerate(labels):
        if lab.parent in wires:
            union(("lb", k), ("we", wires.index(lab.parent), 0))

    # 6: names (label texts; pin names; master term names ending with "!")
    pin_names = set(tn.name for tn in cv.terminals)
    raw_names = {}

    def add_name(root, name):
        raw_names.setdefault(root, set()).add(name)

    for k, lab in enumerate(labels):
        add_name(find(("lb", k)), lab.theLabel)
    for (inst, t) in it_nodes:
        root = find(("it", id(inst), t.name))
        if inst.name in pin_names:
            add_name(root, inst.name)
        if t.name.endswith("!"):
            add_name(root, t.name)

    # groups carrying the same name are merged
    name_to_roots = {}
    for root, names in raw_names.items():
        for n in names:
            name_to_roots.setdefault(n, []).append(root)
    for roots in name_to_roots.values():
        for other in roots[1:]:
            union(roots[0], other)

    group_names = {}
    for root, names in raw_names.items():
        group_names.setdefault(find(root), set()).update(names)

    # Build nets in creation order: instances in order, then wires, then labels.
    seen_groups = []
    root_members = {}

    def register(nodeid):
        r = find(nodeid)
        if r not in root_members:
            root_members[r] = []
            seen_groups.append(r)
        root_members[r].append(nodeid)

    for (inst, t) in it_nodes:
        register(("it", id(inst), t.name))
    for i, w in enumerate(wires):
        register(("we", i, 0))
        register(("we", i, 1))
    for k, lab in enumerate(labels):
        register(("lb", k))

    root_to_net = {}
    nets = []
    for root in seen_groups:
        names = group_names.get(root, set())
        if len(names) > 1:
            net = Net(sorted(names)[0])
        elif len(names) == 1:
            net = Net(next(iter(names)))
        else:
            net = Net("")
        root_to_net[root] = net
        nets.append(net)

    for (inst, t) in it_nodes:
        root = find(("it", id(inst), t.name))
        net = root_to_net[root]
        t.net = net
        net.inst_terms.append(t)

    for i, w in enumerate(wires):
        net = root_to_net[find(("we", i, 0))]
        w.net = net
        net.inst_terms.append(w)

    for k, lab in enumerate(labels):
        lab.net = root_to_net[find(("lb", k))]

    counter = 0
    for net in nets:
        if net.name == "":
            counter += 1
            net.name = "net%d" % counter

    errors = sum(1 for root in seen_groups
                 if len(group_names.get(root, set())) > 1)

    # Warnings: a wire endpoint connected to nothing else (a dead end), and an
    # InstTerm alone in its net.
    warn = 0
    for i, w in enumerate(wires):
        for ep in (0, 1):
            pt = tuple(w.points[ep])
            connected = False
            for j, wj in enumerate(wires):
                if j == i:
                    continue
                for e in (0, 1):
                    if _eq(pt, tuple(wj.points[e])):
                        connected = True
                        break
                if _strictly_inside(tuple(wj.points), pt):
                    connected = True
                    break
                if _strictly_inside(tuple(wj.points), pt):
                    connected = True
                    break
                if connected:
                    break
            if connected:
                continue
            for (inst, t) in it_nodes:
                if _eq(pt, t.point()):
                    connected = True
                    break
            if connected:
                continue
            for lab in labels:
                if _eq(pt, tuple(lab.xy)):
                    connected = True
                    break
            if not connected:
                warn += 1
    for (inst, t) in it_nodes:
        root = find(("it", id(inst), t.name))
        if len(root_members[root]) == 1:
            warn += 1

    cv.nets = [n for n in nets if n is not None]
    return [errors, warn]


FUNCTIONS = {
    "ddGetObj": ddGetObj,
    "dbOpenCellViewByType": dbOpenCellViewByType,
    "dbCreateInst": dbCreateInst,
    "dbReplaceProp": dbReplaceProp,
    "dbTransformPoint": dbTransformPoint,
    "dbTransformBBox": dbTransformBBox,
    "schCreateWire": schCreateWire,
    "schCreateWireLabel": schCreateWireLabel,
    "schCreatePin": schCreatePin,
    "schCheck": schCheck,
    "dbSave": dbSave,
    "dbClose": dbClose,
}

CALLS = _CALLS

reset()
