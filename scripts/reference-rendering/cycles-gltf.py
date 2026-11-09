"""Black-box Cycles render of the shared GLB, using public bpy APIs only.
Reuses batch 168's fixed-seed EXR/raw-float reference contract.
"""
from array import array
import json
from pathlib import Path
import sys
import bpy

out = Path(sys.argv[sys.argv.index('--') + 1])
direct = '--direct' in sys.argv
prefix = 'cycles-direct' if direct else 'cycles'
spec = json.loads((out / 'viewer-metadata.json').read_text())['settings']
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(out / 'scene.glb'))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 128
scene.cycles.seed = 160
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.cycles.max_bounces = 16
scene.cycles.transmission_bounces = 12
scene.cycles.transparent_max_bounces = 16
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 4
scene.cycles.caustics_reflective = True
scene.cycles.caustics_refractive = True
scene.cycles.sample_clamp_direct = 0
scene.cycles.sample_clamp_indirect = 0
scene.cycles.pixel_filter_type = 'BOX'
scene.cycles.filter_width = 1.0
scene.render.threads_mode = 'FIXED'
scene.render.threads = 4
scene.render.resolution_x = spec['width']
scene.render.resolution_y = spec['height']
scene.render.resolution_percentage = 100
scene.render.pixel_aspect_x = 1
scene.render.pixel_aspect_y = 1
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '32'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = False
scene.camera = next(o for o in scene.objects if o.type == 'CAMERA' and o.name == 'Batch 160 camera')
world = bpy.data.worlds.new('black')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0
suns = [o for o in scene.objects if o.type == 'LIGHT']
assert len(suns) == 1 and suns[0].data.type == 'SUN'
# Both engines receive linear RGB irradiance 3, not Blender's photometric glTF import conversion.
suns[0].data.energy = spec['light']['intensity']
suns[0].data.color = (1, 1, 1)
suns[0].data.angle = 0
if direct:
    scene.cycles.diffuse_bounces = 0
    scene.cycles.glossy_bounces = 0
    for obj in scene.objects:
        if obj.type == 'MESH':
            obj.visible_shadow = False
scene.render.filepath = str(out / (prefix + '.exr'))
bpy.ops.render.render(write_still=True)
image = bpy.data.images.load(scene.render.filepath, check_existing=False)
pixels = list(image.pixels)
rgb = array('f')
for y in range(spec['height'] - 1, -1, -1):
    for x in range(spec['width']):
        offset = (y * spec['width'] + x) * 4
        rgb.extend(pixels[offset:offset + 3])
with (out / (prefix + '-rgb.f32')).open('wb') as stream:
    rgb.tofile(stream)
(out / (prefix + '-meta.json')).write_text(json.dumps({
    'blender': bpy.app.version_string, 'samples': scene.cycles.samples,
    'seed': scene.cycles.seed, 'threads': scene.render.threads,
    'width': spec['width'], 'height': spec['height'],
    'maxBounces': scene.cycles.max_bounces, 'transmissionBounces': scene.cycles.transmission_bounces,
    'filter': 'BOX', 'filterWidth': scene.cycles.filter_width,
    'camera': scene.camera.name, 'sunIrradiance': suns[0].data.energy,
    'mode': 'direct-lit refraction, no cast shadows or diffuse/glossy bounce' if direct else 'full path transport',
    'domain': 'scene-linear RGB, top row first; no IBL, no denoising',
}, indent=2))
