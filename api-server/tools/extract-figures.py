#!/usr/bin/env python3
"""
extract-figures.py — extrait les figures des PDF de la bibliothèque.

Méthode : sur chaque page, repérer les blocs de légende (« Fig. N » / « Figure N »)
et recadrer la zone figure située AU-DESSUS de la légende, bornée par le texte
au-dessus et la largeur de colonne de la légende (mise en page IEEE : la figure
surmonte sa légende, dans la même colonne). Rendu 200 dpi.

Usage: extract-figures.py <lib_dir> <out_dir> [max_figs_par_pdf]
Sortie: <out_dir>/<papier>/fig-NN.png + manifest.json
"""
import pymupdf, os, re, sys, json

LIB, OUT = sys.argv[1], sys.argv[2]
MAXF = int(sys.argv[3]) if len(sys.argv) > 3 else 12
CAPTION = re.compile(r'^\s*(Fig(?:ure)?\.?)\s*\d+', re.I)
DPI = 200

os.makedirs(OUT, exist_ok=True)
manifest = {}

def figure_zone(page, cap, blocks):
    """Zone au-dessus de la légende `cap`, dans sa colonne, jusqu'au bloc de texte précédent."""
    x0, y0 = cap.x0, cap.y0
    x1 = cap.x1
    # demi-page ou pleine largeur ? élargir aux marges de colonne
    W = page.rect.width
    col_left = 0 if x0 < W * 0.45 else W * 0.5
    col_right = W if x1 > W * 0.55 else W * 0.5
    top = page.rect.y0
    for b in blocks:  # bloc de TEXTE le plus bas finissant au-dessus de la légende, même colonne
        bx0, by0, bx1, by1, txt = b[0], b[1], b[2], b[3], b[4]
        if by1 <= y0 - 4 and bx1 > col_left + 8 and bx0 < col_right - 8:
            if CAPTION.match(txt.strip()):   # une autre légende borne aussi
                top = max(top, by1 + 2); continue
            # ignorer les petits fragments (labels DANS la figure) : garder les paragraphes larges
            if (bx1 - bx0) > (col_right - col_left) * 0.55 and len(txt.strip()) > 80:
                top = max(top, by1 + 2)
    rect = pymupdf.Rect(col_left + 2, top, col_right - 2, y0 - 2)
    return rect if rect.height > 40 and rect.width > 60 else None

count_pdf = 0
for fn in sorted(os.listdir(LIB)):
    if not fn.endswith('.pdf'): continue
    base = fn[:-4]
    try:
        doc = pymupdf.open(os.path.join(LIB, fn))
    except Exception:
        continue
    figs = []
    try:
        for page in doc:
            if len(figs) >= MAXF: break
            blocks = page.get_text('blocks')
            caps = [pymupdf.Rect(b[:4]) for b in blocks if CAPTION.match(b[4].strip())]
            for cap in caps:
                if len(figs) >= MAXF: break
                zone = figure_zone(page, cap, blocks)
                if zone is None: continue
                pix = page.get_pixmap(clip=zone, dpi=DPI)
                if pix.width < 120 or pix.height < 80: continue
                figs.append((page.number + 1, pix))
    except Exception:
        pass
    if figs:
        d = os.path.join(OUT, base)
        os.makedirs(d, exist_ok=True)
        entries = []
        for i, (pageno, pix) in enumerate(figs, 1):
            name = f'fig-{i:02d}.png'
            pix.save(os.path.join(d, name))
            entries.append({'file': name, 'page': pageno})
        manifest[base] = entries
        count_pdf += 1
    doc.close()

json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
total = sum(len(v) for v in manifest.values())
print(f'{count_pdf} PDFs traités, {total} figures extraites')
