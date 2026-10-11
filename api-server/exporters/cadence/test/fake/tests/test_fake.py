import pytest
import fakevirtuoso as fv
from skillbridge import Workspace

@pytest.fixture(autouse=True)
def clean():
    fv.reset(); fv.register_library("work"); yield

def cv_new():
    return fv.dbOpenCellViewByType("work", "c", "schematic", "schematic", "w")

def master(cell, lib="analogLib"):
    return fv.dbOpenCellViewByType(lib, cell, "symbol", None, "r")

def test_library_and_open():
    assert fv.ddGetObj("analogLib") and fv.ddGetObj("analogLib", "nmos4") and fv.ddGetObj("work")
    assert fv.ddGetObj("nolib") is None and fv.ddGetObj("analogLib", "nope") is None
    assert fv.dbOpenCellViewByType("work", "c", "schematic", None, "r") is None
    assert fv.dbOpenCellViewByType("nolib", "c", "schematic", "schematic", "w") is None
    cv = cv_new(); assert cv.libName == "work" and cv.cell_name == "c"
    assert fv.dbOpenCellViewByType("work", "c", "schematic", None, "r") is cv
    m = master("nmos4"); assert [t.name for t in m.terminals] == ["D", "G", "S", "B"]
    assert m.terminals[0].pins[0].fig.b_box == [[0.125 - 1/32, 0.25 - 1/32], [0.125 + 1/32, 0.25 + 1/32]]

def test_orientations_and_transform():
    exp = {"R0": (1, 2), "R90": (-2, 1), "R180": (-1, -2), "R270": (2, -1), "MY": (-1, 2), "MX": (1, -2), "MYR90": (-2, -1), "MXR90": (2, 1)}
    for o, (x, y) in exp.items():
        assert fv.dbTransformPoint([1, 2], [[10, 20], o, 1.0]) == pytest.approx([10 + x, 20 + y])
    assert fv.dbTransformBBox([[0, 0], [1, 2]], [[0, 0], "R90", 1.0]) == pytest.approx([[-2, 0], [0, 1]])

def test_inst_and_props():
    cv = cv_new()
    i = fv.dbCreateInst(cv, master("nmos4"), "M1", [1, 1], "R90")
    assert i.name == "M1" and i.orient == "R90" and i.transform == [[1, 1], "R90", 1.0] and i in cv.instances
    assert [t.name for t in i.inst_terms] == ["D", "G", "S", "B"]
    assert fv.dbCreateInst(cv, master("nmos4"), "M1", [2, 2], "R0") is None
    assert fv.dbCreateInst(cv, master("nmos4"), "M2", [2, 2], "R45") is None
    assert fv.dbReplaceProp(i, "w", "string", "2u") and i.props["w"] == "2u"
    assert i.b_box == pytest.approx([[0.75, 0.875], [1.25, 1.25]])

def test_wires_one_per_segment():
    cv = cv_new()
    ws = fv.schCreateWire(cv, "draw", "full", [[0, 0], [0, 1], [0, 1], [2, 1]], 0.0625, 0.0625, 0.0)
    assert len(ws) == 2 and ws[0].points == [[0, 0], [0, 1]] and ws[1].obj_type == "line"

def test_check_resistor_divider():
    cv = cv_new()
    r1 = fv.dbCreateInst(cv, master("res"), "R1", [0, 0], "R0")      # PLUS (0,.25) MINUS (0,-.25)
    r2 = fv.dbCreateInst(cv, master("res"), "R2", [0, -1], "R0")     # PLUS (0,-.75) MINUS (0,-1.25)
    w = fv.schCreateWire(cv, "draw", "full", [[0, -0.25], [0, -0.75]], 0.0625, 0.0625, 0.0)
    fv.schCreateWireLabel(cv, w[0], [0, -0.5], "mid", "lowerCenter", "R0", "stick", 0.0625, None)
    g = fv.dbCreateInst(cv, master("gnd"), "G0", [0, -1.25], "R0")
    top = fv.schCreateWire(cv, "draw", "full", [[0, 0.25], [0, 0.5]], 0.0625, 0.0625, 0.0)
    p = fv.schCreatePin(cv, master("iopin", "basic"), "VIN", "inputOutput", None, [0, 0.5], "R0")
    err, warn = fv.schCheck(cv)
    assert (err, warn) == (0, 0)
    net = lambda inst, t: next(x for x in inst.inst_terms if x.name == t).net.name
    assert net(r1, "MINUS") == "mid" == net(r2, "PLUS")
    assert net(r2, "MINUS") == "gnd!" and net(r1, "PLUS") == "VIN"
    assert {n.name for n in cv.nets} >= {"mid", "gnd!", "VIN"}
    assert w[0].net.name == "mid" and "VIN" in [t.name for t in cv.terminals]

def test_check_pin_on_wire_middle_does_not_connect_but_T_does():
    cv = cv_new()
    fv.schCreateWire(cv, "draw", "full", [[-1, 0.25], [1, 0.25]], 0.0625, 0.0625, 0.0)   # passes over R1.PLUS
    r1 = fv.dbCreateInst(cv, master("res"), "R1", [0, 0], "R0")
    fv.schCreateWire(cv, "draw", "full", [[0, 2], [0, 1]], 0.0625, 0.0625, 0.0)
    fv.schCreateWire(cv, "draw", "full", [[-1, 1], [1, 1]], 0.0625, 0.0625, 0.0)          # T at (0,1)
    err, warn = fv.schCheck(cv)
    assert err == 0
    plus = r1.inst_terms[0]
    assert len(plus.net.inst_terms) == 1          # alone: not connected to the wire passing over it
    nets = {tuple(sorted(map(tuple, s.points))): s.net.name for s in cv.shapes if s.obj_type == "line"}
    assert nets[((0, 1), (0, 2))] == nets[((-1, 1), (1, 1))]
    assert nets[((-1, 0.25), (1, 0.25))] != nets[((-1, 1), (1, 1))]
    # warnings: 2 ends of the first wire, R1 PLUS and MINUS alone, ends (0,2), (-1,1), (1,1)
    assert warn == 7

def test_check_crossing_wires_do_not_connect_and_name_conflict_is_error():
    cv = cv_new()
    a = fv.schCreateWire(cv, "draw", "full", [[-1, 0], [1, 0]], 0.0625, 0.0625, 0.0)
    b = fv.schCreateWire(cv, "draw", "full", [[0, -1], [0, 1]], 0.0625, 0.0625, 0.0)
    fv.schCreateWireLabel(cv, a[0], [0.5, 0], "x", "lowerCenter", "R0", "stick", 0.0625, None)
    fv.schCreateWireLabel(cv, b[0], [0, 0.5], "y", "lowerCenter", "R0", "stick", 0.0625, None)
    assert fv.schCheck(cv)[0] == 0 and a[0].net.name == "x" and b[0].net.name == "y"
    fv.schCreateWireLabel(cv, a[0], [-0.5, 0], "z", "lowerCenter", "R0", "stick", 0.0625, None)
    err, _ = fv.schCheck(cv)
    assert err == 1 and a[0].net.name == "x"

def test_same_label_merges_and_unnamed_nets():
    cv = cv_new()
    a = fv.schCreateWire(cv, "draw", "full", [[0, 0], [1, 0]], 0.0625, 0.0625, 0.0)
    b = fv.schCreateWire(cv, "draw", "full", [[0, 5], [1, 5]], 0.0625, 0.0625, 0.0)
    c = fv.schCreateWire(cv, "draw", "full", [[0, 9], [1, 9]], 0.0625, 0.0625, 0.0)
    for w in (a, b):
        fv.schCreateWireLabel(cv, w[0], [0.5, w[0].points[0][1]], "s", "lowerCenter", "R0", "stick", 0.0625, None)
    fv.schCheck(cv)
    assert a[0].net is b[0].net and c[0].net.name == "net1"

def test_abutment_and_global_vdd():
    cv = cv_new()
    r1 = fv.dbCreateInst(cv, master("res"), "R1", [0, 0], "R0")
    r2 = fv.dbCreateInst(cv, master("res"), "R2", [0, 0.5], "R0")   # R2 MINUS (0,.25) = R1 PLUS
    v = fv.dbCreateInst(cv, master("vdd"), "V0", [0, 0.75], "R0")    # vdd! at R2 PLUS
    fv.schCheck(cv)
    assert r1.inst_terms[0].net is r2.inst_terms[1].net
    assert r2.inst_terms[0].net.name == "vdd!"

def test_calls_recorded_and_skillbridge_front():
    ws = Workspace.open()
    cv = ws.db.open_cell_view_by_type("work", "c", "schematic", "schematic", "w")
    m = ws.db.open_cell_view_by_type("analogLib", "cap", "symbol", None, "r")
    i = ws.db.create_inst(cv, m, "C1", [0, 0], "R0")
    assert i.inst_terms[0].term.name == "PLUS"
    ws.sch.create_wire(cv, "draw", "full", [[0, 0.25], [0, 1]], 0.0625, 0.0625, 0.0)
    assert ws.sch.check(cv) == [0, 2]
    assert ws.dd.get_obj("work") and ws.db.save(cv)
    names = [n for n, _ in ws.calls]
    assert names == ["dbOpenCellViewByType", "dbOpenCellViewByType", "dbCreateInst", "schCreateWire", "schCheck", "ddGetObj", "dbSave"]
    assert [n for n, _ in fv.CALLS][-7:] == names
    with pytest.raises(AttributeError):
        ws.db.no_such_function_xyz
    ws.close()

def test_skill_names_resolve():
    cv = cv_new()
    i = fv.dbCreateInst(cv, master("res"), "R1", [0, 0], "R0")
    assert i.instTerms is i.inst_terms and i.bBox == i.b_box and master("res").terminals[0].pins[0].fig.bBox
    fv.schCheck(cv)
    assert i.instTerms[0].net.instTerms
