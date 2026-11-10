"""NASA TMR flat-plate solution, sampled nodes extruded as a span-invariant tetrahedral field.
No solver or triangulation code is copied. This is an offline demo preparation, not a file reader API.
Run from repository root: python scripts/prepare-sciviz-tetvolume.py. Download deadline: 60 seconds.
"""
import array
import hashlib
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

source = 'https://www.nasa.gov/wp-content/uploads/2025/11/mut-contours-cfl3d-dat.zip'
cache = pathlib.Path('private/batch173/job6')
cache.mkdir(parents=True, exist_ok=True)
archive = cache / 'flatplate.zip'
if not archive.exists():
    archive.write_bytes(urllib.request.urlopen(source, timeout=60).read())
original = archive.read_bytes()
text = zipfile.ZipFile(io.BytesIO(original)).read('mut_contours_cfl3d.dat').decode()
assert 'I=544, J=384, K=1' in text and 'DATAPACKING=BLOCK' in text
numbers = list(map(float, text[text.index('DT='):].split(')', 1)[1].split()))
count = 544 * 384
assert len(numbers) == count * 3
x, y, scalar = [numbers[a*count:(a+1)*count] for a in range(3)]
ix = [i for i in range(0, 544, 16) if x[i] >= 0] + [543]
iy = list(range(0, 289, 8))
nx, ny = len(ix), len(iy)
points, values, cells = [], [], []
for span in [-.25, .25]:
    for j in iy:
        for i in ix:
            k = i + 544*j
            points.extend([x[k], span, y[k]*12])
            values.append(scalar[k])
# Six monotone paths from the low to the high corner form a conforming cube decomposition.
for j in range(ny-1):
    for i in range(nx-1):
        for permutation in [(0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)]:
            bits = [0, 0, 0]
            ids = [i+nx*j]
            for axis in permutation:
                bits[axis] = 1
                ids.append(i+bits[0]+nx*(j+bits[1]+ny*bits[2]))
            cells.extend(ids)
out = pathlib.Path('examples/assets/sciviz')
hashes = {}
for name, items, kind in [('points', points, 'f'), ('values', values, 'f'), ('cells', cells, 'I')]:
    packed = array.array(kind, items)
    assert packed.itemsize == 4
    if sys.byteorder != 'little':
        packed.byteswap()
    data = packed.tobytes()
    (out / ('tmr-tet-' + name + '.bin')).write_bytes(data)
    hashes[name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
metadata = dict(title='NASA TMR CFL3D SA flat-plate eddy viscosity', source=source,
                reference='https://tmbwg.github.io/turbmodels/flatplate_sa.html',
                license='US Federal Government public-domain NASA data; modified demo, no endorsement.',
                originalSHA256=hashlib.sha256(original).hexdigest(), nodes=len(values), cells=len(cells)//4,
                dimensions=[nx, ny, 2], hashes=hashes,
                processing='Original cell-centre solution samples treated as reconstruction nodes. X stride 16 downstream of X=0, height stride 8 through row 288, last X column retained. Height exaggerated 12x and a span-invariant field extruded from -0.25 to 0.25. Six conforming tetrahedra per sampled quad prism; scalar values unchanged. This is a 2D solution extruded for display, not a 3D CFD computation.')
(out / 'tmr-tet.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(metadata['nodes'], 'nodes,', metadata['cells'], 'tetrahedra,', sum(v['bytes'] for v in hashes.values()), 'bytes')
