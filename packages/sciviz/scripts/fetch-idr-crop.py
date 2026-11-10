"""Fetch native TIFF metadata and intersecting tiles, decode with tifffile, retain a lossless IDR crop.

Requires tifffile, imagecodecs and numpy. Run from the repository root, under a hard process limit.
Only public decoder APIs are used; no library implementation source is read.
"""
import pathlib, urllib.request, io, json, hashlib
import tifffile, numpy as np
url='https://ftp.ebi.ac.uk/pub/databases/IDR/idr0096-tratwal-marrowquant/20210609-ftp-ome-tiffs/GFP11_6192_omWAT%20(20x).ome.tiff'
records=[]
class Remote(io.RawIOBase):
 def __init__(self): self.at=0; self.size=0; self.cache={}
 def seekable(self):return True
 def readable(self):return True
 def tell(self):return self.at
 def seek(self,offset,whence=0):
  self.at=offset if whence==0 else self.at+offset if whence==1 else self.size+offset
  return self.at
 def read(self,n=-1):
  if n<0:n=self.size-self.at
  if not n:return b''
  start=self.at
  # Only request exact ranges. Do not buffer the whole original image.
  key=(start,n)
  if key not in self.cache:
   req=urllib.request.Request(url,headers={'Range':f'bytes={start}-{start+n-1}'})
   with urllib.request.urlopen(req,timeout=30) as r:
    cr=r.headers.get('Content-Range');print(start,n,cr,flush=True)
    if not cr:raise RuntimeError('Range response required')
    self.size=int(cr.split('/')[-1]);b=r.read(n+1)
    if len(b)>n:raise RuntimeError('Range overflow')
   self.cache[key]=b;records.append({'offset':start,'length':len(b),'sha256':hashlib.sha256(b).hexdigest()})
  b=self.cache[key];self.at+=len(b);return b
remote=Remote()
# Prime size before tifffile seeks to EOF.
remote.read(16);remote.seek(0)
with tifffile.TiffFile(remote) as f:
 p=f.pages[0];print('PAGE',p.shape,p.compression,p.is_tiled,len(p.dataoffsets),flush=True)
 shape=p.shape; y0=p.imagelength//2;x0=p.imagewidth//2
 crop=np.zeros((256,256,3),dtype=p.dtype)
 for i,(offset,count) in enumerate(zip(p.dataoffsets,p.databytecounts)):
  # TIFF page exposes native tile/strip geometry; decode only intersecting segments.
  tw=p.tilewidth if p.is_tiled else p.imagewidth
  th=p.tilelength if p.is_tiled else p.rowsperstrip
  across=(p.imagewidth+tw-1)//tw
  down=(p.imagelength+th-1)//th
  plane=i//(across*down)
  local=i%(across*down)
  y=(local//across)*th;x=(local%across)*tw
  if y>=y0+256 or y+th<=y0 or x>=x0+256 or x+tw<=x0:continue
  remote.seek(offset);compressed=remote.read(count)
  data,indices,segment_shape=p.decode(compressed,i,jpegtables=p.jpegtables)
  tile=data.reshape(data.shape[-3:])
  ya=max(y,y0);yb=min(y+tile.shape[0],y0+256);xa=max(x,x0);xb=min(x+tile.shape[1],x0+256)
  if p.planarconfig==2:crop[ya-y0:yb-y0,xa-x0:xb-x0,plane]=tile[ya-y:yb-y,xa-x:xb-x,0]
  else:crop[ya-y0:yb-y0,xa-x0:xb-x0,:]=tile[ya-y:yb-y,xa-x:xb-x,:]
 root=pathlib.Path('packages/sciviz/tests/fixtures/astronomy')
 tifffile.imwrite(root/'idr0096-crop.ome.tiff',crop,ome=True,photometric='rgb',compression='deflate',metadata={'axes':'YXS','Name':'Tratwal et al. GFP11_6192_omWAT (20x), central 256x256 crop'})
 expected={'originalURL':url,'originalBytes':remote.size,'shape':list(shape),'cropOrigin':[y0,x0],'sum':[int(crop[:,:,c].sum()) for c in range(3)],'first':crop[0,0,:].tolist(),'ranges':records,'conversion':'tifffile '+tifffile.__version__+' native tile decode and lossless deflate crop, no rescaling'}
 (root/'idr-source.json').write_text(json.dumps(expected,indent=2)+'\n')
print('CROP',expected['sum'],flush=True)
