# Authors the layers fixture: one grid with three UV maps and two colour attributes, through Blender's own FBX exporter.
# Usage: blender --background --factory-startup --python blender-layers.py -- <folder>
# Writes blender-layers.fbx and blender-layers.json, each vertex's values as Blender holds them. CC0, see README.md.
import json
import sys
from pathlib import Path

import bpy
from io_scene_fbx import export_fbx_bin

folder = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)

SIZE = 3
vertices = [(x, y, 0) for y in range(SIZE) for x in range(SIZE)]
faces = [
    (y * SIZE + x, y * SIZE + x + 1, (y + 1) * SIZE + x + 1, (y + 1) * SIZE + x)
    for y in range(SIZE - 1)
    for x in range(SIZE - 1)
]
mesh = bpy.data.meshes.new('Grid')
mesh.from_pydata(vertices, [], faces)
mesh.update()
for name in ('UVMap', 'lightmap', 'detail'):
    mesh.uv_layers.new(name=name)
for name in ('Tint', 'Wetness'):
    mesh.color_attributes.new(name=name, type='FLOAT_COLOR', domain='CORNER')

for loop in mesh.loops:
    x, y, _ = mesh.vertices[loop.vertex_index].co
    mesh.uv_layers['UVMap'].data[loop.index].uv = (x / 2, y / 2)
    mesh.uv_layers['lightmap'].data[loop.index].uv = (0.25 + x / 8, 0.5 + y / 8)
    mesh.uv_layers['detail'].data[loop.index].uv = (x * 4, y * 4)
    mesh.color_attributes['Tint'].data[loop.index].color = (x / 2, y / 2, 0.25, 1)
    mesh.color_attributes['Wetness'].data[loop.index].color = (0.5, x / 4, y / 4, 0.75)

bpy.context.scene.collection.objects.link(bpy.data.objects.new('Grid', mesh))

truth = {'uvs': {}, 'colors': {}}
for layer in mesh.uv_layers:
    truth['uvs'][layer.name] = {
        ','.join(str(int(c)) for c in mesh.vertices[loop.vertex_index].co[:2]): list(layer.data[loop.index].uv)
        for loop in mesh.loops
    }
for layer in mesh.color_attributes:
    truth['colors'][layer.name] = {
        ','.join(str(int(c)) for c in mesh.vertices[loop.vertex_index].co[:2]): list(layer.data[loop.index].color)
        for loop in mesh.loops
    }
(folder / 'blender-layers.json').write_text(json.dumps(truth, indent=1) + '\n')

# Same step as blender-rig.py, as the exporter's fixed InheritType 1 is not what this fixture is about.
original_set = export_fbx_bin.elem_props_template_set


def uniform_scale_inheritance(template, props, ptype, name, value, *args, **kwargs):
    if name == b'InheritType':
        value = 0
    return original_set(template, props, ptype, name, value, *args, **kwargs)


export_fbx_bin.elem_props_template_set = uniform_scale_inheritance
bpy.ops.export_scene.fbx(
    filepath=str(folder / 'blender-layers.fbx'), use_selection=False, object_types={'MESH'}, axis_forward='Y',
    axis_up='Z', apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL', colors_type='LINEAR', bake_anim=False,
)
