
from pathlib import Path
import sys
from PIL import Image
import numpy as np

root,target=map(Path,sys.argv[1:])
target.mkdir(parents=True,exist_ok=True)
w,h=2048,416
az=(np.arange(w)+.5-w/2)*2*np.pi/w
az=np.clip(az,-np.pi/4,np.pi/4)
horizontal=np.tan(az)
vertical=(.5-(np.arange(h)+.5)/h)*1.22/np.cos(az)[:,None]
for path in root.glob('sky-*.png'):
    source=Image.open(path).convert('RGB')
    size=source.width
    x=((.5+.5*horizontal)*size-.5).clip(0,size-1)
    y=((.5-.5*vertical.T)*size-.5).clip(0,size-1)
    x0=np.floor(x).astype('int32')
    y0=np.floor(y).astype('int32')
    x1=np.minimum(x0+1,size-1)
    y1=np.minimum(y0+1,size-1)
    tx=(x-x0)[None,:,None]
    ty=(y-y0)[:,:,None]
    pixels=np.asarray(source)
    a=pixels[y0,x0]*(1-tx)+pixels[y0,x1]*tx
    b=pixels[y1,x0]*(1-tx)+pixels[y1,x1]*tx
    result=np.rint(a*(1-ty)+b*ty).astype('uint8')
    Image.fromarray(result).save(target/(path.stem+'.webp'),quality=89,method=6)
