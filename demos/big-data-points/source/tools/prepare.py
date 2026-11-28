"""Make the fixed USGS Kīlauea browse volume from the archived LAZ nodes."""
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import gzip
import json
import math

import laspy
import numpy as np
from scipy import ndimage
from pyproj import Transformer

parser=ArgumentParser(description=__doc__)
parser.add_argument("laz",type=Path,help="Folder containing the EPT LAZ files")
args=parser.parse_args()

ROOT=Path(__file__).resolve().parent
FILES=ROOT/"cloud"
FILES.mkdir(exist_ok=True)
URL="https://s3-us-west-2.amazonaws.com/usgs-lidar-public/HI_Volcano_B1_2019/"
SOURCE="https://www.usgs.gov/data/digital-elevation-model-klauea-volcano-hawaii-based-july-2019-airborne-lidar-surveys"
CENTER=(-155.284,19.407)
TO_UTM=Transformer.from_crs(3857,32605,always_xy=True)
TO_MERC=Transformer.from_crs(4326,3857,always_xy=True)
x0,y0=TO_MERC.transform(*CENTER)
e0,n0=TO_UTM.transform(x0,y0)
W,H=4300,3600
Z_MIN,Z_MAX=420,1330
STEP=.10
POINT_LIMIT=2_000_000
rng=np.random.default_rng(764)

def key(f):
    return tuple(int(v) for v in f.stem.split("-"))

blocks=[]
classes=[]
sources=[]
for i,f in enumerate(sorted(args.laz.glob("*.laz"),key=key),1):
    points=laspy.read(f)
    x,y,z=[np.asarray(getattr(points,c)) for c in ("x","y","z")]
    labels=np.asarray(points.classification)
    filtered=np.isin(labels,[1,2])&(abs(x-x0)<2350)&(abs(y-y0)<2000)&(z>=Z_MIN)&(z<=Z_MAX)
    x,y,z=x[filtered],y[filtered],z[filtered]
    e,n=TO_UTM.transform(x,y)
    q=np.stack((e-e0+W/2,n-n0+H/2,z-Z_MIN),axis=1)
    inside=(q[:,0]>=0)&(q[:,0]<=W)&(q[:,1]>=0)&(q[:,1]<=H)
    if inside.any():
        blocks.append(np.rint(q[inside]/STEP).astype(np.uint16))
        classes.append(labels[filtered][inside])
        sources.append({"key":f.stem,"sha256":sha256(f.read_bytes()).hexdigest(),"points":int(inside.sum())})
    if i%40==0:print("decoded",i,flush=True)
points=np.concatenate(blocks,axis=0)
classifications=np.concatenate(classes)
packing=(points[:,0].astype(np.uint64)<<32)|(points[:,1].astype(np.uint64)<<16)|points[:,2]
_,first=np.unique(packing,return_index=True)
first=np.sort(first)
points=points[first]
classifications=classifications[first]
print("unique retained",len(points),"elevation",points[:,2].min()*STEP+Z_MIN,points[:,2].max()*STEP+Z_MIN,flush=True)
if len(points)<POINT_LIMIT:raise ValueError("Crop does not have enough distinct candidate returns")

# A smoothed ground-height grid supplies the synthetic direction light; heights stay at measured points.
cell=8
nx,ny=math.ceil(W/cell)+1,math.ceil(H/cell)+1
xindex=(points[:,0]*STEP/cell).astype(np.int64)
yindex=(points[:,1]*STEP/cell).astype(np.int64)
tag=yindex*nx+xindex
ground=classifications==2
sums=np.bincount(tag[ground],weights=points[ground,2]*STEP,minlength=nx*ny).reshape(ny,nx)
counts=np.bincount(tag[ground],minlength=nx*ny).reshape(ny,nx)
values=sums/np.maximum(1,counts)
missing=counts==0
near=ndimage.distance_transform_edt(missing,return_distances=False,return_indices=True)
smoothed=ndimage.gaussian_filter(values[tuple(near)],1.2)
dy,dx=np.gradient(smoothed,cell)
shade=(.79+.22*dx-.47*dy)/np.sqrt(1+dx*dx+dy*dy)
brightness=np.rint(np.clip(shade[yindex,xindex]*201+35,54,255)).astype(np.uint8)

def spaced(indices, step, ceiling):
    p=points[indices]
    bins=(p[:,0]//step).astype(np.uint32)*100_000+p[:,1]//step
    _,first=np.unique(bins,return_index=True)
    chosen=indices[first]
    if len(chosen)>=ceiling:
        return chosen[rng.permutation(len(chosen))[:ceiling]]
    chosen_set=np.zeros(len(indices),dtype=np.bool_)
    chosen_set[first]=True
    tail=indices[~chosen_set]
    return np.concatenate([chosen,tail[rng.permutation(len(tail))[:ceiling-len(chosen)]]])

whole=np.arange(len(points))
seed=spaced(whole,520,5500)
permit=np.ones(len(points),dtype=np.bool_)
permit[seed]=False
others=whole[permit]
chosen=np.concatenate([seed,others[rng.permutation(len(others))[:POINT_LIMIT-len(seed)]]])
points=points[chosen]
brightness=brightness[chosen]
nodes=[]

def make_file(node,indices):
    p=points[indices]
    column_order=np.lexsort((p[:,0],p[:,1]//16))
    p=p[column_order]
    shade=brightness[indices][column_order]
    coords=np.concatenate([p[:1],np.diff(p,axis=0)],axis=0).astype("<u2")
    raw=b"".join(coords[:,i].tobytes() for i in range(3))+shade.tobytes()
    out=gzip.compress(raw,compresslevel=8,mtime=0)
    name=node+".bin"
    (FILES/name).write_bytes(out)
    return name,len(out),sha256(out).hexdigest()

def write_node(node,ids,extents,depth,target=None):
    x0,y0,z0,x1,y1,z1=extents
    if depth==0:
        coarse=np.arange(len(seed))
        rest=ids[len(seed):]
    elif depth<3:
        cap=target if target is not None else 16000
        coarse=spaced(ids,150 if depth==1 else 65,min(cap,len(ids)))
        rest=np.setdiff1d(ids,coarse,assume_unique=True)
    else:
        coarse=ids
        rest=np.array([],dtype=np.int64)
    if not len(coarse):return
    file,size,sha=make_file(node,coarse)
    box=[x0-W/2,y0,z0-H/2,x1-W/2,y1,z1-H/2]
    nodes.append({"id":node,"count":len(coarse),"bounds":box,"file":file,"bytes":size,"sha256":sha})
    if not len(rest):return
    mx,my,mz=(x0+x1)/2,(y0+y1)/2,(z0+z1)/2
    px=points[rest,0]*STEP
    py=points[rest,2]*STEP
    pz=H-points[rest,1]*STEP
    octants=(px>=mx).astype(np.uint8)+2*(py>=my)+4*(pz>=mz)
    pieces=[rest[octants==index] for index in range(8)]
    if depth==0:
        available=[index for index,pts in enumerate(pieces) if len(pts)]
        left=60000
        caps=[0]*8
        for rank,index in enumerate(sorted(available,key=lambda it:len(pieces[it]))):
            cap=min(len(pieces[index]),left//(len(available)-rank))
            caps[index]=cap
            left-=cap
        assert left==0
    for index,subset in enumerate(pieces):
        if not len(subset):continue
        east,upper,south=[bool(index&(1<<n)) for n in range(3)]
        child=(mx if east else x0,my if upper else y0,mz if south else z0,
            x1 if east else mx,y1 if upper else my,z1 if south else mz)
        write_node(node+str(index),subset,child,depth+1,caps[index] if depth==0 else None)

write_node("r",np.arange(len(points)),(0,0,0,W,Z_MAX-Z_MIN,H),0)
valid_files={node["file"] for node in nodes}
for old in FILES.glob("r*.bin"):
    if old.name not in valid_files:old.unlink()
assert sum(v["count"] for v in nodes)==POINT_LIMIT
manifest={"count":len(points),"nodes":nodes,"extent":[W,H],"height":[Z_MIN,Z_MAX],"step":STEP,"origin":[e0,n0],
    "elevation":[float(points[:,2].min()*STEP+Z_MIN),float(points[:,2].max()*STEP+Z_MIN)]}
(ROOT/"manifest.json").write_text(json.dumps(manifest,separators=(",",":"))+"\n",encoding="utf-8")
runtime={**manifest,"nodes":[{field:entry[field] for field in ("id","count","bounds","file")} for entry in nodes]}
(ROOT/"runtime.json").write_text(json.dumps(runtime,separators=(",",":"))+"\n",encoding="utf-8")
provenance={"dataset":"2019 Kilauea lidar, HI_Volcano_B1_2019","license":"US Government Public Domain","source":SOURCE,
    "ept":URL+"ept.json","tiles":sources,"centerLongitudeLatitude":CENTER,"displayCRS":"WGS 84 / UTM zone 5N, EPSG:32605",
    "vertical":"Original EPT tile elevations in metres", "groundClass":2,"precisionM":STEP,
    "availableRetainedPoints":len(first),"selectedPoints":len(points),
    "classes":[1,2],"selectedGroundPoints":int(np.sum(classifications[chosen]==2)),"seed":764}
(ROOT/"source.json").write_text(json.dumps(provenance,indent=2)+"\n",encoding="utf-8")
print(len(nodes),sum(v["bytes"] for v in nodes),manifest["elevation"],len(seed),flush=True)
