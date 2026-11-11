"""Black-box reference through public Mitsuba APIs. Standard glTF bytes only; no renderer source."""
import json
from pathlib import Path
import sys
import numpy as np
import mitsuba as mi
import drjit as dr
import mitsuba_gltf

mi.set_variant('scalar_rgb')
dr.set_thread_count(4)
folder = Path(sys.argv[1])
settings, objects, counts = mitsuba_gltf.load(mi, folder)
for mode,depth in [('direct',2),('full',8)]:
    scene = mi.load_dict({'type':'scene', **objects,
        'integrator':{'type':'path','max_depth':depth,'hide_emitters':True},
        'environment':{'type':'constant','radiance':{'type':'rgb','value':settings['environment']}},
        'sensor':mitsuba_gltf.sensor(mi, settings, 128)})
    image = mi.render(scene,seed=160,spp=128)
    values = np.asarray(image,dtype='<f4')
    assert values.shape == (settings['height'],settings['width'],3) and np.isfinite(values).all()
    values.tofile(folder / ('mitsuba-'+mode+'-rgb.f32'))
    mi.Bitmap(image).write(str(folder / ('mitsuba-'+mode+'.exr')))
    (folder / ('mitsuba-'+mode+'-meta.json')).write_text(json.dumps({'version':mi.__version__,'variant':mi.variant(),
        **counts,'samples':128,'seed':160,'maxDepth':depth,'mode':mode,'threadCount':4,
        'model':'glTF metal/rough parameters mapped to Mitsuba principled; not a bit-exact glTF BSDF'}))
    print('REFERENCE',mode,counts,flush=True)
