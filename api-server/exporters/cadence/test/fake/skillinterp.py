"""skillinterp.py — a small interpreter for the subset of Cadence SKILL the
Cadence exporter's runtime uses (exporters/cadence/runtime/cadence_runtime.il),
so that the generated .il can run in tests on the fake Virtuoso.

C-style calls `f(a b)`, infix operators, `->` / `[]`, let / procedure
(@optional, @key), if / when / unless / cond / while / for / foreach / setof /
exists, errset / error, tables, ports. Values: nil = None, t = True, lists =
Python lists, tables = Table (dict). Scoping is lexical and strict: reading an
unbound variable is an error (catches typos the real Virtuoso would catch too).
`then` / `else` are separators, and `a -b` is a subtraction, as in SKILL.
"""
import math
import os
import re


class SkillError(Exception):
    pass


class Symbol:
    def __init__(self, name):
        self.name = name

    def __eq__(self, other):
        return isinstance(other, Symbol) and other.name == self.name

    def __hash__(self):
        return hash(("sym", self.name))

    def __repr__(self):
        return "Symbol(%r)" % self.name


class Table(dict):
    def __init__(self, default=None):
        super().__init__()
        self.default = default


class Port:
    def __init__(self, fh):
        self.fh = fh


# ---------------------------------------------------------------- lexer

TOKEN = re.compile(r"""
    (?P<ws>\s+) | (?P<com>;[^\n]*) | (?P<bcom>/\*.*?\*/)
  | (?P<num>(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)
  | (?P<str>"(?:\\.|[^"\\])*")
  | (?P<sym>'[A-Za-z_][A-Za-z0-9_]*)
  | (?P<kw>\?[A-Za-z_][A-Za-z0-9_]*)
  | (?P<name>@?[A-Za-z_][A-Za-z0-9_!]*)
  | (?P<op>->|~>|==|!=|<=|>=|&&|\|\||[-+*/<>=!()\[\]])
""", re.X | re.S)
ESC = {"n": "\n", "t": "\t", '"': '"', "\\": "\\"}


def tokenize(src):
    toks, i = [], 0
    while i < len(src):
        m = TOKEN.match(src, i)
        if not m:
            raise SkillError("syntax error near %r" % src[i:i + 20])
        kind, text = m.lastgroup, m.group()
        i = m.end()
        if kind in ("ws", "com", "bcom"):
            continue
        if kind == "num":
            toks.append(("num", float(text) if re.search(r"[.eE]", text) else int(text)))
        elif kind == "str":
            toks.append(("str", re.sub(r"\\(.)", lambda e: ESC.get(e.group(1), e.group(1)), text[1:-1])))
        elif kind == "sym":
            toks.append(("lit", Symbol(text[1:])))
        elif kind == "kw":
            toks.append(("kw", text[1:]))
        elif kind == "name":
            if text in ("then", "else"):
                toks.append(("sep", text))
            elif i < len(src) and src[i] == "(":
                toks.append(("call", text))
            else:
                toks.append(("name", text))
        else:
            toks.append(("op", text))
    toks.append(("eof", None))
    return toks


# ---------------------------------------------------------------- parser

BINARY = {"||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6}


class Parser:
    def __init__(self, toks):
        self.t, self.i = toks, 0

    def peek(self):
        return self.t[self.i]

    def take(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def expect(self, op):
        tok = self.take()
        if tok != ("op", op):
            raise SkillError("expected %r, got %r" % (op, tok))

    def program(self):
        out = []
        while self.peek()[0] != "eof":
            out.append(self.expr())
        return out

    def seq(self):
        """Expressions up to ')': call arguments, groups."""
        args, kws = [], []
        while self.peek() != ("op", ")"):
            tok = self.peek()
            if tok[0] == "eof":
                raise SkillError("missing )")
            if tok[0] == "kw":
                self.take()
                kws.append((tok[1], self.expr()))
            elif tok[0] == "sep":
                self.take()
                args.append(("sep", tok[1]))
            else:
                args.append(self.expr())
        self.expect(")")
        return args, kws

    def expr(self):
        left = self.binary(1)
        if self.peek() == ("op", "="):
            self.take()
            if left[0] not in ("var", "index", "prop"):
                raise SkillError("cannot assign to %r" % (left,))
            return ("assign", left, self.expr())
        return left

    def binary(self, level):
        left = self.unary()
        while True:
            tok = self.peek()
            if tok[0] != "op" or tok[1] not in BINARY or BINARY[tok[1]] < level:
                return left
            self.take()
            right = self.binary(BINARY[tok[1]] + 1)
            left = ("bin", tok[1], left, right)

    def unary(self):
        tok = self.peek()
        if tok == ("op", "-"):
            self.take()
            return ("neg", self.unary())
        if tok == ("op", "!"):
            self.take()
            return ("not", self.unary())
        return self.postfix(self.primary())

    def postfix(self, e):
        while True:
            tok = self.peek()
            if tok in (("op", "->"), ("op", "~>")):
                self.take()
                name = self.take()
                if name[0] not in ("name", "call"):
                    raise SkillError("property name expected")
                e = ("prop", e, name[1])
            elif tok == ("op", "["):
                self.take()
                k = self.expr()
                self.expect("]")
                e = ("index", e, k)
            else:
                return e

    def primary(self):
        tok = self.take()
        kind, v = tok
        if kind in ("num", "str", "lit"):
            return ("lit", v)
        if kind == "name":
            if v == "t":
                return ("lit", True)
            if v == "nil":
                return ("lit", None)
            return ("var", v)
        if kind == "call":
            self.expect("(")
            args, kws = self.seq()
            return ("call", v, args, kws)
        if tok == ("op", "("):
            items, _ = self.seq()
            return ("group", items)
        raise SkillError("unexpected %r" % (tok,))


# ---------------------------------------------------------------- evaluator

class Env:
    def __init__(self, names=(), parent=None):
        self.vars = {n: None for n in names}
        self.parent = parent

    def find(self, name):
        e = self
        while e is not None:
            if name in e.vars:
                return e
            e = e.parent
        return None


def truth(v):
    return v is not None and v is not False


def as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    raise SkillError("not a list: %r" % (v,))


def lst(items):
    items = list(items)
    return items if items else None


def show(v, quote=True):
    if v is None:
        return "nil"
    if v is True:
        return "t"
    if isinstance(v, str):
        return '"%s"' % v if quote else v
    if isinstance(v, list):
        return "(" + " ".join(show(x) for x in v) + ")"
    if isinstance(v, Symbol):
        return v.name
    if isinstance(v, float):
        return ("%g" % v) if v != int(v) or abs(v) >= 1e15 else "%.1f" % v
    return str(v)


def fmt(f, args):
    args = list(args)

    def one(m):
        spec, conv = m.group(1), m.group(2)
        if conv == "%":
            return "%"
        v = args.pop(0) if args else None
        if conv == "L":
            return show(v)
        if conv == "d":
            return ("%" + spec + "d") % int(v)
        if conv in "gf":
            return ("%" + spec + conv) % float(v)
        return ("%" + spec + "s") % show(v, quote=False)
    return re.sub(r"%([-0-9.]*)([dsgfL%])", one, f)


def divide(a, b):
    if isinstance(a, int) and isinstance(b, int):
        q = abs(a) // abs(b)
        return q if (a >= 0) == (b >= 0) else -q
    return a / b


def sround(x):
    return int(math.floor(abs(x) + 0.5)) * (1 if x >= 0 else -1)


def substring(s, start, n=None):
    s0 = s[start - 1:]
    return s0 if n is None else s0[:n]


def parse_string(s, seps=" \t\n"):
    return lst(t for t in re.split("[" + re.escape(seps) + "]", s) if t)


def nindex(s, t):
    i = s.find(t)
    return None if i < 0 else i + 1


def member(x, l):
    l = as_list(l)
    for i, y in enumerate(l):
        if y == x:
            return l[i:]
    return None


def assoc(k, l):
    for y in as_list(l):
        if isinstance(y, list) and y and y[0] == k:
            return y
    return None


def last(l):
    l = as_list(l)
    return l[-1:] if l else None


def tail(l, n):
    l = as_list(l)
    return lst(l[n:])


class Interp:
    SPECIAL = {"procedure", "let", "if", "when", "unless", "while", "for", "foreach", "setof", "exists",
               "cond", "errset", "error", "gets", "sort"}

    def __init__(self, functions=None):
        self.globals = {}
        self.procs = {}
        self.stack = []
        self.output = []
        self.functions = dict(functions or {})
        b = {
            "list": lambda *a: lst(a), "cons": lambda x, l: [x] + as_list(l),
            "car": lambda l: as_list(l)[0] if l else None, "cdr": lambda l: tail(l, 1),
            "cadr": lambda l: as_list(l)[1] if l and len(l) > 1 else None,
            "caddr": lambda l: as_list(l)[2] if l and len(l) > 2 else None,
            "cddr": lambda l: tail(l, 2), "nth": lambda i, l: as_list(l)[i] if i < len(as_list(l)) else None,
            "length": lambda l: len(l) if isinstance(l, (str, dict)) else len(as_list(l)),
            "append": lambda a, b: lst(as_list(a) + as_list(b)), "append1": lambda l, x: as_list(l) + [x],
            "reverse": lambda l: lst(reversed(as_list(l))), "member": member, "assoc": assoc, "last": last,
            "null": lambda x: True if x is None else None, "listp": lambda x: True if x is None or isinstance(x, list) else None,
            "stringp": lambda x: True if isinstance(x, str) else None,
            "numberp": lambda x: True if isinstance(x, (int, float)) and not isinstance(x, bool) else None,
            "fixp": lambda x: True if isinstance(x, int) and not isinstance(x, bool) else None,
            "floatp": lambda x: True if isinstance(x, float) else None,
            "abs": abs, "round": sround, "floor": lambda x: int(math.floor(x)), "float": float,
            "fix": lambda x: int(x), "sqrt": math.sqrt, "min": min, "max": max, "mod": lambda a, b: a % b,
            "equal": lambda a, b: True if a == b else None, "eq": lambda a, b: True if a is b or a == b else None,
            "strcat": lambda *a: "".join(a), "strlen": len, "substring": substring,
            "upperCase": lambda s: s.upper(), "lowerCase": lambda s: s.lower(),
            "parseString": parse_string, "nindex": nindex,
            "sprintf": lambda port, f, *a: fmt(f, a), "printf": self._printf, "println": self._println,
            "fprintf": lambda port, f, *a: port.fh.write(fmt(f, a)) and True,
            "outfile": self._outfile, "infile": self._infile, "close": lambda p: p.fh.close() or True,
            "makeTable": lambda name, default=None: Table(default),
            "isFile": lambda p: True if os.path.isfile(p) else None, "load": self.load,
            "atoi": int, "atof": float,
            "alphalessp": lambda a, b: True if str(a) < str(b) else None,
            "lessp": lambda a, b: True if a < b else None,
        }
        self.builtins = b

    # -- entry points
    def eval_string(self, src):
        v = None
        for e in Parser(tokenize(src)).program():
            v = self.eval(e, None)
        return v

    def load(self, path):
        with open(path) as f:
            self.eval_string(f.read())
        return True

    def _printf(self, f, *a):
        self.output.append(fmt(f, a))
        return True

    def _println(self, x):
        self.output.append(show(x) + "\n")
        return None

    def _outfile(self, path):
        try:
            return Port(open(path, "w"))
        except OSError:
            return None

    def _infile(self, path):
        try:
            return Port(open(path))
        except OSError:
            return None

    # -- variables
    def get(self, name, env):
        e = env.find(name) if env else None
        if e is not None:
            return e.vars[name]
        if name in self.globals:
            return self.globals[name]
        raise SkillError("unbound variable: %s" % name)

    def set(self, name, value, env):
        e = env.find(name) if env else None
        if e is not None:
            e.vars[name] = value
        else:
            self.globals[name] = value
        return value

    def body(self, items, env):
        v = None
        for e in items:
            v = self.eval(e, env)
        return v

    # -- evaluation
    def eval(self, node, env):
        k = node[0]
        if k == "lit":
            return node[1]
        if k == "var":
            return self.get(node[1], env)
        if k == "group":
            return self.body(node[1], env)
        if k == "neg":
            return -self.eval(node[1], env)
        if k == "not":
            return None if truth(self.eval(node[1], env)) else True
        if k == "prop":
            obj = self.eval(node[1], env)
            if obj is None:
                return None
            if isinstance(obj, dict):
                return obj.get(node[2])
            if isinstance(obj, list):
                return lst(getattr(x, node[2], None) for x in obj)
            return getattr(obj, node[2], None)
        if k == "index":
            obj, key = self.eval(node[1], env), self.eval(node[2], env)
            if not isinstance(obj, dict):
                raise SkillError("not a table: %r" % (obj,))
            return obj.get(key, obj.default if isinstance(obj, Table) else None)
        if k == "assign":
            v = self.eval(node[2], env)
            t = node[1]
            if t[0] == "var":
                return self.set(t[1], v, env)
            obj = self.eval(t[1], env)
            if t[0] == "index":
                obj[self.eval(t[2], env)] = v
            else:
                setattr(obj, t[2], v)
            return v
        if k == "bin":
            return self.binop(node, env)
        if k == "call":
            return self.call(node, env)
        if k == "sep":
            raise SkillError("misplaced %s" % node[1])
        raise SkillError("cannot evaluate %r" % (node,))

    def binop(self, node, env):
        op = node[1]
        a = self.eval(node[2], env)
        if op == "&&":
            return self.eval(node[3], env) if truth(a) else None
        if op == "||":
            return a if truth(a) else (lambda b: b if truth(b) else None)(self.eval(node[3], env))
        b = self.eval(node[3], env)
        if op == "==":
            return True if a == b else None
        if op == "!=":
            return None if a == b else True
        if a is None or b is None:
            raise SkillError("nil operand for %s" % op)
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return divide(a, b)
        return True if {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op] else None

    def call(self, node, env):
        _, name, args, kws = node
        if name in self.SPECIAL:
            return getattr(self, "sf_" + name)(args, kws, env)
        vals = [self.eval(a, env) for a in args]
        kv = {key: self.eval(e, env) for key, e in kws}
        if name in self.procs:
            return self.procs[name](vals, kv)
        if name in self.functions:
            return self.functions[name](*vals, **kv)
        if name in self.builtins:
            return self.builtins[name](*vals, **kv)
        raise SkillError("undefined function: %s" % name)

    # -- special forms
    def sf_procedure(self, args, kws, env):
        sig = args[0]
        if sig[0] != "call":
            raise SkillError("procedure: bad signature")
        name, formals = sig[1], sig[2]
        req, opt, key, mode = [], [], [], "req"
        for f in formals:
            if f[0] == "var" and f[1] in ("@optional", "@key"):
                mode = f[1][1:]
                continue
            if f[0] == "var":
                spec = (f[1], None)
            elif f[0] == "group" and f[1] and f[1][0][0] == "var":
                spec = (f[1][0][1], f[1][1] if len(f[1]) > 1 else None)
            else:
                raise SkillError("procedure %s: bad formal" % name)
            {"req": req, "optional": opt, "key": key}[mode].append(spec)
        body = args[1:]

        def run(vals, kv):
            if len(vals) < len(req) or len(vals) > len(req) + len(opt):
                raise SkillError("%s: wrong number of arguments" % name)
            e = Env(parent=None)
            for (n, _), v in zip(req, vals):
                e.vars[n] = v
            for i, (n, d) in enumerate(opt):
                e.vars[n] = vals[len(req) + i] if len(req) + i < len(vals) else (self.eval(d, e) if d else None)
            for n, d in key:
                e.vars[n] = kv.pop(n) if n in kv else (self.eval(d, e) if d else None)
            if kv:
                raise SkillError("%s: unknown keyword %s" % (name, ", ".join(kv)))
            self.stack.append(name)
            try:
                return self.body(body, e)
            except Exception as x:
                if not getattr(x, "skill_stack", None):
                    x.skill_stack = list(self.stack)
                raise
            finally:
                self.stack.pop()
        self.procs[name] = run
        return Symbol(name)

    def sf_let(self, args, kws, env):
        spec = args[0]
        items = spec[1] if spec[0] == "group" else [spec]
        e = Env(parent=env)
        for b in items:
            if b[0] == "var":
                e.vars[b[1]] = None
            elif b[0] == "group" and b[1] and b[1][0][0] == "var":
                e.vars[b[1][0][1]] = self.eval(b[1][1], env) if len(b[1]) > 1 else None
            else:
                raise SkillError("let: bad binding")
        return self.body(args[1:], e)

    def sf_if(self, args, kws, env):
        if any(a[0] == "sep" for a in args):
            c, rest = args[0], args[1:]
            thens, elses, cur = [], [], None
            for a in rest:
                if a == ("sep", "then"):
                    cur = thens
                elif a == ("sep", "else"):
                    cur = elses
                elif cur is None:
                    raise SkillError("if: expression before then")
                else:
                    cur.append(a)
            return self.body(thens if truth(self.eval(c, env)) else elses, env)
        if len(args) not in (2, 3):
            raise SkillError("if: 2 or 3 arguments")
        if truth(self.eval(args[0], env)):
            return self.eval(args[1], env)
        return self.eval(args[2], env) if len(args) == 3 else None

    def sf_when(self, args, kws, env):
        return self.body(args[1:], env) if truth(self.eval(args[0], env)) else None

    def sf_unless(self, args, kws, env):
        return None if truth(self.eval(args[0], env)) else self.body(args[1:], env)

    def sf_while(self, args, kws, env):
        while truth(self.eval(args[0], env)):
            self.body(args[1:], env)
        return True

    def _loopvar(self, node):
        if node[0] != "var":
            raise SkillError("loop variable expected")
        return node[1]

    def sf_for(self, args, kws, env):
        n = self._loopvar(args[0])
        lo, hi = self.eval(args[1], env), self.eval(args[2], env)
        e = Env([n], env)
        i = lo
        while i <= hi:
            e.vars[n] = i
            self.body(args[3:], e)
            i += 1
        return True

    def _items(self, v):
        if isinstance(v, dict):
            return list(v.keys())
        return as_list(v)

    def sf_foreach(self, args, kws, env):
        n = self._loopvar(args[0])
        seq = self.eval(args[1], env)
        e = Env([n], env)
        for x in self._items(seq):
            e.vars[n] = x
            self.body(args[2:], e)
        return seq

    def sf_setof(self, args, kws, env):
        n = self._loopvar(args[0])
        e = Env([n], env)
        out = []
        for x in self._items(self.eval(args[1], env)):
            e.vars[n] = x
            if truth(self.eval(args[2], e)):
                out.append(x)
        return lst(out)

    def sf_exists(self, args, kws, env):
        n = self._loopvar(args[0])
        e = Env([n], env)
        l = self._items(self.eval(args[1], env))
        for i, x in enumerate(l):
            e.vars[n] = x
            if truth(self.eval(args[2], e)):
                return l[i:]
        return None

    def sf_cond(self, args, kws, env):
        for clause in args:
            if clause[0] != "group" or not clause[1]:
                raise SkillError("cond: bad clause")
            if truth(self.eval(clause[1][0], env)):
                return self.body(clause[1][1:], env) if len(clause[1]) > 1 else True
        return None

    def sf_errset(self, args, kws, env):
        try:
            return [self.eval(args[0], env)]
        except Exception:
            return None

    def sf_error(self, args, kws, env):
        vals = [self.eval(a, env) for a in args]
        raise SkillError(fmt(vals[0], vals[1:]))

    def sf_gets(self, args, kws, env):
        n = self._loopvar(args[0])
        port = self.eval(args[1], env)
        line = port.fh.readline()
        self.set(n, line or None, env)
        return line or None

    def sf_sort(self, args, kws, env):
        l = as_list(self.eval(args[0], env))
        f = self.eval(args[1], env)
        name = f.name if isinstance(f, Symbol) else None
        if name not in ("alphalessp", "lessp"):
            raise SkillError("sort: only 'alphalessp and 'lessp")
        return lst(sorted(l, key=str if name == "alphalessp" else None))
