# Black-box Cycles bake of the Cornell box written by rival-bench.mjs.
# Blender is the host. This file does not read renderer source. It builds the quads,
# bakes the diffuse direct and indirect passes (surface color off) and writes floats.
import json
import math
import sys
import traceback

import bpy


def args_after_dash():
    argv = sys.argv
    mark = argv.index('--')
    return argv[mark + 1], argv[mark + 2]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.cycles.seed = 1
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.sample_clamp_direct = 0
    scene.cycles.sample_clamp_indirect = 0
    scene.render.bake.margin = 0
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.target = 'IMAGE_TEXTURES'
    world = bpy.data.worlds.new('black')
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes['Background']
    background.inputs['Color'].default_value = (0, 0, 0, 1)
    background.inputs['Strength'].default_value = 0
    return scene


def add_light(spec):
    data = bpy.data.lights.new('area', 'AREA')
    data.shape = 'RECTANGLE'
    data.size = spec['width']
    data.size_y = spec['height']
    data.normalize = False
    data.exposure = 0
    data.spread = math.pi
    data.energy = spec['energy']
    data.color = spec['color']
    obj = bpy.data.objects.new('area', data)
    bpy.context.collection.objects.link(obj)
    obj.location = spec['center']
    # Local -Z becomes world -Y. Local X stays world X. Local Y becomes world -Z,
    # which is the same centred rectangle as a +Z height.
    obj.rotation_euler = (math.radians(-90), 0, 0)
    return {
        'energy': data.energy,
        'color': [data.color[0], data.color[1], data.color[2]],
        'normalize': bool(data.normalize),
        'spread': data.spread,
        'exposure': data.exposure,
        'size': data.size,
        'size_y': data.size_y,
    }


def remove_light():
    for obj in list(bpy.data.objects):
        if obj.type == 'LIGHT':
            bpy.data.objects.remove(obj, do_unlink=True)
    for light in list(bpy.data.lights):
        bpy.data.lights.remove(light)


def add_quad(name, corners, albedo):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(corners, [], [(0, 1, 2, 3)])
    mesh.validate()
    mesh.update()
    uv_layer = mesh.uv_layers.new(name='Bake')
    mesh.uv_layers.active = uv_layer
    coords = [(0, 0), (1, 0), (1, 1), (0, 1)]
    poly = mesh.polygons[0]
    for loop in poly.loop_indices:
        uv_layer.data[loop].uv = coords[mesh.loops[loop].vertex_index]
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    tree = material.node_tree
    for node in list(tree.nodes):
        tree.nodes.remove(node)
    diffuse = tree.nodes.new('ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = (albedo[0], albedo[1], albedo[2], 1)
    output = tree.nodes.new('ShaderNodeOutputMaterial')
    tree.links.new(diffuse.outputs['BSDF'], output.inputs['Surface'])
    image_node = tree.nodes.new('ShaderNodeTexImage')
    obj.data.materials.append(material)
    return obj, image_node


def bake_quad(scene, obj, image_node, width, height, samples, bounces):
    scene.cycles.samples = samples
    scene.cycles.max_bounces = bounces
    scene.cycles.diffuse_bounces = bounces
    scene.cycles.glossy_bounces = 0
    scene.cycles.transmission_bounces = 0
    scene.cycles.transparent_max_bounces = 0
    image = bpy.data.images.new(obj.name + '-bake', width=width, height=height, alpha=False, float_buffer=True)
    image.colorspace_settings.name = 'Non-Color'
    image_node.image = image
    image_node.select = True
    obj.data.materials[0].node_tree.nodes.active = image_node
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=0, use_clear=True)
    pixels = list(image.pixels)
    rgb = []
    total = 0
    for i in range(0, len(pixels), 4):
        rgb.append([pixels[i], pixels[i + 1], pixels[i + 2]])
        total += pixels[i] + pixels[i + 1] + pixels[i + 2]
    return rgb, total


def main():
    scene_path, out_path = args_after_dash()
    with open(scene_path, 'r', encoding='utf-8') as handle:
        spec = json.load(handle)
    scene = clear_scene()
    stored = add_light(spec['calibration']['light'])
    obj, node = add_quad('calibration', spec['calibration']['corners'], [1, 1, 1])
    chart = spec['calibration']['chart']
    calibration, calibration_sum = bake_quad(scene, obj, node, chart['width'], chart['height'], spec['samples'], 0)
    if not (calibration_sum > 0):
        raise RuntimeError('calibration baked to black')
    bpy.data.objects.remove(obj, do_unlink=True)
    remove_light()
    cornell_light = add_light(spec['light'])
    # All receivers must remain present as occluders and diffuse bounce surfaces.
    receivers = [(quad, *add_quad(quad['name'], quad['corners'], quad['albedo'])) for quad in spec['quads']]
    quads = []
    for quad, obj, node in receivers:
        # Cycles' diffuse_bounces counts indirect bounces as Margo's `bounces` does: at 1 the ceiling,
        # which the light does not see, is lit, and the bake matches Margo at 1 bounce (KB2604h).
        pixels, _total = bake_quad(
            scene,
            obj,
            node,
            quad['chart']['width'],
            quad['chart']['height'],
            spec['samples'],
            spec['bounces'],
        )
        quads.append({'name': quad['name'], 'width': quad['chart']['width'], 'height': quad['chart']['height'], 'pixels': pixels})
    result = {
        'blender': bpy.app.version_string,
        'samples': spec['samples'],
        'bounces': spec['bounces'],
        'diffuse_bounces': spec['bounces'],
        'calibration_light': stored,
        'cornell_light': cornell_light,
        'calibration': calibration,
        'quads': quads,
    }
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(result, handle)
    print('cycles-bake-wrote', out_path)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
