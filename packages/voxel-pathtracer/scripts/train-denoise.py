"""Clean-room guide-aware network training. No downloaded weights or training data.

Research: Bako et al. 2017, https://jannovak.info/publications/KPCN/index.html;
Vogels et al. 2018, https://la.disneyresearch.com/publication/denoising-with-kpal/.
The model shares a 10->16->8->1 MLP across nine neighbours, then normalizes the
scores to a positive reconstruction kernel. Training and validation patches use independent seeds.
"""
import json
from pathlib import Path
import numpy as np

def data(seed,n):
 r=np.random.default_rng(seed)
 xy=np.array([[x,y] for y in [-1,0,1] for x in [-1,0,1]],dtype=np.float32)
 angle=r.uniform(0,2*np.pi,(n,1));axis=np.concatenate([np.cos(angle),np.sin(angle)],axis=1)
 side=(axis@xy.T>r.uniform(-1.5,1.5,(n,1)))[:,:,None]
 a0=r.uniform(.02,1,(n,1,3));a1=r.uniform(.02,1,(n,1,3))
 albedo=np.where(side,a1,a0)
 normal0=r.normal(size=(n,1,3));normal0/=np.linalg.norm(normal0,axis=2,keepdims=True)
 normal1=r.normal(size=(n,1,3));normal1/=np.linalg.norm(normal1,axis=2,keepdims=True)
 normals=np.where(side,normal1,normal0)
 family=r.integers(0,5,(n,1,1))
 albedo=np.where(family==1,np.repeat(a0,9,axis=1),albedo)
 normals=np.where((family==1)|(family==2),np.repeat(normal0,9,axis=1),normals)
 strength=np.exp(r.uniform(-3,3,(n,1,1)))
 gradient=np.clip(1+(axis@xy.T)[:,:,None]*r.uniform(-.15,.15,(n,1,1)),.1,3)
 illumination=np.where((family==1)&side,r.uniform(.05,.4,(n,1,1)),1)*gradient
 clean=albedo*strength*illumination
 hot=np.exp(-np.sum((xy[None]-r.uniform(-1,1,(n,1,2)))**2,axis=2,keepdims=True)/r.uniform(.05,2,(n,1,1)))
 clean+=np.where(family==3,hot*strength,0)
 spp=r.choice([1,2,4,8,16,32,64],(n,1,1))
 # Monte Carlo variance depends on the integrand as well as sample count.
 # Cover low-variance area-light/MIS pixels and high-variance paths at the same spp.
 noise_power=np.exp(r.uniform(-8,0,(n,1,1)))
 shape=spp/noise_power
 noisy=r.gamma(shape,1/shape,(n,9,3))*clean
 alpha=np.ones((n,9,1));alpha=np.where((family==4)&side,0,alpha);clean*=alpha;noisy*=alpha
 scale=np.maximum(np.mean(noisy[:,4:5],axis=2,keepdims=True),.01)
 noisy=(noisy/scale).astype(np.float32);target=(clean[:,4]/scale[:,0]).astype(np.float32)
 center=noisy[:,4:5];lum=np.mean(noisy,axis=2,keepdims=True);clum=lum[:,4:5]
 variance=np.mean((noisy-center)**2,axis=(1,2),keepdims=True)
 features=np.concatenate([
  np.broadcast_to((np.sum(xy*xy,axis=1)/2)[None,:,None],(n,9,1)),
  np.log1p(np.mean((noisy-center)**2,axis=2,keepdims=True)/(1+clum*clum)),
  np.mean((albedo-albedo[:,4:5])**2,axis=2,keepdims=True),
  np.clip(1-np.sum(normals*normals[:,4:5],axis=2,keepdims=True),0,2),
  np.broadcast_to(np.log1p(variance/(1+clum*clum)),(n,9,1)),
  np.broadcast_to(clum/(1+clum),(n,9,1)),lum/(1+lum),
  np.abs(alpha-alpha[:,4:5]),np.broadcast_to(1/np.sqrt(spp),(n,9,1)),
  np.broadcast_to(r.choice([.25,.5,1.],(n,1,1)),(n,9,1))
 ],axis=2).astype(np.float32)
 return features,noisy,target,(1/np.maximum(noise_power[:,0,0],.001)).astype(np.float32)

def main():
 import argparse
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output',type=Path,default=Path('test-results/denoise-ml-training'))
 options=parser.parse_args();options.output.mkdir(parents=True,exist_ok=True)

 r=np.random.default_rng(24304)
 train=data(24301,24000);validation=data(24302,4000)
 shapes=[(10,16),(16,),(16,8),(8,),(8,1),(1,)]
 params=[(r.normal(0,.15,shape) if len(shape)==2 else np.zeros(shape)).astype(np.float32) for shape in shapes]
 moment=[np.zeros_like(x) for x in params];second=[np.zeros_like(x) for x in params]
 def forward(x,noisy):
  a=x@params[0]+params[1];h=np.maximum(a,0)
  b=h@params[2]+params[3];j=np.maximum(b,0)
  score=(j@params[4]+params[5])[:,:,0];score-=score.max(axis=1,keepdims=True)
  weight=np.exp(score);weight/=weight.sum(axis=1,keepdims=True)
  prediction=np.sum(weight[:,:,None]*noisy,axis=1)
  return prediction,(a,h,b,j,weight)
 def metrics(dataset):
  x,noisy,target,_=dataset;pred,_=forward(x,noisy)
  return {'rawMSE':float(np.mean((noisy[:,4]-target)**2)), 'networkMSE':float(np.mean((pred-target)**2))}
 before=metrics(validation)
 for step in range(1,801):
  ids=r.integers(0,len(train[0]),256);x,noisy,target,importance=[v[ids] for v in train]
  prediction,(a,h,b,j,weight)=forward(x,noisy)
  # HDR-normalized MSE. Positive normalized weights bound output by observed radiance.
  error=(prediction-target)*(importance/importance.mean())[:,None]*(2/(len(ids)*3))
  ds=weight*np.sum(error[:,None,:]*(noisy-prediction[:,None,:]),axis=2)
  dj=ds[:,:,None]@params[4].T;db=dj*(b>0)
  dh=db@params[2].T;da=dh*(a>0)
  gradients=[np.einsum('bni,bnj->ij',x,da),da.sum(axis=(0,1)),
             np.einsum('bni,bnj->ij',h,db),db.sum(axis=(0,1)),
             np.einsum('bni,bnj->ij',j,ds[:,:,None]),ds.sum(keepdims=True).reshape(1)]
  rate=.003 if step>400 else .01
  for i,g in enumerate(gradients):
   moment[i]=.9*moment[i]+.1*g;second[i]=.999*second[i]+.001*g*g
   params[i]-=rate*(moment[i]/(1-.9**step))/(np.sqrt(second[i]/(1-.999**step))+1e-8)
  if step%200==0:print(step,json.dumps(metrics(validation)),flush=True)
 after=metrics(validation)
 report={'architecture':[10,16,8,1],'trainingSeed':24301,'validationSeed':24302,'trainingPatches':24000,'validationPatches':4000,'steps':800,'noisePowerLogRange':[-8,0],'loss':'variance-balanced normalized MSE, 0.001 floor','before':before,'after':after,'weights':[p.ravel().tolist() for p in params]}
 report['numpyVersion']=np.__version__
 (options.output/'model.json').write_text(json.dumps(report,separators=(',',':'))+'\n')
 flat=[weight for layer in report['weights'] for weight in layer]
 (options.output/'denoise-ml-weights.ts').write_text('/** Clean-room trained 10x16x8x1 neighbourhood scoring weights. */\nexport const WEIGHTS: readonly number[] = '+json.dumps(flat,separators=(',',':'))+';\n')
 print(json.dumps({'before':before,'after':after}),flush=True)

if __name__ == "__main__":
 main()
