"""normalize-dir.py SRC DST — apply normalize.py to every PNG of SRC (our renders)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from PIL import Image
from normalize import normalize
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
n = 0
for f in sorted(os.listdir(src)):
    if f.endswith('.png') and not os.path.exists(os.path.join(dst, f)):
        im = normalize(Image.open(os.path.join(src, f)))
        if im is not None:
            im.save(os.path.join(dst, f)); n += 1
print(f'{n} normalised -> {dst}')
