"""Run a generated Cadence script (Python or SKILL) on the fake Virtuoso.

    python3 run_fake.py python|skill FILE [--map M] [--report R] [--existing] [--fake-secret-pdk]
Exit code 0 when the script's own check says PASS.
"""
import runpy
import sys

import fakevirtuoso as fv


def main():
    kind, file, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    fv.reset()
    fv.register_library("work")
    if "--fake-secret-pdk" in rest:
        rest.remove("--fake-secret-pdk")
        fv.register_master("SECRETPDK", "nch_secret", {"d": (0.0, 0.375), "g": (-0.25, 0.0), "s": (0.0, -0.375), "b": (0.125, 0.0)},
                           [[-0.25, -0.375], [0.125, 0.375]])
    if "--existing" in rest:
        rest.remove("--existing")
        fv.dbOpenCellViewByType("work", "schematic", "schematic", "schematic", "w")
    opts = dict(zip(rest[::2], rest[1::2]))
    if kind == "python":
        sys.argv = [file, "--lib", "work"] + rest
        try:
            runpy.run_path(file, run_name="__main__")
        except SystemExit as e:
            if isinstance(e.code, str):
                print(e.code, file=sys.stderr)
                return 2
            return e.code or 0
        return 0
    from skillinterp import Interp
    it = Interp(functions=dict(fv.FUNCTIONS))
    it.load(file)
    call = 'cadxExport("work" ?report "%s"%s)' % (opts.get("--report", "cadence-report.txt"),
                                                ' ?map "%s"' % opts["--map"] if "--map" in opts else "")
    try:
        ok = it.eval_string(call)
    finally:
        sys.stdout.write("".join(it.output))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
