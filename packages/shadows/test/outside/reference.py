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


def glb_image(texture):
    # A texture of the file as a Blender image, read from the file's own bytes: what the importer does with this extension
    # has no part in the reference.
    with open(path, 'rb') as f:
        data = f.read()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    view = gltf['bufferViews'][gltf['images'][gltf['textures'][texture['index']]['source']]['bufferView']]
    start = 20 + length + 8 + view.get('byteOffset', 0)
    file = os.path.join(out, f"{scene_name}-texture-{texture['index']}.png")
    with open(file, 'wb') as f:
        f.write(data[start:start + view['byteLength']])
    image = bpy.data.images.load(file)
    image.pack()
    os.remove(file)
    return image


def translucent(tree, info):
    # KHR_materials_diffuse_transmission: the BTDF's colour times its factor, the rest of the diffuse black, as only the light
    # coming through is measured. Factor in the texture's alpha, colour in its RGB, as the extension defines them.
    dt = info['extensions']['KHR_materials_diffuse_transmission']
    colour = dt.get('diffuseTransmissionColorFactor', [1, 1, 1])
    surface = tree.nodes.new('ShaderNodeBsdfTranslucent')
    black = tree.nodes.new('ShaderNodeBsdfDiffuse')
    black.inputs['Color'].default_value = (0, 0, 0, 1)
    tint = tree.nodes.new('ShaderNodeRGB')
    tint.outputs[0].default_value = (*colour, 1)
    source = tint.outputs[0]
    if 'diffuseTransmissionColorTexture' in dt:
        image = tree.nodes.new('ShaderNodeTexImage')
        image.image = glb_image(dt['diffuseTransmissionColorTexture'])
        multiply = tree.nodes.new('ShaderNodeMixRGB')
        multiply.blend_type = 'MULTIPLY'
        multiply.inputs[0].default_value = 1
        tree.links.new(tint.outputs[0], multiply.inputs[1])
        tree.links.new(image.outputs['Color'], multiply.inputs[2])
        source = multiply.outputs[0]
    tree.links.new(source, surface.inputs['Color'])
    share = tree.nodes.new('ShaderNodeMixShader')
    share.inputs[0].default_value = dt.get('diffuseTransmissionFactor', 0)
    if 'diffuseTransmissionTexture' in dt:
        image = tree.nodes.new('ShaderNodeTexImage')
        image.image = glb_image(dt['diffuseTransmissionTexture'])
        image.image.colorspace_settings.name = 'Non-Color'
        factor = tree.nodes.new('ShaderNodeMath')
        factor.operation = 'MULTIPLY'
        factor.inputs[1].default_value = dt.get('diffuseTransmissionFactor', 0)
        tree.links.new(image.outputs['Alpha'], factor.inputs[0])
        tree.links.new(factor.outputs[0], share.inputs[0])
    tree.links.new(black.outputs[0], share.inputs[1])
    tree.links.new(surface.outputs[0], share.inputs[2])
    return share.outputs[0]


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
    through = spec.get('translucent') and 'KHR_materials_diffuse_transmission' in info.get('extensions', {})
    tree.links.new(translucent(tree, info) if through else diffuse.outputs[0], mix.inputs[2])
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
scene.cycles.diffuse_bounces = spec.get('bounces', 0)
scene.cycles.transmission_bounces = spec.get('bounces', 0)
scene.cycles.transparent_max_bounces = 32
scene.render.resolution_x = scene.render.resolution_y = spec['size']
scene.render.filter_size = 0.5
scene.view_settings.view_transform = 'Raw'
scene.view_settings.look = 'None'
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '32'
scene.world = None

white = bpy.data.materials.new('white')
tree = white.node_tree
tree.nodes.clear()
surface = tree.nodes.new('ShaderNodeBsdfDiffuse')
surface.inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
tree.links.new(surface.outputs[0], tree.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])


def terrarium():
    # A Terrarium elevation tile (metres = red * 256 + green + blue / 256 - 32768) as a grid mesh, row 0 of the file at -z.
    image = bpy.data.images.load(os.path.join(root, spec['terrain']))
    image.colorspace_settings.name = 'Non-Color'
    width, height = image.size
    pixels = list(image.pixels)
    extent = spec['extent']
    scale = spec['heightScale']
    vertices = []
    for j in range(height):
        for i in range(width):
            o = ((height - 1 - j) * width + i) * 4
            metres = round(pixels[o] * 255) * 256 + round(pixels[o + 1] * 255) + round(pixels[o + 2] * 255) / 256 - 32768
            vertices.append(tuple(axes(((i / (width - 1) - 0.5) * extent, metres * scale, (j / (height - 1) - 0.5) * extent))))
    faces = [(j * width + i, j * width + i + 1, (j + 1) * width + i + 1, (j + 1) * width + i)
             for j in range(height - 1) for i in range(width - 1)]
    mesh = bpy.data.meshes.new('terrain')
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(white)
    land = bpy.data.objects.new('terrain', mesh)
    scene.collection.objects.link(land)
    return land


land = terrarium() if 'terrain' in spec else None
path = os.path.join(root, spec['model']) if 'model' in spec else None
pattern = spec.get('pattern')
if path:
    bpy.ops.import_scene.gltf(filepath=path)
model = [o for o in scene.objects if o.type == 'MESH' and o is not land]
modes = glb_materials(path) if path else {}
for material in bpy.data.materials:
    if material.node_tree and material is not white:
        plain(material, modes)
scale = spec.get('scale', 1)
offset = spec.get('offset', [0, 0, 0])
for o in scene.objects:
    if o.parent is None:
        o.scale = o.scale * scale
        o.location = o.location * scale + axes(offset)
bpy.context.view_layer.update()
corners = [o.matrix_world @ Vector(c) for o in model for c in o.bound_box]
if corners:
    print('BOUNDS gltf axes',
          [round(min(c[0] for c in corners), 3), round(min(c[2] for c in corners), 3), round(min(-c[1] for c in corners), 3)],
          [round(max(c[0] for c in corners), 3), round(max(c[2] for c in corners), 3), round(max(-c[1] for c in corners), 3)])

def mask_plane():
    # A real sheet across the sun, its image as what it lets through, so the light on the ground is the image's colour.
    # Its axes are what lightPattern documents: right is world up crossed with the sun, and image up is that basis's up.
    to_light = Vector(spec['toLight']).normalized()
    right = Vector((to_light.z, 0, -to_light.x)).normalized()
    up = to_light.cross(right)
    half = pattern['size'] / 2
    middle = to_light * pattern['distance']
    corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
    mesh = bpy.data.meshes.new('mask')
    mesh.from_pydata([tuple(axes(middle + right * a + up * b)) for a, b in corners], [], [(0, 1, 2, 3)])
    layer = mesh.uv_layers.new()
    offset = pattern.get('offset', [0, 0])
    for loop, (a, b) in zip(layer.data, corners):
        loop.uv = (a / pattern['size'] + 0.5 + offset[0], b / pattern['size'] + 0.5 - offset[1])
    material = bpy.data.materials.new('mask')
    tree = material.node_tree
    tree.nodes.clear()
    image = tree.nodes.new('ShaderNodeTexImage')
    image.image = bpy.data.images.load(os.path.join(root, pattern['image']))
    image.extension = 'REPEAT'
    through = tree.nodes.new('ShaderNodeBsdfTransparent')
    tree.links.new(image.outputs['Color'], through.inputs['Color'])
    tree.links.new(through.outputs[0], tree.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
    mesh.materials.append(material)
    sheet = bpy.data.objects.new('mask', mesh)
    scene.collection.objects.link(sheet)
    return sheet


if pattern:
    model.append(mask_plane())

ground = None
if 'ground' in spec:
    half = spec['ground']['size'] / 2
    y = spec['ground']['y']
    mesh = bpy.data.meshes.new('ground')
    mesh.from_pydata([(-half, -half, y), (half, -half, y), (half, half, y), (-half, half, y)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new('ground', mesh)
    scene.collection.objects.link(ground)
    mesh.materials.append(white)

sun = bpy.data.lights.new('sun', 'SUN')
sun.energy = 1
sun.angle = 2 * math.atan(spec.get('lightSize', 0))
sun_object = bpy.data.objects.new('sun', sun)
scene.collection.objects.link(sun_object)
sun_object.rotation_mode = 'QUATERNION'
sun_object.rotation_quaternion = (-axes(spec['toLight']).normalized()).to_track_quat('-Z', 'Y')
if 'floor' in spec:
    # What a style leaves in a full shadow, as light: a second sun that casts nothing, the first keeping the rest.
    sun.color = [1 - v for v in spec['floor']]
    second = bpy.data.lights.new('uncast', 'SUN')
    second.energy = 1
    second.angle = sun.angle
    second.color = spec['floor']
    second.use_shadow = False
    second_object = bpy.data.objects.new('uncast', second)
    scene.collection.objects.link(second_object)
    second_object.rotation_mode = 'QUATERNION'
    second_object.rotation_quaternion = sun_object.rotation_quaternion

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
    return pixels[spec.get('channel', 0)::4]


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


if land:
    # A land shadows itself: the same render with its shadow rays off is the light without shadows.
    shadowed = render('with')
    land.visible_shadow = False
    clear = render('without')
    write('visibility', [min(1, a / b) if b > 1e-6 else 1 for a, b in zip(shadowed, clear)])
    # A slope turned from the sun holds no light to shadow, so the ratio means nothing there: it is left out as a model
    # pixel is. Flat facets here and smooth normals in the engine also turn away at slightly different places.
    top = max(clear)
    write('mask', [1 if b < 0.015 * top else 0 for b in clear])
    sys.exit(0)

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
if 'floor' in spec:
    second_object.hide_render = True
ground.hide_render = True
for o in model:
    o.hide_render = False
    o.visible_camera = True
for tree, mix, mode in surfaces:
    tree.links.new(tree.nodes.new('ShaderNodeEmission').outputs[0], mix.inputs[2])
    if mode == 'BLEND' or mode == 'OPAQUE':
        mix.inputs[0].default_value = 1
write('mask', [1 if v > 0.01 else 0 for v in render('mask')])
