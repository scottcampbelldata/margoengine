"""Native OpenNeuro DWI crop and independent NumPy least-squares/eigh oracle. No external implementation source read."""
from pathlib import Path
import sys,json,gzip,hashlib
sys.path.insert(0,str(Path('test-results/batch176/tensor/python').resolve()))
import nibabel as nib,numpy as np
from importlib.metadata import version
src=Path('test-results/batch176/tensor/source');out=Path('packages/sciviz/tests/fixtures/tensor');out.mkdir(exist_ok=True,parents=True)
im=nib.load(src/'sub-10159_dwi.nii.gz');start=np.array([32,32,24]);end=start+[32,32,8];data=np.asanyarray(im.dataobj)[32:64,32:64,24:32,:].copy().astype('<f4')
affine=im.affine.copy();affine[:3,3]=nib.affines.apply_affine(im.affine,start)
header=im.header.copy();header.set_data_dtype(np.float32);crop=nib.Nifti1Image(data,affine,header);nib.save(crop,out/'dwi-crop.nii.gz')
for ext in ['bval','bvec']:(out/f'dwi.{ext}').write_bytes((src/f'sub-10159_dwi.{ext}').read_bytes())
b=np.loadtxt(out/'dwi.bval');g=np.loadtxt(out/'dwi.bvec').T;norm=np.linalg.norm(g,axis=1);g[b>0]/=norm[b>0,None];g[b==0]=0
x=np.column_stack([np.ones(len(b)),-b*g[:,0]**2,-b*g[:,1]**2,-b*g[:,2]**2,-2*b*g[:,0]*g[:,1],-2*b*g[:,0]*g[:,2],-2*b*g[:,1]*g[:,2]])
y=np.log(np.maximum(1,data.transpose(3,2,1,0).reshape(len(b),-1).astype(np.float64)))
beta=np.linalg.lstsq(x,y,rcond=None)[0];t=beta[1:].T.copy();pred=x@beta;rms=np.sqrt(((pred-y)**2).mean(axis=0));baseline=np.exp(beta[0]);mat=np.empty((len(t),3,3))
for i in range(3):mat[:,i,i]=t[:,i]
mat[:,0,1]=mat[:,1,0]=t[:,3];mat[:,0,2]=mat[:,2,0]=t[:,4];mat[:,1,2]=mat[:,2,1]=t[:,5]
eig,vec=np.linalg.eigh(mat);fa=np.sqrt(1.5*((eig-eig.mean(axis=1)[:,None])**2).sum(axis=1)/(eig*eig).sum(axis=1))
for name,a in [('tensors',t),('baseline',baseline),('residual',rms),('eigenvalues',eig[:,::-1]),('fa',fa)]:
 (out/f'{name}.f64.gz').write_bytes(gzip.compress(a.astype('<f8').tobytes(),mtime=0))
manifest={'title':'UCLA Consortium for Neuropsychiatric Phenomics LA5c Study, subject 10159 DWI','doi':'10.18112/openneuro.ds000030.v1.0.0','source':'https://s3.amazonaws.com/openneuro.org/ds000030/sub-10159/dwi/','license':'CC0','licenseURL':'https://creativecommons.org/publicdomain/zero/1.0/','datasetDescription':'https://s3.amazonaws.com/openneuro.org/ds000030/dataset_description.json','dimensions':list(data.shape),'cropStart':start.tolist(),'cropEndExclusive':end.tolist(),'sourceAffine':im.affine.tolist(),'cropAffine':affine.tolist(),'method':'Ordinary linear least squares of log S = log S0 - b g^T D g, unconstrained, minSignal=1. No eddy-current or motion correction. Gradient basis is the supplied FSL voxel basis. Negative eigenvalues retained in the reference.','oracle':{'numpy':version('numpy'),'nibabel':version('nibabel'),'leastSquares':'numpy.linalg.lstsq, rcond=None','eigen':'numpy.linalg.eigh'},'sourceHashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in src.iterdir()if p.is_file()},'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest()for p in out.iterdir()if p.is_file()and p.name!='source.json'}}
(out/'source.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n');print('crop',data.shape,'signal',data.min(),data.max(),'positive tensors',int((eig[:,0]>0).sum()),'FA',np.quantile(fa,[0,.5,.9,1]))
