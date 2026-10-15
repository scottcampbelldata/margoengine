"""Shared texture baking: Poly Haven CC0 textures + painted weathering + AO, baked (Cycles EMIT) into JPEG-exported atlases.

A "kind" names a surface recipe. Fixed kinds live in KINDS; `paint:#rrggbb` is painted metal/wood in that colour.
Set TD_FAST=1 to skip baking (viewport colours only) while iterating on layout.
"""
import math
import os

import bpy

import kit
import polyhaven

FAST = os.environ.get('TD_FAST') == '1'

# kind: (texture asset, tint hex or None, tint amount, streaks, grime, wear, uv scale)
KINDS = {
    'plaster_beige': ('beige_wall_001', '#ead9b8', 0.45, 0.12, 0.30, 0.15, 0.6),
    'plaster_grey': ('grey_plaster_02', '#cfcac0', 0.25, 0.14, 0.30, 0.15, 0.6),
    'plaster_mint': ('blue_plaster_weathered', '#a6d2c1', 0.62, 0.12, 0.30, 0.15, 0.6),
    'plaster_cracked': ('damaged_plaster', '#e9e1cf', 0.3, 0.12, 0.30, 0.15, 0.5),
    'plaster_salmon': ('grey_plaster_02', '#e3a385', 0.68, 0.12, 0.30, 0.15, 0.6),
    'brick': ('brick_wall_02', None, 0.0, 0.08, 0.30, 0.10, 0.7),
    'cedar': ('japanese_cedar_planks', None, 0.0, 0.05, 0.25, 0.20, 0.8),
    'hinoki': ('hinoki_planks', None, 0.0, 0.05, 0.20, 0.20, 0.8),
    'wood_dark': ('dark_planks', '#5a3d2a', 0.4, 0.05, 0.20, 0.25, 0.8),
    'tile_grey': ('grey_roof_tiles', '#57606a', 0.5, 0.10, 0.0, 0.15, 0.7),
    'tile_red': ('clay_roof_tiles_02', '#b5523c', 0.5, 0.10, 0.0, 0.15, 0.7),
    'asphalt': ('asphalt_02', '#3d3e44', 0.55, 0.0, 0.0, 0.0, 0.35),
    'paving': ('concrete_tiles', '#c9c0b0', 0.3, 0.0, 0.15, 0.0, 0.5),
    'concrete': ('concrete_wall_004', '#bdb8ae', 0.3, 0.12, 0.30, 0.15, 0.6),
    'corrugated': ('rusty_corrugated_iron', '#9aa0a3', 0.35, 0.10, 0.10, 0.20, 0.9),
    'metal_dark': ('metal_plate', '#3c4349', 0.72, 0.15, 0.10, 0.35, 1.3),
    'metal_light': ('metal_plate', '#d4cebf', 0.65, 0.08, 0.10, 0.35, 1.3),
    'rubber': ('metal_plate', '#1b1d1d', 0.9, 0.0, 0.0, 0.10, 1.3),
    'rust': ('rust_coarse_01', '#2a2624', 0.75, 0.10, 0.40, 0.20, 1.3),
    'roof_metal': ('metal_plate', '#b0a690', 0.75, 0.22, 0.0, 0.30, 1.3),
    'inner': ('green_metal_rust', '#4d3d30', 0.85, 0.0, 0.0, 0.0, 1.3),
    'soil': ('asphalt_02', '#5a4330', 0.75, 0.0, 0.0, 0.0, 0.5),
    'leaf': ('green_metal_rust', '#4f8a3c', 0.6, 0.0, 0.0, 0.2, 1.0),
    'leaf_light': ('green_metal_rust', '#79ad52', 0.6, 0.0, 0.0, 0.2, 1.0),
    'terracotta': ('rust_coarse_01', '#b5653c', 0.75, 0.0, 0.2, 0.25, 1.0),
}


def preview_color(kind):
    if kind.startswith('paint:'):
        return kind[6:]
    if kind == 'tram_body':
        return '#e8c87c'
    tint = KINDS[kind][1]
    return tint or {'brick': '#8a4b3a', 'cedar': '#9a6a45', 'hinoki': '#c9a679', 'wood_dark': '#4a3828'}.get(kind, '#999999')


def _image_node(nodes, path):
    node = nodes.new('ShaderNodeTexImage')
    node.image = bpy.data.images.load(path, check_existing=True)
    node.projection = 'BOX'
    node.projection_blend = 0.25
    return node


def authoring_material(kind, target):
    """Emission-only shader whose colour is the painted, weathered albedo for `kind`; baked with type EMIT."""
    mat = bpy.data.materials.get('TD_bake_' + kind) or bpy.data.materials.new('TD_bake_' + kind)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    if kind.startswith('paint:'):
        asset, tint, amount, streaks, grime, wear, scale = 'green_metal_rust', kind[6:], 1.0, 0.14, 0.25, 0.3, 1.2
    elif kind == 'tram_body':
        asset, tint, amount, streaks, grime, wear, scale = 'green_metal_rust', None, 0.0, 0.16, 0.30, 0.25, 1.3
    else:
        asset, tint, amount, streaks, grime, wear, scale = KINDS[kind]
    coords = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    links.new(coords.outputs['Object'], mapping.inputs['Vector'])
    separate = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coords.outputs['Object'], separate.inputs['Vector'])
    z = separate.outputs['Z']

    def rgb(hex_color):
        return (*kit.srgb(hex_color), 1.0)

    def mix(a, b, factor, blend='MIX'):
        node = nodes.new('ShaderNodeMix')
        node.data_type = 'RGBA'
        node.blend_type = blend
        node.clamp_factor = True
        for slot, value in (('Factor', factor), ('A', a), ('B', b)):
            if isinstance(value, (float, int, tuple)):
                node.inputs[slot].default_value = value
            else:
                links.new(value, node.inputs[slot])
        return node.outputs['Result']

    def remap(socket, lo, hi, out_lo, out_hi):
        node = nodes.new('ShaderNodeMapRange')
        node.inputs['From Min'].default_value, node.inputs['From Max'].default_value = lo, hi
        node.inputs['To Min'].default_value, node.inputs['To Max'].default_value = out_lo, out_hi
        links.new(socket, node.inputs['Value'])
        return node.outputs['Result']

    def math_node(op, a, b):
        node = nodes.new('ShaderNodeMath')
        node.operation = op
        for i, value in enumerate((a, b)):
            if isinstance(value, (float, int)):
                node.inputs[i].default_value = value
            else:
                links.new(value, node.inputs[i])
        return node.outputs['Value']

    def gray(socket):
        node = nodes.new('ShaderNodeRGBToBW')
        links.new(socket, node.inputs['Color'])
        return node.outputs['Val']

    def grey3(socket):
        combine = nodes.new('ShaderNodeCombineColor')
        for channel in ('Red', 'Green', 'Blue'):
            links.new(socket, combine.inputs[channel])
        return combine.outputs['Color']

    def detail(socket, lo=0.74, hi=1.08):
        return grey3(remap(gray(socket), 0.12, 0.4, lo, hi))

    base = _image_node(nodes, polyhaven.texture(asset)['diff'])
    links.new(mapping.outputs['Vector'], base.inputs['Vector'])
    tex = base.outputs['Color']
    if kind == 'tram_body':
        lower = mix(tex, rgb('#3f7d57'), 0.3)
        upper = mix(rgb('#e2bb63'), detail(tex), 1.0, 'MULTIPLY')
        stripe = math_node('SUBTRACT', math_node('GREATER_THAN', z, 0.555), math_node('GREATER_THAN', z, 0.585))
        pin = math_node('SUBTRACT', math_node('GREATER_THAN', z, 0.585), math_node('GREATER_THAN', z, 0.6))
        color = mix(lower, rgb('#24402f'), stripe)
        color = mix(color, rgb('#efe5c9'), pin)
        color = mix(color, upper, math_node('GREATER_THAN', z, 0.6))
        color = mix(color, grey3(remap(z, 0.15, 1.2, 0.84, 1.05)), 1.0, 'MULTIPLY')  # soft painted light from above
    elif tint is None:
        color = tex
    else:
        color = mix(tex, mix(rgb(tint), detail(tex), 1.0, 'MULTIPLY'), amount)

    # Painted light: each object darkens toward its base, like hand-painted diorama textures; then lift saturation.
    gen = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coords.outputs['Generated'], gen.inputs['Vector'])
    color = mix(color, grey3(remap(gen.outputs['Z'], 0.0, 1.0, 0.8, 1.05)), 1.0, 'MULTIPLY')
    saturate = nodes.new('ShaderNodeHueSaturation')
    saturate.inputs['Saturation'].default_value = 1.18
    links.new(color, saturate.inputs['Color'])
    color = saturate.outputs['Color']

    if streaks:
        streak = _image_node(nodes, polyhaven.texture('rusty_painted_metal')['diff'])
        links.new(mapping.outputs['Vector'], streak.inputs['Vector'])
        color = mix(color, rgb('#5a3f2a'), remap(gray(streak.outputs['Color']), 0.18, 0.05, 0.0, streaks))
    if grime:
        noise = nodes.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 6.0
        links.new(coords.outputs['Object'], noise.inputs['Vector'])
        dirt = math_node('MULTIPLY', remap(z, 0.0, 0.45, grime, 0.0), remap(noise.outputs['Fac'], 0.35, 0.65, 0.5, 1.2))
        color = mix(color, rgb('#3d3227'), dirt)
    if wear:
        geometry = nodes.new('ShaderNodeNewGeometry')
        color = mix(color, rgb('#e2d6bb'), remap(geometry.outputs['Pointiness'], 0.53, 0.6, 0.0, wear))
    ao = nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = 16
    ao.inputs['Distance'].default_value = 0.15
    color = mix(color, (0.0, 0.0, 0.0, 1.0), remap(ao.outputs['AO'], 0.0, 1.0, 0.55, 0.0))

    emission = nodes.new('ShaderNodeEmission')
    links.new(color, emission.inputs['Color'])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(emission.outputs['Emission'], output.inputs['Surface'])
    bake_node = nodes.new('ShaderNodeTexImage')
    bake_node.image = target
    nodes.active = bake_node
    return mat


def atlas_material(name, image, roughness=0.6, metallic=0.0):
    mat = bpy.data.materials.get('TD_' + name) or bpy.data.materials.new('TD_' + name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = image
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    output = nodes.new('ShaderNodeOutputMaterial')
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    return mat


def _context():
    wm = bpy.context.window_manager
    window = bpy.context.window or (wm.windows[0] if wm.windows else None)
    kw = {'scene': kit.SCENE, 'view_layer': kit.SCENE.view_layers[0]}
    if window is not None:
        kw['window'] = window
    return kw


def assign(ob, materials):
    """Fill material slots by index (clearing slots would reset face material indices)."""
    for i, mat in enumerate(materials):
        if i < len(ob.data.materials):
            ob.data.materials[i] = mat
        else:
            ob.data.materials.append(mat)


ATLASES = []


def bake_all():
    """Bake every registered atlas after the whole scene exists, so AO sees neighbouring buildings."""
    for atlas in ATLASES:
        atlas.bake()
    ATLASES.clear()


class Atlas:
    """Collects parts (object + per-slot kinds) and bakes them into one texture atlas."""

    def __init__(self, name, size=2048, roughness=0.6, metallic=0.0, register=True):
        self.name, self.size, self.roughness, self.metallic = name, size, roughness, metallic
        self.parts = []
        if register:
            ATLASES.append(self)

    def add(self, ob, *kinds):
        self.parts.append((ob, list(kinds)))
        assign(ob, [kit.material('preview_' + k.replace(':', '_').replace('#', ''), preview_color(k)) for k in kinds])
        return ob

    def bake(self):
        if not self.parts:
            return
        if FAST:
            return
        scene = kit.SCENE
        image = bpy.data.images.get(self.name)
        if image is not None:
            bpy.data.images.remove(image)
        image = bpy.data.images.new(self.name, self.size, self.size)
        kinds = {k for _, ks in self.parts for k in ks}
        authoring = {k: authoring_material(k, image) for k in kinds}
        objects = [ob for ob, _ in self.parts]
        for ob, ks in self.parts:
            assign(ob, [authoring[k] for k in ks])
        view_layer = scene.view_layers[0]
        view_layer.update()
        for ob in scene.objects:
            ob.select_set(False, view_layer=view_layer)
        for ob in objects:
            ob.select_set(True, view_layer=view_layer)
        view_layer.objects.active = objects[0]
        with bpy.context.temp_override(**_context(), active_object=objects[0], object=objects[0], selected_objects=objects, selected_editable_objects=objects):
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.003)
            bpy.ops.object.mode_set(mode='OBJECT')
            engine = scene.render.engine
            scene.render.engine = 'CYCLES'
            scene.cycles.samples = 24
            scene.render.bake.margin = 6
            bpy.ops.object.bake(type='EMIT')
            scene.render.engine = engine
        for ob in objects:
            ob.select_set(False, view_layer=view_layer)
        image.filepath_raw = os.path.join(polyhaven.CACHE, self.name.lower() + '.png')
        image.file_format = 'PNG'
        image.save()
        final = atlas_material(self.name.lower(), image, self.roughness, self.metallic)
        for ob in objects:
            assign(ob, [final] * len(ob.data.materials))
        for mat in authoring.values():
            bpy.data.materials.remove(mat)
