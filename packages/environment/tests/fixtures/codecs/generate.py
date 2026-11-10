import sys, pathlib, json, hashlib
sys.path.insert(0,str(pathlib.Path('test-results/exr-oracledeps').resolve()))
import numpy as np
import OpenEXR
root=pathlib.Path('packages/environment/tests/fixtures/codecs')
a=np.fromfile('test-results/venice-codecs.f32',dtype='<f4').reshape(45,37,4)
records=[]
for dtype in ['half','float']:
  for codec in ['PXR24','B44','B44A','DWAA','DWAB']:
    for tiled in [False,True]:
      header={'compression':getattr(OpenEXR,codec+'_COMPRESSION'),'type':OpenEXR.tiledimage if tiled else OpenEXR.scanlineimage,
              'dataWindow':((-3,7),(33,51)),'displayWindow':((-10,0),(40,60))}
      if tiled:
        t=OpenEXR.TileDescription();t.xSize=16;t.ySize=8;t.mode=OpenEXR.ONE_LEVEL;header['tiles']=t
      channels={c:np.ascontiguousarray(a[:,:,i].astype(np.float16 if dtype=='half' else np.float32)) for i,c in enumerate('RGBA')}
      name=f'venice-{dtype}-{codec.lower()}'+('-tiled' if tiled else '')
      with OpenEXR.File(header,channels) as f:f.write(str(root/(name+'.exr')))
      with OpenEXR.File(str(root/(name+'.exr')),separate_channels=True) as f:
        expected=np.stack([f.channels()[c].pixels.astype(np.float32) for c in 'RGBA'],axis=-1).astype('<f4')
        (root/(name+'.f32')).write_bytes(expected.tobytes())
      records.append({'name':name,'compression':codec.lower(),'storage':'tiled' if tiled else 'scanline','width':37,'height':45,'sha256':hashlib.sha256((root/(name+'.exr')).read_bytes()).hexdigest()})
(root/'reference.json').write_text(json.dumps({'oracle':'OpenEXR '+OpenEXR.__version__,'source':'Greg Zaal / Poly Haven Venice Sunset, CC0; sample x*27,y*9, 37x45, clamp 65504','fixtures':records},indent=2)+'\n')
print(len(records),'fixtures',OpenEXR.__version__)
# Additional valid multipart/layer case: an incomplete root R must not hide the complete beauty layer.
h={'type':OpenEXR.scanlineimage,'compression':OpenEXR.B44A_COMPRESSION,'dataWindow':((-3,7),(33,51)),'displayWindow':((-10,0),(40,60))}
c={'beauty.'+v:np.ascontiguousarray(a[:,:,i].astype(np.float16)) for i,v in enumerate('RGBA')}
c['R']=np.zeros((45,37),np.float16)
h2={'type':OpenEXR.scanlineimage,'compression':OpenEXR.PXR24_COMPRESSION,'dataWindow':((-3,7),(33,51)),'displayWindow':((-10,0),(40,60))}
c2={v:np.ascontiguousarray(a[:,:,i]) for i,v in enumerate('RGBA')}
OpenEXR.File([OpenEXR.Part(h,c,'named'),OpenEXR.Part(h2,c2,'plain')]).write(str(root/'venice-parts.exr'))
record=json.loads((root/'reference.json').read_text());record['multipart']={'name':'venice-parts.exr','sha256':hashlib.sha256((root/'venice-parts.exr').read_bytes()).hexdigest()}
(root/'reference.json').write_text(json.dumps(record,indent=2)+'\n')
