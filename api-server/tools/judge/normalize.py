"""normalize.py — the SAME normalisation for published scans and our renders,
so that the DVD-trained judge sees layout, not style (Eric's condition (a)).

grayscale -> Otsu binarisation -> crop to the ink bounding box (+2 % margin)
-> fit into SIZE x SIZE on white, aspect kept -> 1-bit PNG.
PIL + numpy only (works in the RAG venv and in the system python)."""
import numpy as np
from PIL import Image

SIZE = 256


def otsu(g):
    hist = np.bincount(g.ravel(), minlength=256).astype(float)
    p = hist / hist.sum()
    omega, mu = np.cumsum(p), np.cumsum(p * np.arange(256))
    with np.errstate(divide='ignore', invalid='ignore'):
        s = (mu[-1] * omega - mu) ** 2 / (omega * (1 - omega))
    return int(np.nanargmax(s))


def strip_text(ink, frac=0.03):
    """Remove TEXT on both sides (labels, values, captions, figure numbers):
    every connected ink component whose bounding box is small next to the
    drawing (max side < frac x the larger image side) is a glyph, a dot or a
    digit, not a wire or a symbol. The judge must not learn "there is text" or
    a font (orchestrator's condition). Needs scipy; run with the system python."""
    from scipy import ndimage
    lab, n = ndimage.label(ink, structure=np.ones((3, 3)))
    if n == 0:
        return ink
    lim = frac * max(ink.shape)
    sl = ndimage.find_objects(lab)
    keep = np.zeros(n + 1, dtype=bool)
    for i, s in enumerate(sl, start=1):
        if s is not None and max(s[0].stop - s[0].start, s[1].stop - s[1].start) >= lim:
            keep[i] = True
    return keep[lab]


def normalize(img, size=SIZE, text=False):
    g = np.asarray(img.convert('L'), dtype=np.uint8)
    t = otsu(g)
    ink = g < t
    if not text:
        ink = strip_text(ink)
    ys, xs = np.nonzero(ink)
    if len(xs) == 0:
        return None
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    h, w = y1 - y0 + 1, x1 - x0 + 1
    m = int(0.02 * max(h, w)) + 1
    crop = np.ones((h + 2 * m, w + 2 * m), dtype=np.uint8) * 255
    crop[m:m + h, m:m + w] = np.where(ink[y0:y1 + 1, x0:x1 + 1], 0, 255)
    im = Image.fromarray(crop)
    s = size / max(im.size)
    # BOX average then a HIGH threshold: any ink in a block stays black — a
    # 1-px wire averaged by LANCZOS and cut at 160 vanished (only dots left)
    im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.BOX)
    out = Image.new('L', (size, size), 255)
    out.paste(im, ((size - im.size[0]) // 2, (size - im.size[1]) // 2))
    return out.point(lambda v: 0 if v < 245 else 255).convert('1')
