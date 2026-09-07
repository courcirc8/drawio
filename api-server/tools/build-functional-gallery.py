"""Build a portable before/after gallery from bench-functional.mjs output."""
import html
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
rows = json.loads((root / 'report.json').read_text())
cards = []
for row in rows:
    name = row['name']
    if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
        raise ValueError('Unsafe case name')
    before, after = row['baseline'], row['final']
    caption = (f"{row['split']} — erreurs {before['check']['errors']} → {after['check']['errors']}, "
               f"collisions de labels {before['labels']['count']} → {after['labels']['count']}")
    figures = ''.join(f'<figure><figcaption>{label}</figcaption><a href="{name}/{stage}.png">'
                      f'<img loading="lazy" src="{name}/{stage}.png" alt="{label} {name}"></a></figure>'
                      for stage, label in [('before', 'Avant'), ('after', 'Après')])
    cards.append(f'<article><h2>{html.escape(name)}</h2><p>{html.escape(caption)}</p>'
                 f'<div class="pair">{figures}</div></article>')
(root / 'index.html').write_text('''<!doctype html><html lang="fr"><meta charset="utf-8">
<title>Comparaison du flow de routage</title><style>
body{font:17px system-ui;background:#edf1f5;color:#182b3c;margin:24px}article{background:white;padding:20px;margin:20px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%;height:550px;object-fit:contain}
@media(max-width:800px){.pair{grid-template-columns:1fr}img{height:auto}}</style>
<h1>Comparaison du flow de routage</h1><p>Les erreurs non résolues sont conservées. Les collisions de labels utilisent les boîtes des cellules texte, pas une mesure exhaustive des glyphes.</p>
<a href="report.json">Journal complet</a>''' + ''.join(cards) + '</html>')
print(root / 'index.html')
