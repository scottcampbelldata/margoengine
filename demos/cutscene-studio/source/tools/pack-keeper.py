"""Bake a single compact, material-separated portrait to the direct Margo geometry transport."""
import gzip
from io import BytesIO
import json
from pathlib import Path
import struct
import sys

import numpy as np
from PIL import Image

source,target=map(Path,sys.argv[1:])
container=source.read_bytes()
name,version,length,json_size,json_kind=struct.unpack_from('<4sIIII',container)
if name!=b'glTF' or version!=2 or length!=len(container) or json_kind!=0x4e4f534a:
    raise ValueError('Expected a complete GLB 2.0 file.')
document=json.loads(container[20:20+json_size])
binary=container[28+json_size:]
formats={5121:'u1',5123:'<u2',5125:'<u4',5126:'<f4'}
arity={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}

def values(id,offset,count,dims,fmt):
    view=document['bufferViews'][id]
    return np.ndarray((count,dims),fmt,buffer=binary,
                      offset=view.get('byteOffset',0)+offset,
                      strides=(view.get('byteStride',dims*fmt.itemsize),fmt.itemsize)).copy()

def array(id):
    access=document['accessors'][id]
    dims=arity[access['type']]
    fmt=np.dtype(formats[access['componentType']])
    count=access['count']
    if 'bufferView' in access:
        result=values(access['bufferView'],access.get('byteOffset',0),count,dims,fmt)
    else:
        result=np.zeros((count,dims),fmt)
    if 'sparse' in access:
        sparse=access['sparse']
        indices,payload=sparse['indices'],sparse['values']
        locations=values(indices['bufferView'],indices.get('byteOffset',0),sparse['count'],1,
                         np.dtype(formats[indices['componentType']])).reshape(-1)
        result[locations]=values(payload['bufferView'],payload.get('byteOffset',0),sparse['count'],dims,fmt)
    return result

maps={}
def bitmap(texture):
    if texture in maps:
        return maps[texture]
    source_id=document['textures'][texture]['source']
    image=document['images'][source_id]
    view=document['bufferViews'][image['bufferView']]
    start=view.get('byteOffset',0)
    pixel=np.array(Image.open(BytesIO(binary[start:start+view['byteLength']])).convert('RGBA'))
    maps[texture]=pixel
    return pixel

def rotation(node):
    if 'matrix' in node:
        m=np.array(node['matrix'],dtype=np.float64).reshape(4,4).T
        return m[:3,:3],m[:3,3]
    x,y,z,w=node.get('rotation',[0,0,0,1])
    m=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    return m*np.array(node.get('scale',[1,1,1])),np.array(node.get('translation',[0,0,0]))

def shade(name,rgb,point):
    r,g,b=rgb
    value=(.31*r+.53*g+.16*b)/255
    if 'face' in name:
        x,y,z=point
        if abs(x)<.041 and -.098<y<-.038 and z>.095 and r-g>31 and r>g*1.36:
            return '#99594f',.61
        offset=4*round((value-.47)*6)
        return '#%02x%02x%02x'%(165+offset,117+offset,92+offset),.64
    if 'workshirt' in name:
        if r>g*1.18 and value>.47:
            return '#a08367',.79
        return '#41596b',.81
    if 'irises' in name:
        return ('#756b58',.41) if value<.48 else ('#b5ad9b',.32)
    if 'tongue' in name:
        return '#783e45',.57
    if 'teeth' in name:
        return '#c6b797',.38
    if 'hair' in name:
        return ['#302725','#493a32','#5e4a3c'][min(2,max(0,int(value*5)))],.69
    return '#44352c',.75

layers=[]
blocks=[]
for node in document['nodes']:
    if 'mesh' not in node:
        continue
    mesh=document['meshes'][node['mesh']]
    basis,offset=rotation(node)
    normal_transform=np.linalg.inv(basis).T
    labels=mesh.get('extras',{}).get('targetNames',[])
    for primitive in mesh['primitives']:
        mat=document['materials'][primitive['material']]
        attrs=primitive['attributes']
        local=array(attrs['POSITION'])
        positions=local@basis.T+offset
        normals=array(attrs['NORMAL'])@normal_transform.T
        normals/=np.maximum(1e-8,np.linalg.norm(normals,axis=1,keepdims=True))
        index=array(primitive['indices']).reshape(-1,3)
        uv=array(attrs['TEXCOORD_0']) if 'TEXCOORD_0' in attrs else None
        pbr=mat.get('pbrMetallicRoughness',{})
        image=pbr.get('baseColorTexture')
        cmap=bitmap(image['index']) if image and uv is not None else None
        face_name=node.get('name','').lower()
        if 'teeth' in face_name and 'tongue' in mat['name'].lower():
            face_name='tongue'
        shapes={}
        for label,deltas in zip(labels,primitive.get('targets',[])):
            if label not in ('AH','EE','OO','M','Blink'):
                continue
            move=array(deltas['POSITION'])@basis.T
            change=array(deltas['NORMAL'])@normal_transform.T if 'NORMAL' in deltas else np.zeros_like(normals)
            shapes[label]=(move,change)

        batches={}
        untextured=pbr.get('baseColorFactor',[.47,.43,.39,1])
        for face in index:
            face=face.astype(int)
            if cmap is not None:
                at=uv[face].mean(0)
                px,py=(np.clip(at,0,.999999)*np.array([cmap.shape[1],cmap.shape[0]])).astype(int)
                pixel=cmap[py,px]
                if mat.get('alphaMode') in ('BLEND','MASK') and pixel[3]<98:
                    continue
            else:
                pixel=np.array(untextured)*255
            key=shade(face_name,pixel[:3],positions[face].mean(0))
            batches.setdefault(key,[]).extend(face)

        for (color,roughness),faces in batches.items():
            vertices,local_ids=np.unique(faces,return_inverse=True)
            p=positions[vertices]
            n=normals[vertices]
            x=local_ids.astype('<u2')
            blocks.extend(((p*24576).round().astype('<i2').tobytes(),
                           (n*127).round().clip(-127,127).astype('i1').tobytes(),x.tobytes()))
            keys={}
            for label,(motion,change) in shapes.items():
                dp=(motion[vertices]*24576).round().astype('<i2')
                dn=(change[vertices]*14000).round().clip(-32767,32767).astype('<i2')
                enabled=np.flatnonzero(np.any(dp,axis=1)|np.any(dn,axis=1))
                if not len(enabled):
                    continue
                table=np.empty((len(enabled),7),dtype='<i2')
                table[:,0]=enabled
                table[:,1:4]=dp[enabled]
                table[:,4:]=dn[enabled]
                blocks.append(table.tobytes())
                keys[label]=len(enabled)
            layers.append({'vertices':len(vertices),'indices':len(x),'color':color,'roughness':roughness,'shapes':keys})
metadata=json.dumps(layers,separators=(',',':')).encode()
if len(layers)<6:
    raise ValueError('Keeper geometry is incomplete.')
output=gzip.compress(struct.pack('<I',len(metadata))+metadata+b''.join(blocks),compresslevel=9,mtime=0)
target.write_bytes(output)
print(len(layers),'material parts and',sum(p['vertices'] for p in layers),'total vertices:',len(output),'bytes')
