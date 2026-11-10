"""Lossless same-level block packing for the licensed AMReX demo. Never interpolates or changes scalar samples."""
from pathlib import Path
import json,gzip,hashlib,sys
sys.path.insert(0,str(Path('test-results/batch176/amr/python').resolve()))
import numpy as np
root=Path('packages/sciviz/tests/fixtures/amr/osc-cylinder').resolve()
manifest=json.loads((root/'source.json').read_text());old=manifest['blocks'];blocks=[]
for b in old:
 a=np.frombuffer(gzip.decompress((root/b['file']).read_bytes()),dtype='<f8').reshape(tuple(b['dims'][::-1]));blocks.append({'level':b['level'],'bounds':b['bounds'],'a':a,'sources':b.get('sources',[b['id']])})
for round in range(4):
 before=len(blocks)
 for axis in [0,1,2]:
  groups={}
  for b in blocks:
   key=(b['level'],)+tuple(v for k,v in enumerate(b['bounds'])if k//2!=axis)
   groups.setdefault(key,[]).append(b)
  merged=[]
  for group in groups.values():
   group.sort(key=lambda b:b['bounds'][axis*2]);out=group[0]
   for b in group[1:]:
    if out['bounds'][axis*2+1]==b['bounds'][axis*2]:
     out={'level':out['level'],'bounds':out['bounds'].copy(),'a':np.concatenate([out['a'],b['a']],axis=2-axis),'sources':out['sources']+b['sources']};out['bounds'][axis*2+1]=b['bounds'][axis*2+1]
    else:merged.append(out);out=b
   merged.append(out)
  blocks=merged
 if len(blocks)==before:break
print('packed',len(old),'into',len(blocks),'without interpolation')
manifest['nativeBlockCount']=manifest.get('nativeBlockCount',len(old));manifest['blocks']=[];manifest['extraction']+=' Adjacent same-level blocks are losslessly packed into larger rectangular blocks, with each source block ID recorded. No coarse block is upsampled.'
for i,b in enumerate(blocks):
 raw=b['a'].astype('<f8').tobytes();name=f'region-{i}.f64.gz';compressed=gzip.compress(raw,mtime=0);(root/name).write_bytes(compressed)
 manifest['blocks'].append({'id':i,'level':b['level'],'dims':list(b['a'].shape[::-1]),'bounds':b['bounds'],'sources':b['sources'],'file':name,'rawSHA256':hashlib.sha256(raw).hexdigest(),'sha256':hashlib.sha256(compressed).hexdigest(),'min':float(b['a'].min()),'max':float(b['a'].max())})
(root/'source.json').write_text(json.dumps(manifest,indent=2)+'\n')
for b in old:
 p=(root/b['file']).resolve()
 if not p.is_relative_to(root):raise RuntimeError('unsafe generated fixture path')
 if p.name not in {x['file'] for x in manifest['blocks']}:p.unlink()
