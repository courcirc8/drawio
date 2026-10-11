import os, pytest
from skillinterp import Interp, Symbol, SkillError

def ev(src, **kw):
    return Interp(**kw).eval_string(src)

def test_literals_and_arith():
    assert ev("1 + 2 * 3") == 7
    assert ev("7 / 2") == 3 and ev("-7 / 2") == -3 and ev("7 / 2.0") == 3.5
    assert ev("(1 + 2) * 3") == 9 and ev("-(2)") == -2 and ev("1e-6") == 1e-6 and ev(".5 + 1") == 1.5
    assert ev('"a\\"b\\n"') == 'a"b\n'
    assert ev("t") is True and ev("nil") is None and ev("'foo") == Symbol("foo")
    assert ev("3 - 1 - 1") == 1 and ev("2 * 3 / 4") == 1

def test_comparison_logic_truth():
    assert ev("1 < 2 && 3 >= 3") is True or ev("1 < 2 && 3 >= 3") == True
    assert ev("1 == 1.0") and ev('"a" == "a"') and ev("nil == nil") and not ev("1 != 1")
    assert ev("nil || 5") == 5 and ev("nil && 5") is None and ev("0 && 7") == 7
    assert ev("!nil") and ev("!0") is None
    assert ev("if(0 1 2)") == 1 and ev("if(nil 1 2)") == 2 and ev("if(nil 1)") is None

def test_assign_let_scope_and_globals():
    it = Interp()
    assert it.eval_string("x = 3 x + 1") == 4 and it.globals["x"] == 3
    assert it.eval_string("let((x (y 2)) x = 10 y = y + x y)") == 12 and it.globals["x"] == 3
    assert it.eval_string("let((z) z)") is None
    it.eval_string("a = b = 5")
    assert it.globals["a"] == 5 == it.globals["b"]
    it.eval_string("let(((q 1)) g2 = q + 1)")
    assert it.globals["g2"] == 2

def test_procedure_optional_key():
    it = Interp()
    assert it.eval_string("procedure(f(a b @optional (c 1) d) list(a b c d))") == Symbol("f")
    assert it.eval_string("f(1 2)") == [1, 2, 1, None] and it.eval_string("f(1 2 3 4)") == [1, 2, 3, 4]
    it.eval_string("procedure(g(a @key (k 2) j) list(a k j))")
    assert it.eval_string("g(1 ?j 9)") == [1, 2, 9]
    it.eval_string("procedure(fact(n) if(n <= 1 then 1 else n * fact(n - 1)))")
    assert it.eval_string("fact(6)") == 720
    it.eval_string("procedure(h(n) let(((r 0)) for(i 1 n r = r + i) r))")
    assert it.eval_string("h(4)") == 10

def test_lists():
    assert ev("list(1 2 3)") == [1, 2, 3] and ev("list()") is None and ev("cons(0 list(1))") == [0, 1]
    assert ev("car(list(1 2))") == 1 and ev("cdr(list(1))") is None and ev("cadr(list(1 2 3))") == 2 and ev("caddr(list(1 2 3))") == 3
    assert ev("nth(1 list(5 6 7))") == 6 and ev("length(nil)") == 0 and ev("length(list(1 2))") == 2
    assert ev("append(list(1) list(2 3))") == [1, 2, 3] and ev("append1(nil 4)") == [4] and ev("reverse(list(1 2))") == [2, 1]
    assert ev("member(2 list(1 2 3))") == [2, 3] and ev("member(9 list(1))") is None
    assert ev('assoc("b" list(list("a" 1) list("b" 2)))') == ["b", 2]
    assert ev("null(nil)") and ev("null(list(1))") is None and ev("listp(nil)") and ev("numberp(1.5)") and ev('stringp("x")')

def test_loops():
    assert ev("let(((s 0)) foreach(x list(1 2 3) s = s + x) s)") == 6
    assert ev("foreach(x list(1 2) x)") == [1, 2]
    assert ev("let(((i 0)) while(i < 5 i = i + 1) i)") == 5
    assert ev("setof(x list(1 2 3 4) x > 2)") == [3, 4]
    assert ev("exists(x list(1 2 3) x == 2)") == [2, 3] and ev("exists(x list(1) x == 2)") is None
    assert ev("when(t 1 2)") == 2 and ev("unless(t 1)") is None
    assert ev("cond((nil 1) (t 2 3))") == 3
    assert ev("if(t then 1 2 else 3)") == 2

def test_strings_and_numbers():
    assert ev('strcat("a" "b" "c")') == "abc" and ev('strlen("abc")') == 3
    assert ev('substring("hello" 2 3)') == "ell" and ev('substring("hello" 3)') == "llo"
    assert ev('parseString("  a b\tc ")') == ["a", "b", "c"] and ev('parseString("a=b" "=")') == ["a", "b"]
    assert ev('nindex("abc" "c")') == 3 and ev('nindex("abc" "z")') is None
    assert ev('lowerCase("AbC")') == "abc" and ev('upperCase("a")') == "A"
    assert ev('sprintf(nil "%d-%s-%g-%.3f-%L" 3 "x" 0.5 1.0 list(1 "a"))') == '3-x-0.5-1.000-(1 "a")'
    assert ev("round(2.5)") == 3 and ev("round(-2.5)") == -3 and ev("floor(2.7)") == 2 and ev("abs(-3)") == 3
    assert ev("float(1) / 2") == 0.5 and ev("fix(2.9)") == 2 and ev("min(3 1 2)") == 1 and ev("max(1 4)") == 4 and ev("mod(7 3)") == 1
    assert ev('equal(list(1 "a") list(1 "a"))') and ev('atoi("12")') == 12 and ev('atof("0.5")') == 0.5

def test_tables_and_properties():
    class O: pass
    o = O(); o.name = "M1"; o.bBox = [[0, 0], [1, 1]]
    it = Interp(functions={"getObj": lambda: o})
    assert it.eval_string("getObj()->name") == "M1"
    assert it.eval_string("car(cadr(getObj()->bBox))") == 1
    assert it.eval_string("getObj()->nothing") is None
    assert it.eval_string('tb = makeTable("t" nil) tb["k"] = 3 tb["k"] + 1') == 4
    assert it.eval_string('tb["missing"]') is None
    assert it.eval_string('d = makeTable("d" 0) d["x"]') == 0

def test_errors_and_errset():
    with pytest.raises(SkillError):
        ev("noSuchFunction(1)")
    assert ev("errset(error(\"bad %d\" 1))") is None
    assert ev("errset(1 + 1)") == [2]
    assert ev("errset(noSuch())") is None

def test_python_functions_and_kwargs():
    seen = []
    def f(*a): seen.append(a); return [len(a)]
    it = Interp(functions={"dbThing": f})
    assert it.eval_string('dbThing(1 "x" list(1 2) nil)') == [4]
    assert seen[-1] == (1, "x", [1, 2], None)
    assert it.eval_string("if(dbThing() 'yes 'no)") == Symbol("yes")
    it2 = Interp(functions={"falsy": lambda: False})
    assert it2.eval_string("if(falsy() 1 2)") == 2

def test_files_printf_gets(tmp_path):
    it = Interp()
    p = tmp_path / "out.txt"
    it.eval_string(f'port = outfile("{p}") fprintf(port "a=%d\\n" 1) fprintf(port "b\\n") close(port)')
    assert p.read_text() == "a=1\nb\n"
    n = it.eval_string(f'let((port line (n 0)) port = infile("{p}") while(gets(line port) n = n + 1) close(port) n)')
    assert n == 2
    assert it.eval_string(f'isFile("{p}")') and it.eval_string('isFile("/nonexistent/zz")') is None
    it.eval_string('printf("x %d\\n" 2) println("s")')
    assert "".join(it.output) == 'x 2\n"s"\n'

def test_comments_and_load(tmp_path):
    f = tmp_path / "a.il"
    f.write_text('; comment\n/* block\ncomment */\nprocedure(sq(x) x * x) ; tail\nzz = sq(4)\n')
    it = Interp()
    it.load(str(f))
    assert it.globals["zz"] == 16
    it.eval_string(f'load("{f}")')
    assert it.eval_string("sq(3)") == 9

def test_nested_calls_and_precedence():
    assert ev("list(1 + 2 3 * 4 (-5))") == [3, 12, -5]
    assert ev("1 + 2 < 4 && 2 * 2 == 4") == True
    assert ev("let(((l list(list(1 2) list(3 4)))) car(cadr(l)) + cadr(car(l)))") == 5
