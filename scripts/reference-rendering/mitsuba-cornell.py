"""Cornell direct lighting through public Mitsuba APIs; shared Margo fixture geometry."""
import json
from pathlib import Path
import sys
import numpy as np
import mitsuba as mi
import drjit as dr
mi.set_variant('scalar_rgb')
dr.set_thread_count(4)
folder=Path(sys.argv[1])
payload=json.loads((folder/'scene.json').read_text())
settings=payload['settings']
objects={}
for q in payload['quads']:
    props=mi.Properties()
    props['bsdf']=mi.load_dict({'type':'diffuse','reflectance':{'type':'rgb','value':q['albedo']}})
    mesh=mi.Mesh(q['name'],4,2,props)
    params=mi.traverse(mesh)
    params['vertex_positions']=np.asarray(q['positions'],np.float32)
    params['faces']=np.asarray([0,1,2,0,2,3],np.uint32)
    params.update()
    objects[q['name']]=mesh
camera=settings['camera']
light=settings['light']
emitter=({'type':'point','position':light['position'],'intensity':{'type':'rgb','value':[c*light['intensity'] for c in light['color']]}}
         if 'position' in light else
         {'type':'directional','direction':light['direction'],'irradiance':{'type':'rgb','value':[c*light['intensity'] for c in light['color']]}})
scene=mi.load_dict({'type':'scene',**objects,
    'integrator':{'type':'path','max_depth':2,'hide_emitters':True},
    'sun':emitter,
    'sensor':{'type':'perspective','fov_axis':'y','fov':camera['fov'],
        'near_clip':camera['near'],'far_clip':camera['far'],
        'to_world':mi.ScalarTransform4f().look_at(origin=camera['position'],target=camera['target'],up=[0,1,0]),
        'sampler':{'type':'independent','sample_count':128},
        'film':{'type':'hdrfilm','width':settings['width'],'height':settings['height'],
                'pixel_format':'rgb','component_format':'float32','rfilter':{'type':'box'}}}})
image=mi.render(scene,seed=160,spp=128)
values=np.asarray(image,dtype='<f4')
assert values.shape==(512,512,3) and np.isfinite(values).all()
values.tofile(folder/'mitsuba-direct-rgb.f32')
mi.Bitmap(image).write(str(folder/'mitsuba-direct.exr'))
(folder/'mitsuba-direct-meta.json').write_text(json.dumps({'version':mi.__version__,'variant':mi.variant(),
    'quads':len(payload['quads']),'triangles':len(payload['quads'])*2,'samples':128,'seed':160,'maxDepth':2,
    'threadCount':4,'model':'Lambert diffuse; point inverse square or directional irradiance; hard visibility; no indirect bounce; no authored range window'}))
print('REFERENCE',len(payload['quads']),'quads',flush=True)
