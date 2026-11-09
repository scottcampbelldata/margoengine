"""External Cycles path trace of the five emission/coverage panes. Public bpy API only."""
from array import array
import json
import math
from pathlib import Path
import sys
import bpy

args = sys.argv[sys.argv.index('--') + 1:]
spec = json.loads(Path(args[0]).read_text())
out = Path(args[1])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1024
scene.cycles.seed = 168
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.cycles.max_bounces = 8
scene.cycles.transparent_max_bounces = 16
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
scene.cycles.pixel_filter_type = 'BOX'
scene.cycles.filter_width = 0.01
world = bpy.data.worlds.new('black')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0
camera = bpy.data.cameras.new('camera')
camera.sensor_fit = 'VERTICAL'
camera.sensor_height = 36
camera.lens = 36 / (2 * math.tan(math.radians(spec['fov']) / 2))
camera.clip_start = spec['near']
camera.clip_end = spec['far']
obj = bpy.data.objects.new('camera', camera)
bpy.context.collection.objects.link(obj)
obj.location = spec['eye']
scene.camera = obj
for pane in spec['panes']:
    h, z = spec['half'], pane['z']
    mesh = bpy.data.meshes.new('pane')
    mesh.from_pydata([[-h,-h,z],[h,-h,z],[h,h,z],[-h,h,z]], [], [(0,1,2,3)])
    mesh.update()
    obj = bpy.data.objects.new('pane', mesh)
    bpy.context.collection.objects.link(obj)
    material = bpy.data.materials.new('coverage-emitter')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    transparent = nodes.new('ShaderNodeBsdfTransparent')
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (*pane['color'], 1)
    emission.inputs['Strength'].default_value = 1
    mix = nodes.new('ShaderNodeMixShader')
    mix.inputs[0].default_value = pane['alpha']
    output = nodes.new('ShaderNodeOutputMaterial')
    links = material.node_tree.links
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(emission.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs['Surface'])
    obj.data.materials.append(material)
scene.render.filepath = str(out / 'cycles.exr')
bpy.ops.render.render(write_still=True)
image = bpy.data.images.load(scene.render.filepath, check_existing=False)
pixels = list(image.pixels)
rgb = array('f')
for y in range(spec['height'] - 1, -1, -1):
    for x in range(spec['width']):
        offset = (y * spec['width'] + x) * 4
        rgb.extend(pixels[offset:offset + 3])
with (out / 'cycles-rgb.f32').open('wb') as stream:
    rgb.tofile(stream)
(out / 'cycles-meta.json').write_text(json.dumps({
    'blender': bpy.app.version_string, 'samples': scene.cycles.samples,
    'width': spec['width'], 'height': spec['height'], 'seed': scene.cycles.seed,
    'integrator': 'Cycles CPU path tracer; transparent/emission mixture; black world',
    'filter': 'BOX, 0.01 pixel', 'layout': 'top-down RGB float32 little-endian',
}))
