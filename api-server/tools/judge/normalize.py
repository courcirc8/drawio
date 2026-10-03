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


def normalize(img, size=SIZE):
    g = np.asarray(img.convert('L'), dtype=np.uint8)
    t = otsu(g)
    ink = g < t
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
