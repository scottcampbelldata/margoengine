"""Independent owner-library AMR fixtures and yt black-box numerical oracle. No external implementation source read."""
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,str(Path('test-results/batch176/amr/python').resolve()))
sys.path.insert(0,str(Path('test-results/batch176/engineering/python').resolve()))
import numpy as np
import h5py
p=Path('packages/sciviz/tests/fixtures/amr');p.mkdir(exist_ok=True,parents=True)
rows=[]
with h5py.File(p/'enzo-fields.h5','w',libver='earliest') as f, h5py.File(p/'enzo-hierarchy.h5','w',libver='earliest') as hierarchy:
 for i,(lo,hi,full,start,end) in enumerate([([0,0,0],[1,1,1],[4]*3,[1]*3,[2]*3),([0,0,0],[.5]*3,[2]*3,[0]*3,[1]*3)],1):
  dims=np.array(end)-start+1;values=np.full(tuple(full[::-1]),-99.)
  sl=tuple(slice(start[k],end[k]+1) for k in [2,1,0]);values[sl]=np.arange(8).reshape(2,2,2)+i*10
  f.create_dataset(f'Grid{i:08}/Density',data=values,compression='gzip',shuffle=True,chunks=True)
  fields={'GridDimension':full,'GridStartIndex':start,'GridEndIndex':end,'GridLeftEdge':lo,'GridRightEdge':hi}
  rows.append(f'Grid = {i}\n'+''.join(k+' = '+' '.join(map(str,v))+'\n' for k,v in fields.items())+'BaryonFileName = enzo-fields.h5\n')
  g=hierarchy.create_group(f'Level{i-1}/Grid{i:08}');g.attrs['BaryonFileName']=np.bytes_('enzo-fields.h5')
  for k,v in fields.items():g[k]=v
(p/'enzo.hierarchy').write_text('\n'.join(rows))
# Leaves cover the left coarse octant with a refinement block; FLASH parent data are not valid for plotting.
with h5py.File(p/'flash.h5','w',libver='earliest') as f:
 f['unknown names']=np.array([b'dens'],dtype='S4').reshape(1,1)
 f['refine level']=[1,2,2];f['node type']=[0,1,1]
 f['bounding box']=np.array([[[0,1]]*3,[[0,.5]]*3,[[.5,1],[0,.5],[0,.5]]])
 f.create_dataset('dens',data=np.arange(24,dtype='>f8').reshape(3,2,2,2),compression='gzip',shuffle=True)
import yt
from importlib.metadata import version
ds=yt.load(str(p/'nyx'))
expected={'ytVersion':version('yt'),'h5pyVersion':version('h5py'),'blocks':[]}
for g in ds.index.grids:
 a=g[('boxlib','density')].to_ndarray().transpose(2,1,0).copy()
 expected['blocks'].append({'id':int(g.id),'level':int(g.Level),'dims':g.ActiveDimensions.tolist(),'bounds':np.stack([g.LeftEdge.to_ndarray(),g.RightEdge.to_ndarray()],axis=1).ravel().tolist(),'visibleCells':int(g.child_mask.sum()),'min':float(a.min()),'max':float(a.max()),'sum':float(a.sum()),'sha256':hashlib.sha256(a.astype('<f8').tobytes()).hexdigest()})
(p/'expected.json').write_text(json.dumps(expected,indent=2)+'\n')
source={'dataset':'Nyx pure hydro Sedov, nyx_sedov_plt00086','source':'https://yt-project.org/data/nyx_sedov_plt00086.tgz','catalogue':'https://yt-project.org/data/','permission':'Publisher makes these datasets publicly available for experimentation and testing. This demonstration and fixtures use that express purpose grant; no CC0 or unrestricted redistribution licence is asserted.','attribution':'Nyx collaboration, hosted by the yt Project','storageChanges':'FAB files use a .bin suffix so browser development servers serve binary bytes. Cell_H companion filenames are updated accordingly. Numeric FAB bytes and the top-level Header are unchanged.','time':0.01,'files':{str(q.relative_to(p)).replace('\\','/'):{'bytes':q.stat().st_size,'sha256':hashlib.sha256(q.read_bytes()).hexdigest()} for q in sorted(p.rglob('*')) if q.is_file() and q.name not in ['source.json']}}
(p/'source.json').write_text(json.dumps(source,indent=2)+'\n')
print('oracle blocks',len(expected['blocks']))
