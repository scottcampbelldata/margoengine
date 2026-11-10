"""Independent black-box fixtures from published Python package APIs, no implementation source read.

PYTHONPATH must point at an environment with astropy, mrcfile, tifffile, imagecodecs and numpy.
Run from the repository root. Generated expectations are committed with their writer outputs.
"""
from pathlib import Path
import hashlib
import json
import gzip
import bz2
import numpy as np
import astropy
from astropy.io import fits
from astropy.wcs import WCS
import mrcfile
import tifffile
import imagecodecs

root = Path('packages/sciviz/tests/fixtures/astronomy')
raw = Path('packages/decoders/tests/fixtures/tiff-scientific')
root.mkdir(parents=True, exist_ok=True)
raw.mkdir(parents=True, exist_ok=True)
expect = {'versions': {'astropy': astropy.__version__, 'mrcfile': mrcfile.__version__,
                       'tifffile': tifffile.__version__, 'imagecodecs': imagecodecs.__version__}, 'tiff': {}, 'wcs': {}}

cube = np.arange(60, dtype=np.float32).reshape(3, 4, 5) / 7 - 2
hdu = fits.PrimaryHDU(cube)
hdu.header['CTYPE1'] = 'RA---TAN'
hdu.header['CTYPE2'] = 'DEC--TAN'
hdu.header['CTYPE3'] = 'FREQ'
hdu.header['CUNIT1'] = hdu.header['CUNIT2'] = 'deg'
hdu.header['CUNIT3'] = 'Hz'
for i, (p, v, d) in enumerate([(3, 42, -.1), (2, -30, .2), (1, 1e9, 1e6)], 1):
    hdu.header[f'CRPIX{i}'] = p
    hdu.header[f'CRVAL{i}'] = v
    hdu.header[f'CDELT{i}'] = d
variable = np.empty(2, dtype=object)
variable[:] = [np.array([1, 2, 3], dtype=np.int32), np.array([9], dtype=np.int32)]
columns = [fits.Column(name='flux', format='D', unit='Jy', array=[1.5, np.nan]),
           fits.Column(name='vector', format='3E', dim='(3)', array=[[1, 2, 3], [4, 5, 6]]),
           fits.Column(name='name', format='8A', array=['star', 'galaxy']),
           fits.Column(name='flag', format='L', array=[True, False]),
           fits.Column(name='bits', format='9X', array=[[1,0,0,0,0,0,0,0,1],[0,1,0,0,0,0,0,0,0]]),
           fits.Column(name='id', format='K', array=np.array([2**60+1, -2**60-1], dtype=np.int64)),
           fits.Column(name='null', format='J', null=-999, array=[-999, 42]),
           fits.Column(name='complex', format='C', array=[1+2j, 3-4j]),
           fits.Column(name='variable', format='PJ()', array=variable)]
fits.HDUList([hdu, fits.BinTableHDU.from_columns(columns)]).writeto(root/'owner.fits', overwrite=True)
integer = fits.PrimaryHDU(np.array([[-10, -999], [20, 30]], dtype=np.int16))
integer.header['BSCALE'] = 2
integer.header['BZERO'] = 100
integer.header['BLANK'] = -999
integer.writeto(root/'scaled.fits', overwrite=True)
fits.PrimaryHDU(np.array([[2**60+1,-2**60-1]], dtype=np.int64)).writeto(root/'int64.fits', overwrite=True)
for projection in ['TAN', 'SIN', 'ARC', 'STG', 'ZEA']:
    w = WCS(naxis=2)
    w.wcs.ctype = [f'RA---{projection}', f'DEC--{projection}']
    w.wcs.crpix = [10, 20]
    w.wcs.crval = [42, -30]
    w.wcs.cd = [[-.01, .002], [.003, .02]]
    points = [[9, 19], [0, 0], [30, 50]]
    expect['wcs'][projection] = {'cards': dict(w.to_header()), 'pixels': points, 'world': w.all_pix2world(points, 0).tolist()}

for dtype in [np.int8, np.int16, np.float32, np.uint16, np.float16]:
    values = (np.arange(60).reshape(3,4,5)-25).astype(dtype)
    if dtype == np.uint16: values = np.arange(60,dtype=dtype).reshape(3,4,5)+50000
    name = f'owner-{np.dtype(dtype).name}.mrc'
    with mrcfile.new(root/name, overwrite=True) as m:
        m.set_data(values)
        m.voxel_size = (1.5, 2.5, 3.5)
        m.header.origin = (10, 20, 30)
        m.header.nxstart = 2
        m.header.nystart = -1
        m.header.nzstart = 3
        m.header.cellb = (80, 90, 70)
        m.header.mapc = 2
        m.header.mapr = 1
        m.header.maps = 3
        m.update_header_stats()

for big in [False,True]:
    for endian in ['<','>']:
        for dtype in ['uint16','int16','uint32','int32','float32','float64']:
            for codec in ['lzw','deflate']:
                for tiled in [False, True]:
                    name=f'{"big" if big else "classic"}-{"le" if endian=="<" else "be"}-{dtype}-{codec}-{"tile" if tiled else "strip"}.tif'
                    base=np.arange(2*19*21).reshape(2,19,21)
                    values=(base*31+50000).astype(dtype) if dtype.startswith('u') else (base/8-50).astype(dtype)
                    predictor=3 if dtype.startswith('float') else 2
                    tifffile.imwrite(raw/name,values,bigtiff=big,byteorder=endian,photometric='minisblack',compression=codec,predictor=predictor,tile=(16,16) if tiled else None,rowsperstrip=None if tiled else 7,metadata=None)
                    expect['tiff'][name]={'dtype':dtype,'shape':list(values.shape),'sum':float(values.sum()),'first':float(values.flat[0]),'last':float(values.flat[-1])}

ome_values=(np.arange(2*3*2*19*21).reshape(2,3,2,19,21)*37+50000).astype(np.uint16)
for big in [False,True]:
    for compression in ['lzw','deflate']:
        tifffile.imwrite(root/f'owner-{big}-{compression}.ome.tiff',ome_values,ome=True,bigtiff=big,metadata={'axes':'TCZYX','PhysicalSizeX':.25,'PhysicalSizeY':.5,'PhysicalSizeZ':2.,'Channel':{'Name':['DNA','GFP','RFP']}},photometric='minisblack',compression=compression,tile=(16,16) if big else None,rowsperstrip=None if big else 7,predictor=True)

def custom_ome(mapping, uuid='urn:uuid:main'):
    return f'<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06" UUID="{uuid}"><Image ID="Image:0"><Pixels ID="Pixels:0" Type="uint16" SizeX="3" SizeY="2" SizeZ="2" SizeC="1" SizeT="1" DimensionOrder="XYZCT"><Channel ID="Channel:0" SamplesPerPixel="1"/>{mapping}</Pixels></Image></OME>'
reverse = custom_ome('<TiffData IFD="0" FirstZ="1"/><TiffData IFD="1" FirstZ="0"/>')
tifffile.imwrite(root/'reverse.ome.tiff', np.array([np.full((2,3),111),np.full((2,3),222)],dtype=np.uint16),description=reverse,metadata=None,photometric='minisblack')
mapping = '<TiffData IFD="0" FirstZ="0"><UUID FileName="main.ome.tiff">urn:uuid:main</UUID></TiffData><TiffData IFD="0" FirstZ="1"><UUID FileName="part.ome.tiff">urn:uuid:part</UUID></TiffData>'
tifffile.imwrite(root/'main.ome.tiff',np.full((2,3),111,dtype=np.uint16),description=custom_ome(mapping),metadata=None)
tifffile.imwrite(root/'part.ome.tiff',np.full((2,3),222,dtype=np.uint16),description=custom_ome(mapping,'urn:uuid:part'),metadata=None)

local = Path('test-results/batch176/astronomy')
if (local/'sdss.fits.bz2').exists():
    (root/'sdss-frame.fits.bz2').write_bytes((local/'sdss.fits.bz2').read_bytes())
    with fits.open(root/'sdss-frame.fits.bz2') as hdus:
        d=hdus[0].data
        expect['sdss']={'shape':list(d.shape),'first':float(d.flat[0]),'last':float(d.flat[-1]),'sum':float(np.sum(d,dtype=np.float64)),'world':WCS(hdus[0].header).all_pix2world([[0,0],[1000,1000]],0).tolist()}
if (local/'emd_1003.map.gz').exists():
    (root/'emd_1003.map.gz').write_bytes((local/'emd_1003.map.gz').read_bytes())
    content=gzip.decompress((root/'emd_1003.map.gz').read_bytes())
    (local/'emd_1003.map').write_bytes(content)
    with mrcfile.open(local/'emd_1003.map') as m:
        expect['emdb']={'shape':list(m.data.shape),'sum':float(np.sum(m.data,dtype=np.float64)),'first':float(m.data.flat[0]),'last':float(m.data.flat[-1]),'mode':int(m.header.mode)}

original=local/'idr-original.ome.tiff'
if original.exists() and original.stat().st_size>100000000:
    with tifffile.TiffFile(original) as f:
        print('IDR', f.series[0].shape, f.series[0].axes, f.pages[0].compression, flush=True)
        plane=f.series[0].asarray()
        # A spatial crop of the original RGB image, never a rendered thumbnail or rescaled sample.
        crop=plane[plane.shape[0]//2:plane.shape[0]//2+256,plane.shape[1]//2:plane.shape[1]//2+256,:]
        tifffile.imwrite(root/'idr0096-crop.ome.tiff',crop,ome=True,photometric='rgb',compression='deflate',metadata={'axes':'YXS','Name':'Tratwal et al. GFP11_6192_omWAT (20x), central 256x256 crop'})
        expect['idr']={'originalURL':'https://ftp.ebi.ac.uk/pub/databases/IDR/idr0096-tratwal-marrowquant/20210609-ftp-ome-tiffs/GFP11_6192_omWAT%20(20x).ome.tiff','originalSHA256':hashlib.sha256(original.read_bytes()).hexdigest(),'originalBytes':original.stat().st_size,'shape':list(plane.shape),'cropOrigin':[plane.shape[0]//2,plane.shape[1]//2],'sum':[int(crop[:,:,c].sum()) for c in range(3)],'first':crop[0,0,:].tolist()}

(root/'expected.json').write_text(json.dumps(expect,indent=2)+'\n')
(raw/'expected.json').write_text(json.dumps(expect['tiff'],indent=2)+'\n')
print('wrote',len(expect['tiff']),'TIFF fixtures',expect['versions'],flush=True)
