"""Convert the pinned NOAA measurements with the owning formats' public writer APIs.

Requires numpy, netCDF4 and vtk. Never reads third-party implementation source.
Run from the repository root. Original NOAA files are cached by prepare-sciviz-data.py.
"""
import hashlib
import json
from pathlib import Path
import netCDF4
import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk

root = Path('examples/assets/sciviz')
cache = Path('test-results/sciviz-data')
source = cache / 'uwnd.sig995.2024.nc'
original = json.loads((root / 'wind.json').read_text())
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
if sha(source) != original['sourceSHA256'][0]:
    raise ValueError('NOAA source hash differs from the frozen source')
with netCDF4.Dataset(source) as nc:
    # A compact 8-day, 5 x 5 native subset: 100 W to 90 W and 20 N to 30 N.
    lat = nc['lat'][:]
    lon = nc['lon'][:]
    yi = np.where((lat >= 20) & (lat <= 30))[0][::-1]
    xi = np.where((lon >= 260) & (lon <= 270))[0]
    values = np.asarray(nc['uwnd'][:8, yi, xi], dtype=np.float32)
    times = np.asarray(nc['time'][:8])
    time_units = nc['time'].units
    latitudes = np.asarray(lat[yi])
    longitudes = np.asarray(lon[xi]) - 360

for name, fmt in [('wind-classic.nc', 'NETCDF3_CLASSIC'), ('wind-offset.nc', 'NETCDF3_64BIT_OFFSET')]:
    with netCDF4.Dataset(root / name, 'w', format=fmt) as out:
        for key, n in [('time', None), ('lat', 5), ('lon', 5)]:
            out.createDimension(key, n)
        out.title = 'NOAA NCEP-NCAR daily mean near-surface eastward wind'
        for key, data, units in [('time', times, time_units), ('lat', latitudes, 'degrees_north'), ('lon', longitudes, 'degrees_east')]:
            v = out.createVariable(key, 'f8', (key,)); v.units = units; v[:] = data
        v = out.createVariable('uwnd', 'f4', ('time', 'lat', 'lon')); v.units = 'm/s'; v[:] = values

# VTK axes are sample indices (longitude, latitude, day). Day is explicitly not altitude.
image = vtk.vtkImageData()
image.SetDimensions(5, 5, 8)
scalars = numpy_to_vtk(values.ravel(), deep=True)
scalars.SetName('uwnd')
image.GetPointData().AddArray(scalars)
points = vtk.vtkPoints()
for z in range(8):
    for y in range(5):
        for x in range(5):
            points.InsertNextPoint(x, y, z)
structured = vtk.vtkStructuredGrid(); structured.SetDimensions(5, 5, 8); structured.SetPoints(points)
structured.GetPointData().AddArray(scalars)
grid = vtk.vtkUnstructuredGrid(); grid.SetPoints(points); grid.GetPointData().AddArray(scalars)
for z in range(7):
    for y in range(4):
        for x in range(4):
            p = (z * 5 + y) * 5 + x
            ids = vtk.vtkIdList()
            for i in [p, p + 1, p + 6, p + 5, p + 25, p + 26, p + 31, p + 30]: ids.InsertNextId(i)
            grid.InsertNextCell(vtk.VTK_HEXAHEDRON, ids)
for suffix, kind, data in [('vti', vtk.vtkXMLImageDataWriter, image), ('vts', vtk.vtkXMLStructuredGridWriter, structured), ('vtu', vtk.vtkXMLUnstructuredGridWriter, grid)]:
    w = kind(); w.SetFileName(str(root / ('wind.' + suffix))); w.SetInputData(data)
    w.SetDataModeToAppended(); w.EncodeAppendedDataOff(); w.SetCompressorTypeToZLib()
    if w.Write() != 1: raise RuntimeError('VTK writer failed')
w = vtk.vtkUnstructuredGridWriter(); w.SetFileName(str(root / 'wind.vtk')); w.SetInputData(grid)
w.SetFileVersion(51); w.SetFileTypeToBinary()
if w.Write() != 1: raise RuntimeError('legacy writer failed')
files = ['wind-classic.nc', 'wind-offset.nc', 'wind.vti', 'wind.vts', 'wind.vtu', 'wind.vtk']
manifest = {
    'source': original['source'][0] if 'source' in original else original['sources'][0],
    'sourceSHA256': sha(source), 'licence': 'US-government public domain, NOAA PSL',
    'selection': 'January 1-8 2024, 100 W to 90 W, 20 N to 30 N, native 2.5 degree samples',
    'shape': [8, 5, 5], 'axes': ['day', 'latitude', 'longitude'],
    'vtkCoordinates': 'sample indices, x=longitude index, y=latitude index, z=day index, not altitude',
    'writers': {'netCDF4': netCDF4.__version__, 'vtk': vtk.vtkVersion.GetVTKVersion()},
    'range': [float(values.min()), float(values.max())], 'first': float(values.ravel()[0]),
    'valuesSHA256': hashlib.sha256(values.astype('<f4').tobytes()).hexdigest(),
    'files': {name: sha(root / name) for name in files},
}
(root / 'formats.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
