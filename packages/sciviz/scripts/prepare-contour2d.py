"""Freeze reduced public climate data; no third-party code or source files are imported into the repo.
Requires Python 3.13, xarray, zarr, fsspec, aiohttp, h5netcdf and h5py.
Run from the repository root. Each network operation has a 60 second timeout.
"""
import hashlib
import json
import pathlib
import socket
import urllib.request

import numpy as np
import xarray as xr
import fsspec

socket.setdefaulttimeout(60)
root = pathlib.Path('examples/assets/sciviz/contour2d')
root.mkdir(parents=True, exist_ok=True)
sst_url = 'https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/202401/oisst-avhrr-v02r01.20240101.nc'
era_url = 'https://storage.googleapis.com/weatherbench2/datasets/era5/1959-2023_01_10-6h-64x32_equiangular_conservative.zarr'

def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()

def save(name, dataset, source, license, reduction, raw_hash=None):
    values = dataset.values
    obj = dict(x=dataset.lon.values.tolist(), y=dataset.lat.values.tolist(),
               values=[float(x) if np.isfinite(x) else None for x in values.ravel()])
    data = (json.dumps(obj, separators=(',', ':'), allow_nan=False) + '\n').encode()
    (root / (name + '.json')).write_bytes(data)
    return dict(file=name + '.json', source=source, license=license, reduction=reduction,
                sha256=hashlib.sha256(data).hexdigest(), source_sha256=raw_hash,
                units=str(dataset.attrs.get('units', '')), shape=list(values.shape))

sst_bytes = fetch(sst_url)
sst_file = pathlib.Path('test-results/batch177-oisst.nc')
sst_file.write_bytes(sst_bytes)
with xr.open_dataset(sst_file, engine='h5netcdf') as ds:
    sst = ds.sst.isel(time=0, zlev=0).sel(lat=slice(20, 55), lon=slice(280, 335)).isel(lat=slice(None, None, 12), lon=slice(None, None, 12)).load()
    sst_record = save('oisst', sst, sst_url, 'US government public domain',
                      '2024-01-01 daily mean, North Atlantic 20-55 N 280-335 E; every 12th 0.25 degree cell, no interpolation; land is null', hashlib.sha256(sst_bytes).hexdigest())

store = fsspec.get_mapper(era_url, client_kwargs={'timeout': __import__('aiohttp').ClientTimeout(total=60)})
with xr.open_zarr(store, consolidated=True, chunks=None) as ds:
    era = ds.geopotential.sel(time='2020-01-01T00:00:00', level=500).transpose('latitude', 'longitude').rename(latitude='lat', longitude='lon').load()
    era_record = save('era5', era, era_url, 'ECMWF / Copernicus Climate Change Service, CC BY 4.0',
                      '500 hPa geopotential, 2020-01-01 00 UTC; WeatherBench 2 conservative 64x32 regridding; m2 s-2 retained, no height conversion')

(root / 'source.json').write_text(json.dumps(dict(sources=[sst_record, era_record],
    attribution='Contains modified Copernicus Climate Change Service information 2020, ECMWF, via WeatherBench 2. Neither the European Commission nor ECMWF is responsible for any use of this information.',
    license_url='https://creativecommons.org/licenses/by/4.0/',
    era_reference='https://weatherbench2.readthedocs.io/en/latest/data-guide.html',
    ecmwf_license='https://apps.ecmwf.int/datasets/licences/general/'), indent=2) + '\n', encoding='utf-8')
