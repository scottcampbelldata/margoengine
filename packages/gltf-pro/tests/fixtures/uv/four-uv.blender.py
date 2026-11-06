# Blender script: a quad with four UV maps; the base colour reads the third map, the emission the fourth.
# Usage: blender --background --factory-startup --python uv-blender.py -- <out.glb>
import sys
import bpy

out = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh = bpy.data.meshes.new('FourUVQuad')
mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
mesh.update()
corners = [(0, 0), (1, 0), (1, 1), (0, 1)]
maps = {
    'UVMap': corners,  # as is
    'UVMap.001': corners,  # as is, so a fall back to the first two sets shows
    'UVMap.002': [(1 - u, v) for u, v in corners],  # mirrored left to right
    'UVMap.003': [(u, 1 - v) for u, v in corners],  # mirrored top to bottom
}
for name, values in maps.items():
    layer = mesh.uv_layers.new(name=name)
    for i, uv in enumerate(values):
        layer.data[i].uv = uv


def split(name, a, b, vertical):
    """A 2 x 2 image: colour `a` on the low side of u (or of v, with `vertical`), `b` on the high side."""
    image = bpy.data.images.new(name, 2, 2, alpha=False)
    pixels = []
    for y in range(2):
        for x in range(2):
            pixels += (b if (y if vertical else x) else a) + [1]
    image.pixels = pixels
    image.pack()
    return image


material = bpy.data.materials.new('FourUV')
material.use_nodes = True
nodes, links = material.node_tree.nodes, material.node_tree.links
shader = nodes['Principled BSDF']
shader.inputs['Metallic'].default_value = 0
shader.inputs['Roughness'].default_value = 1
shader.inputs['Emission Strength'].default_value = 1


def textured(image, uv_map, socket):
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.interpolation = 'Closest'
    coordinate = nodes.new('ShaderNodeUVMap')
    coordinate.uv_map = uv_map
    links.new(coordinate.outputs['UV'], texture.inputs['Vector'])
    links.new(texture.outputs['Color'], shader.inputs[socket])


textured(split('base', [1, 0, 0], [0, 0, 1], False), 'UVMap.002', 'Base Color')
textured(split('glow', [0, 0, 0], [0, 1, 0], True), 'UVMap.003', 'Emission Color')
mesh.materials.append(material)
item = bpy.data.objects.new('FourUVQuad', mesh)
bpy.context.scene.collection.objects.link(item)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=False, export_apply=False)
print('wrote', out, bpy.app.version_string)
