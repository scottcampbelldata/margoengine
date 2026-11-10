import json,struct,urllib.request,zipfile,io
from pathlib import Path
q=json.load(urllib.request.urlopen('https://zenodo.org/api/records/20091893',timeout=30));f=q['files'][0];url=f['links']['self'];size=f['size']
class Remote(io.RawIOBase):
 def __init__(self):self.pos=0;self.cache={};self.records=[]
 def seek(self,offset,whence=0):self.pos=offset if whence==0 else (self.pos if whence==1 else size)+offset;return self.pos
 def tell(self):return self.pos
 def read(self,n=-1):
  n=min(n if n>=0 else size-self.pos,size-self.pos)
  if n<=0:return b''
  key=(self.pos,n)
  for (start,length),data in self.cache.items():
   if start<=self.pos and self.pos+n<=start+length:
    self.pos+=n;return data[key[0]-start:key[0]-start+n]
  if key not in self.cache:
   req=urllib.request.Request(url,headers={'Range':f'bytes={self.pos}-{self.pos+n-1}'})
   r=urllib.request.urlopen(req,timeout=45)
   if r.status!=206:raise RuntimeError('server ignored bounded range')
   b=r.read(n+1)
   if len(b)!=n:raise RuntimeError('wrong range size')
   self.cache[key]=b;self.records.append([self.pos,n])
  self.pos+=n;return self.cache[key]
r=Remote();z=zipfile.ZipFile(r);first='plt02330';sel=[x for x in z.infolist() if x.filename.startswith(first+'/')]
start=min(x.header_offset for x in sel);end=max(x.header_offset+30+len(x.filename.encode())+len(x.extra)+x.compress_size+64 for x in sel)
if '--local' not in __import__('sys').argv:
 r.seek(start);r.read(end-start)
 out=Path('test-results/batch176/amr/osc-native');out.mkdir(exist_ok=True)
 for x in sel:
  if not x.is_dir():
   rel='/'.join(x.filename.split('/')[1:]);p=out/rel;p.parent.mkdir(exist_ok=True,parents=True);p.write_bytes(z.read(x))
else:
 out=Path('test-results/batch176/amr/osc-native')
 r.records.append([start,end-start])
import sys,hashlib,gzip
sys.path.insert(0,str(Path('test-results/batch176/amr/python').resolve()))
import yt
from importlib.metadata import version
ds=yt.load(str(out));print('fields',ds.field_list)
field=('boxlib','y_velocity')
if field not in ds.field_list:field=next(f for f in ds.field_list if f[1]=='y_velocity')
target=Path('packages/sciviz/tests/fixtures/amr/osc-cylinder');target.mkdir(parents=True,exist_ok=True)
manifest={'title':q['metadata']['title'],'author':'Mahesh Natarajan, Lawrence Berkeley National Laboratory','doi':q['metadata']['doi'],'license':'CC BY 4.0','licenseURL':'https://creativecommons.org/licenses/by/4.0/','source':url,'timestep':first,'field':list(field),'time':float(ds.current_time),'ytVersion':version('yt'),'extraction':'Native AMReX final timestep read by the public yt API. Only the y velocity scalar is retained as little-endian float64 gzip blocks, without spatial cropping or sample rescaling. The Header is retained byte for byte.','ranges':r.records,'blocks':[]}
for g in ds.index.grids:
 a=g[field].to_ndarray().transpose(2,1,0).copy();raw=a.astype('<f8').tobytes();name=f'block-{g.id}.f64.gz';compressed=gzip.compress(raw,mtime=0);(target/name).write_bytes(compressed)
 manifest['blocks'].append({'id':int(g.id),'level':int(g.Level),'dims':g.ActiveDimensions.tolist(),'bounds':[v for pair in zip(g.LeftEdge.to_ndarray().tolist(),g.RightEdge.to_ndarray().tolist())for v in pair],'visibleCells':int(g.child_mask.sum()),'file':name,'rawSHA256':hashlib.sha256(raw).hexdigest(),'sha256':hashlib.sha256(compressed).hexdigest(),'min':float(a.min()),'max':float(a.max())})
(target/'Header').write_bytes((out/'Header').read_bytes());(target/'source.json').write_text(json.dumps(manifest,indent=2)+'\n');print('blocks',len(manifest['blocks']))
