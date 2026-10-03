"""build-pub.py — published side of the judge dataset: readable schematics of
the IEEE DVDs ONLY (figures.origine dvd-2001/dvd-2008, lectures.readable),
cropped by the RAG tool (one render at a time), normalised (normalize.py),
written to /AI/datasets/judge/pub/<n>.png + index.jsonl. Station only, never
committed. Run with the RAG venv:
  ~/ClaudeCode/local_AI/rag/.venv/bin/python tools/judge/build-pub.py [--limit N]"""
import json, os, sqlite3, sys
sys.path.insert(0, os.path.expanduser('~/ClaudeCode/local_AI/rag'))
sys.path.insert(0, os.path.dirname(__file__))
from rag.extract.figures import recadrer   # noqa: E402
from normalize import normalize            # noqa: E402

OUT = '/AI/datasets/judge/pub'
limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None
db = sqlite3.connect('file:/AI/datasets/IEEE/derived/figures.sqlite?mode=ro', uri=True)
rows = db.execute("""SELECT f.paper_id, f.page, f.rang, f.type FROM lectures l JOIN figures f USING (paper_id, page, rang)
  WHERE l.erreur IS NULL AND f.origine IN ('dvd-2001','dvd-2008') AND json_extract(l.lecture,'$.readable')=1
  ORDER BY f.paper_id, f.page, f.rang""").fetchall()
done = set()
idx_path = os.path.join(OUT, 'index.jsonl')
if os.path.exists(idx_path):
    done = {json.loads(l)['key'] for l in open(idx_path)}
n, ok = len(done), 0
with open(idx_path, 'a') as idx:
    for pid, page, rang, typ in rows[:limit]:
        key = f'{pid}|{page}|{rang}'
        if key in done:
            continue
        try:
            im = normalize(recadrer(pid, page, rang, dpi=150))
        except Exception:
            continue
        if im is None:
            continue
        n += 1
        im.save(os.path.join(OUT, f'{n}.png'))
        idx.write(json.dumps({'n': n, 'key': key, 'type': typ}) + '\n')
        ok += 1
print(f'{ok} new published images ({n} total) -> {OUT}')
