"""Our inputs, written with the owning HDF5 library through h5py. No implementation source is read."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path('test-results/batch176/engineering/python').resolve()))
import h5py
import numpy as np
import gzip
import zipfile
import ctypes as C
import os

out = Path('packages/sciviz/tests/fixtures/engineering')
out.mkdir(parents=True, exist_ok=True)
for version in ['earliest', 'v108', 'v110', 'latest']:
    with h5py.File(out / f'hdf-{version}.h5', 'w', libver=version) as f:
        f.attrs['name'] = np.bytes_('engineering')
        f.attrs['scale'] = [2., 3.]
        f.attrs['utf8'] = 'mesh α'
        f['contiguous'] = np.arange(120, dtype='>f8').reshape(4, 5, 6)
        f.create_dataset('chunked', data=np.arange(120, dtype='<i4').reshape(4, 5, 6), chunks=(2, 3, 4), compression='gzip', shuffle=True)
        f.create_dataset('sparse', shape=(8, 9), chunks=(2, 3), dtype='f4', fillvalue=-7)[2:4, 3:6] = 11
        f['strings'] = np.array(['α', 'beta'], dtype=h5py.string_dtype())
        f['alias'] = h5py.SoftLink('/contiguous')
        for i in range(50):
            f.create_dataset(f'dense/member{i}', data=i)
        f.create_dataset('single', data=[1., 2., 3.], chunks=(3,), compression='gzip')
        f.create_dataset('unlimited', data=np.arange(60).reshape(10, 6), maxshape=(None, 6), chunks=(2, 3), compression='gzip')
        f.create_dataset('unlimited-last', data=np.arange(60).reshape(10, 6), maxshape=(10, None), chunks=(2, 3), compression='gzip')
        f.create_dataset('paged-fixed', data=np.arange(1500), chunks=(1,), compression='gzip')
        f.create_dataset('large-unlimited', data=np.arange(3000), maxshape=(None,), chunks=(1,), compression='gzip')
        f.create_dataset('btree2', data=np.arange(60).reshape(10, 6), maxshape=(None, None), chunks=(2, 3), compression='gzip')
with zipfile.ZipFile('test-results/batch176/flatplate.zip') as z:
    for kind in ['struct', 'tri']:
        name = next(n for n in z.namelist() if n.endswith(f'grid_{kind}_35x25_vol.cgns.gz'))
        (out / f'nasa-{kind}.cgns').write_bytes(gzip.decompress(z.read(name)))
# Execute the owning CGNS library's public conversion API, never inspect its source.
libs = Path('test-results/batch176/python/vtk.libs').resolve()
os.add_dll_directory(str(libs))
cgns = C.CDLL(str(libs / 'vtkcgns-9.7.2.dll'))
def call(name, *args):
    code = getattr(cgns, 'vtkcgns_' + name)(*args)
    if code: raise RuntimeError(name + ': ' + str(code))
for kind in ['struct', 'tri']:
    source, target = C.c_int(), C.c_int()
    call('cgio_open_file', str(out / f'nasa-{kind}.cgns').encode(), 0, 0, C.byref(source))
    call('cgio_open_file', str(out / f'nasa-{kind}-hdf.cgns').encode(), 1, 2, C.byref(target))
    call('cgio_copy_file', source, target, 1)
    call('cgio_close_file', target)
    call('cgio_close_file', source)
print(h5py.version.info)
