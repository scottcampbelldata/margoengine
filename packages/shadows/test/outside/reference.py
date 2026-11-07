# Renders the shadow references with Blender Cycles, an outside path tracer that shares no code with Margo.
# blender --background --factory-startup --python packages/shadows/test/outside/reference.py -- <scene> [output folder]
# For each scene it writes <scene>.visibility.png (ground light with the model over ground light without it, 0 to 1) and
# <scene>.mask.png (where the model hides the ground). Scene values are glTF axes (Y up); Blender's are (x, -z, y).
import bpy, json, math, os, struct, sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, '..', '..', '..', '..'))
scene_name = args[0]
out = os.path.abspath(args[1]) if len(args) > 1 else os.path.join(here, '..', 'fixtures', 'outside')
os.makedirs(out, exist_ok=True)
spec = json.load(open(os.path.join(here, 'scenes.json')))[scene_name]


def axes(v):
    return Vector((v[0], -v[2], v[1]))


def glb_materials(path):
    with open(path, 'rb') as f:
        data = f.read()
    length = struct.unpack_from('<I', data, 12)[0]
    return {m.get('name'): m for m in json.loads(data[20:20 + length]).get('materials', [])}


def plain(material, modes):
    # Only the outline matters here: alpha under the file's own cutoff is a hole, the rest black diffuse. BLEND casts
    # nothing, as Margo's plain depth map documents.
    tree = material.node_tree
    principled = next((n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    links = principled.inputs['Alpha'].links if principled else []
    source = links[0].from_socket if links else None
    info = modes.get(material.name.split('.')[0], {})
    mode = info.get('alphaMode', 'OPAQUE')
    output = next(n for n in tree.nodes if n.type == 'OUTPUT_MATERIAL')
    diffuse = tree.nodes.new('ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = (0, 0, 0, 1)
    hole = tree.nodes.new('ShaderNodeBsdfTransparent')
    mix = tree.nodes.new('ShaderNodeMixShader')
    if mode == 'MASK' and source is not None:
        keep = tree.nodes.new('ShaderNodeMath')
        keep.operation = 'GREATER_THAN'
        keep.inputs[1].default_value = info.get('alphaCutoff', 0.5)
        tree.links.new(source, keep.inputs[0])
        tree.links.new(keep.outputs[0], mix.inputs[0])
    else:
        mix.inputs[0].default_value = 0 if mode == 'BLEND' or spec.get('masksOnly') else 1
    tree.links.new(hole.outputs[0], mix.inputs[1])
    tree.links.new(diffuse.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], output.inputs['Surface'])
    surfaces.append((tree, mix, mode))


surfaces = []
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = spec.get('samples', 64)
scene.cycles.use_denoising = False
scene.cycles.max_bounces = spec.get('bounces', 0)
scene.cycles.transparent_max_bounces = 32
scene.render.resolution_x = scene.render.resolution_y = spec['size']
scene.render.filter_size = 0.5
scene.view_settings.view_transform = 'Raw'
scene.view_settings.look = 'None'
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '32'
scene.world = None

path = os.path.join(root, spec['model'])
bpy.ops.import_scene.gltf(filepath=path)
model = [o for o in scene.objects if o.type == 'MESH']
modes = glb_materials(path)
for material in bpy.data.materials:
    if material.node_tree:
        plain(material, modes)
scale = spec.get('scale', 1)
offset = spec.get('offset', [0, 0, 0])
for o in scene.objects:
    if o.parent is None:
        o.scale = o.scale * scale
        o.location = o.location * scale + axes(offset)
bpy.context.view_layer.update()
corners = [o.matrix_world @ Vector(c) for o in model for c in o.bound_box]
print('BOUNDS gltf axes',
      [round(min(c[0] for c in corners), 3), round(min(c[2] for c in corners), 3), round(min(-c[1] for c in corners), 3)],
      [round(max(c[0] for c in corners), 3), round(max(c[2] for c in corners), 3), round(max(-c[1] for c in corners), 3)])

half = spec['ground']['size'] / 2
y = spec['ground']['y']
mesh = bpy.data.meshes.new('ground')
mesh.from_pydata([(-half, -half, y), (half, -half, y), (half, half, y), (-half, half, y)], [], [(0, 1, 2, 3)])
ground = bpy.data.objects.new('ground', mesh)
scene.collection.objects.link(ground)
white = bpy.data.materials.new('white')
tree = white.node_tree
tree.nodes.clear()
surface = tree.nodes.new('ShaderNodeBsdfDiffuse')
surface.inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
tree.links.new(surface.outputs[0], tree.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
mesh.materials.append(white)

sun = bpy.data.lights.new('sun', 'SUN')
sun.energy = 1
sun.angle = 2 * math.atan(spec.get('lightSize', 0))
sun_object = bpy.data.objects.new('sun', sun)
scene.collection.objects.link(sun_object)
sun_object.rotation_mode = 'QUATERNION'
sun_object.rotation_quaternion = (-axes(spec['toLight']).normalized()).to_track_quat('-Z', 'Y')

camera = bpy.data.cameras.new('camera')
camera.sensor_fit = 'VERTICAL'
camera.angle_y = math.radians(spec['camera']['fov'])
camera.clip_start = 0.01
camera.clip_end = 10000
camera_object = bpy.data.objects.new('camera', camera)
scene.collection.objects.link(camera_object)
eye = axes(spec['camera']['position'])
camera_object.location = eye
camera_object.rotation_mode = 'QUATERNION'
camera_object.rotation_quaternion = (axes(spec['camera']['target']) - eye).to_track_quat('-Z', 'Y')
scene.camera = camera_object


def render(tag):
    file = os.path.join(out, f'{scene_name}-{tag}.exr')
    scene.render.filepath = file
    bpy.ops.render.render(write_still=True)
    image = bpy.data.images.load(file)
    pixels = list(image.pixels)
    bpy.data.images.remove(image)
    os.remove(file)
    return pixels[0::4]


def write(tag, values):
    size = spec['size']
    image = bpy.data.images.new(tag, size, size, alpha=False)
    image.colorspace_settings.name = 'Non-Color'
    flat = []
    for v in values:
        flat += [v, v, v, 1]
    image.pixels = flat
    image.filepath_raw = os.path.join(out, f'{scene_name}.{tag}.png')
    image.file_format = 'PNG'
    image.save()


# The model casts but the camera does not see it, so every pixel shows the ground.
for o in model:
    o.visible_camera = False
shadowed = render('with')
for o in model:
    o.hide_render = True
clear = render('without')
write('visibility', [min(1, a / b) if b > 1e-6 else 1 for a, b in zip(shadowed, clear)])
# Where the model hides the ground: the sun off and the ground gone, the model's surface glows through the same outline.
sun_object.hide_render = True
ground.hide_render = True
for o in model:
    o.hide_render = False
    o.visible_camera = True
for tree, mix, mode in surfaces:
    tree.links.new(tree.nodes.new('ShaderNodeEmission').outputs[0], mix.inputs[2])
    if mode == 'BLEND' or mode == 'OPAQUE':
        mix.inputs[0].default_value = 1
write('mask', [1 if v > 0.01 else 0 for v in render('mask')])
