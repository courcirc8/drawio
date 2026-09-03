#!/usr/bin/env python3
"""Cycle benchmark 30 circuits : genere chaque netlist de benchmark/netlists30/
via l'API (engine=v2 + optimize), puis mesure LVS, check.py (juge independant),
beauty. Sortie : <outdir>/<name>.{xml,png} + results.json + tableau.
Usage: python3 benchmark/run30.py <outdir> [--optimize N] [--only a,b,c]
"""
import json, os, subprocess, sys, time, urllib.request

BASE = 'http://127.0.0.1:8770'
HERE = os.path.dirname(os.path.abspath(__file__))
NETS = os.path.join(HERE, 'netlists30')
CHECK = os.path.join(HERE, '..', 'tools', 'check.py')


def req(method, path, data=None, ctype='application/json', timeout=600):
    r = urllib.request.Request(BASE + path, method=method)
    if data is not None:
        if isinstance(data, (dict, list)):
            data = json.dumps(data).encode()
        elif isinstance(data, str):
            data = data.encode()
        r.data = data
        r.add_header('Content-Type', ctype)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        body = resp.read()
    try:
        return json.loads(body)
    except Exception:
        return body


def main():
    outdir = sys.argv[1]
    optimize = 8
    only = None
    if '--optimize' in sys.argv:
        optimize = int(sys.argv[sys.argv.index('--optimize') + 1])
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    os.makedirs(outdir, exist_ok=True)
    names = sorted(f[:-4] for f in os.listdir(NETS) if f.endswith('.cir'))
    if only:
        names = [n for n in names if n in only]
    results = []
    for name in names:
        cirPath = os.path.join(NETS, name + '.cir')
        cir = open(cirPath).read()
        t0 = time.time()
        row = {'name': name}
        try:
            doc = req('POST', '/documents', {})['id']
            imp = req('POST', f'/documents/{doc}/netlist/import?engine=v2&optimize={optimize}',
                      cir, 'text/plain')
            row['warnings_import'] = imp.get('warnings', [])
            xml = req('GET', f'/documents/{doc}')
            if isinstance(xml, (dict, list)):
                xml = xml.get('xml', '')
            if isinstance(xml, bytes):
                xml = xml.decode()
            xmlPath = os.path.join(outdir, name + '.xml')
            open(xmlPath, 'w').write(xml)
            png = req('GET', f'/documents/{doc}/export?format=png&scale=2')
            open(os.path.join(outdir, name + '.png'), 'wb').write(png)
            lvs = req('POST', f'/documents/{doc}/lvs', cir, 'text/plain')
            row['lvs'] = bool(lvs.get('match'))
            b = req('POST', f'/documents/{doc}/beauty', {})
            row['beauty'] = round(float(b.get('score', 0)), 1)
            chk = subprocess.run(
                [sys.executable, CHECK, xmlPath, '--netlist', cirPath, '--json'],
                capture_output=True, text=True, timeout=120)
            try:
                cj = json.loads(chk.stdout)
                viols = cj.get('violations', cj if isinstance(cj, list) else [])
                errs = [v for v in viols if v.get('severity') == 'error']
                warns = [v for v in viols if v.get('severity') != 'error']
                row['check_errors'] = len(errs)
                row['check_warnings'] = len(warns)
                hist = {}
                for v in errs:
                    hist[str(v.get('rule'))] = hist.get(str(v.get('rule')), 0) + 1
                row['error_rules'] = hist
            except Exception:
                row['check_errors'] = -1
                row['check_stderr'] = (chk.stderr or chk.stdout)[-400:]
            req('DELETE', f'/documents/{doc}')
        except Exception as e:
            row['fail'] = str(e)[:300]
        row['secs'] = round(time.time() - t0, 1)
        results.append(row)
        print(f"{name:24s} lvs={row.get('lvs')} err={row.get('check_errors')} "
              f"warn={row.get('check_warnings')} beauty={row.get('beauty')} "
              f"{row['secs']}s {('FAIL ' + row['fail']) if 'fail' in row else ''}",
              flush=True)
    json.dump(results, open(os.path.join(outdir, 'results.json'), 'w'), indent=1)
    ok = [r for r in results if 'fail' not in r]
    nerr = sum(r.get('check_errors', 0) for r in ok if r.get('check_errors', 0) > 0)
    print(f"\n== {len(ok)}/{len(results)} generes | LVS ok: "
          f"{sum(1 for r in ok if r.get('lvs'))} | erreurs check totales: {nerr} | "
          f"beauty moyen: {round(sum(r.get('beauty', 0) for r in ok)/max(1,len(ok)),1)}")
    hist = {}
    for r in ok:
        for k, v in (r.get('error_rules') or {}).items():
            hist[k] = hist.get(k, 0) + v
    print('regles en erreur:', dict(sorted(hist.items(), key=lambda kv: -kv[1])))


if __name__ == '__main__':
    main()
