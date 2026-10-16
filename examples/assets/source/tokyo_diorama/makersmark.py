"""Author a gold underside signature, then bake it into the base's existing ground atlas."""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

import kit

NAME = 'Makers_Mark'
DEPTH = 0.0005


def _mesh(curve, scene):
    obj = bpy.data.objects.new(NAME + '_tmp', curve)
    scene.collection.objects.link(obj)
    layer = scene.view_layers[0]
    layer.update()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(layer.depsgraph))
    bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.curves.remove(curve)
    return mesh


def _fit(mesh, height, y):
    lo = Vector(tuple(min(v.co[i] for v in mesh.vertices) for i in range(3)))
    hi = Vector(tuple(max(v.co[i] for v in mesh.vertices) for i in range(3)))
    centre = (lo + hi) / 2
    scale = height / max(hi.y - lo.y, 1e-6)
    for vertex in mesh.vertices:
        vertex.co.x = (vertex.co.x - centre.x) * scale
        vertex.co.y = (vertex.co.y - centre.y) * scale + y
        vertex.co.z = (vertex.co.z - centre.z) * DEPTH / max(hi.z - lo.z, 1e-6)
    return mesh


def build(root, scene=None):
    """Return one downward-facing signature mesh beneath the actual Slab_Base bounds."""
    scene = scene or kit.SCENE or bpy.context.scene
    scene.view_layers[0].update()
    base = scene.objects['Slab_Base']
    corners = [base.matrix_world @ Vector(corner) for corner in base.bound_box]
    centre_x = (min(p.x for p in corners) + max(p.x for p in corners)) / 2
    centre_y = (min(p.y for p in corners) + max(p.y for p in corners)) / 2
    bottom = min(p.z for p in corners)
    existing = scene.objects.get(NAME)
    if existing:
        old_mesh = existing.data
        bpy.data.objects.remove(existing, do_unlink=True)
        if old_mesh.users == 0:
            bpy.data.meshes.remove(old_mesh)

    font_path = r'C:\Windows\Fonts\segoeprb.ttf'
    if not os.path.isfile(font_path):
        font_path = os.path.join(bpy.utils.system_resource('DATAFILES'), 'fonts', 'Noto Sans CJK Regular.woff2')
    font = bpy.data.fonts.load(font_path, check_existing=True)
    parts = []
    for body, height, y in (('Margo Engine', 0.65, 0.55), ('Made for Margie', 0.42, -0.55)):
        curve = bpy.data.curves.new(NAME + '_text', 'FONT')
        curve.body, curve.font = body, font
        curve.align_x, curve.align_y = 'CENTER', 'CENTER'
        curve.extrude, curve.resolution_u = 0.0, 2
        parts.append(_fit(_mesh(curve, scene), height, y))
    if font.users == 0:
        bpy.data.fonts.remove(font)

    # A slightly uneven, closed hand-drawn heart stroke, rather than a font glyph.
    curve = bpy.data.curves.new(NAME + '_heart', 'CURVE')
    curve.dimensions, curve.resolution_u = '3D', 8
    curve.bevel_depth, curve.bevel_resolution = 0.006, 2
    points = ((0, -0.13), (-0.065, -0.07), (-0.14, 0.025), (-0.115, 0.105),
              (-0.05, 0.125), (0, 0.07), (0.06, 0.13), (0.14, 0.075), (0.13, 0.005), (0.065, -0.075))
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for index, (point, (x, y)) in enumerate(zip(spline.bezier_points, points)):
        point.co = (x, y, 0)
        point.handle_left_type = point.handle_right_type = 'VECTOR' if index in (0, 5) else 'AUTO'
    spline.use_cyclic_u = True
    parts.append(_fit(_mesh(curve, scene), 0.3, 0.0))

    joined = bmesh.new()
    for part in parts:
        joined.from_mesh(part)
        bpy.data.meshes.remove(part)
    width = max(v.co.x for v in joined.verts) - min(v.co.x for v in joined.verts)
    height = max(v.co.y for v in joined.verts) - min(v.co.y for v in joined.verts)
    scale = min(1.0, 4.8 / max(width, 1e-6), 2.0 / max(height, 1e-6))
    for vertex in joined.verts:
        vertex.co.x *= scale
        vertex.co.y *= scale
    mesh = bpy.data.meshes.new(NAME)
    joined.to_mesh(mesh)
    joined.free()
    material = kit.material('makers_mark_ink', '#d3b879', roughness=0.65, metallic=0.05, emission='#d3b879', strength=0.6)
    mesh.materials.append(material)
    mark = bpy.data.objects.new(NAME, mesh)
    scene.collection.objects.link(mark)
    mark.parent = root
    mark.matrix_world = Matrix.Translation((centre_x, centre_y, bottom - 0.002 - DEPTH / 2)) @ Matrix.Rotation(math.pi, 4, 'X')
    return mark


def bake_into_base(scene=None):
    """Project the approved mark into only Slab_Base's bottom UV island; remove its authoring mesh."""
    from array import array

    scene = scene or kit.SCENE or bpy.context.scene
    base, mark = scene.objects['Slab_Base'], scene.objects.get(NAME)
    if mark is None:
        return {'baked': False, 'reason': 'no authoring mark'}
    layer = scene.view_layers[0]
    active = layer.objects.active
    active_name = active.name if active is not None else None
    if active is not None and active.mode != 'OBJECT':
        raise RuntimeError('Bake the maker mark in Object Mode')
    uv = base.data.uv_layers.active
    if uv is None:
        raise RuntimeError('Slab_Base must have its baked ground-atlas UVs first')
    uv.active_render = True
    normal_matrix = base.matrix_world.inverted().transposed().to_3x3()
    bottom = [face for face in base.data.polygons if (normal_matrix @ face.normal).normalized().z < -0.999]
    if not bottom:
        raise RuntimeError('Slab_Base has no downward-facing bottom polygons')
    image = bpy.data.images.get('Ground_Atlas')
    if image is None:
        raise RuntimeError('Bake Ground_Atlas before adding the maker mark')

    # Keep the original atlas for rollback; only the bottom island receives the charcoal-and-gold stamp.
    pixels = array('f', [0.0]) * len(image.pixels)
    image.pixels.foreach_get(pixels)
    snapshot = image.copy()
    snapshot.name = NAME + '_OriginalAtlas'
    snapshot.pixels.foreach_set(pixels)
    snapshot.update()
    selected = {obj.name for obj in layer.objects if obj.select_get(view_layer=layer)}
    old_materials = list(mark.data.materials)
    old_hidden = mark.hide_render
    engine, samples = scene.render.engine, scene.cycles.samples
    bake_settings = {key: getattr(scene.render.bake, key) for key in (
        'use_clear', 'use_selected_to_active', 'margin', 'cage_extrusion', 'max_ray_distance', 'use_cage')}
    objects, meshes, materials = [], [], []
    complete = False
    try:
        # The temporary active mesh contains no other atlas islands and retains every original bottom loop UV.
        indices = sorted({index for face in bottom for index in face.vertices})
        remap = {index: new for new, index in enumerate(indices)}
        target_mesh = bpy.data.meshes.new(NAME + '_BakeTarget')
        meshes.append(target_mesh)
        target_mesh.from_pydata([base.data.vertices[index].co for index in indices], [],
                               [[remap[index] for index in face.vertices] for face in bottom])
        target_uv = target_mesh.uv_layers.new(name=uv.name)
        target_uv.active_render = True
        for target_face, source_face in zip(target_mesh.polygons, bottom):
            for target_loop, source_loop in zip(target_face.loop_indices, source_face.loop_indices):
                target_uv.data[target_loop].uv = uv.data[source_loop].uv
        target = bpy.data.objects.new(NAME + '_BakeTarget', target_mesh)
        scene.collection.objects.link(target)
        target.matrix_world = base.matrix_world.copy()
        objects.append(target)
        target_material = bpy.data.materials.new(NAME + '_BakeTarget')
        target_material.use_nodes = True
        texture = target_material.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = image
        target_material.node_tree.nodes.active = texture
        target_mesh.materials.append(target_material)
        materials.append(target_material)

        background_mesh = target_mesh.copy()
        background_mesh.materials.clear()
        meshes.append(background_mesh)
        background = bpy.data.objects.new(NAME + '_BakeBackground', background_mesh)
        scene.collection.objects.link(background)
        background.matrix_world = Matrix.Translation((0, 0, -0.001)) @ base.matrix_world
        objects.append(background)

        def emission_material(name, source_image=None, color='#d3b879'):
            material = bpy.data.materials.new(name)
            material.use_nodes = True
            nodes, links = material.node_tree.nodes, material.node_tree.links
            nodes.clear()
            emission = nodes.new('ShaderNodeEmission')
            emission.inputs['Color'].default_value = (*kit.srgb(color), 1.0)
            emission.inputs['Strength'].default_value = 1.0
            if source_image is not None:
                node = nodes.new('ShaderNodeTexImage')
                node.image = source_image
                links.new(node.outputs['Color'], emission.inputs['Color'])
            output = nodes.new('ShaderNodeOutputMaterial')
            links.new(emission.outputs['Emission'], output.inputs['Surface'])
            materials.append(material)
            return material

        background_mesh.materials.append(emission_material(NAME + '_BakeBackground', color='#17130f'))
        # Bake the ink colour at unit strength; the final underside material supplies the approved 0.6 emission.
        mark.data.materials.clear()
        mark.data.materials.append(emission_material(NAME + '_BakeInk'))
        mark.hide_render = False
        for obj in layer.objects:
            obj.select_set(False, view_layer=layer)
        for obj in (background, mark, target):
            obj.select_set(True, view_layer=layer)
        layer.objects.active = target
        layer.update()
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = 8
        context = {'scene': scene, 'view_layer': layer, 'active_object': target, 'object': target,
                   'selected_objects': [background, mark, target], 'selected_editable_objects': [background, mark, target]}
        if bpy.context.window is not None:
            context['window'] = bpy.context.window
        with bpy.context.temp_override(**context):
            bpy.ops.object.bake(type='EMIT', use_selected_to_active=True, use_clear=False, margin=0,
                                use_cage=False, cage_extrusion=0.01, max_ray_distance=0.02)
        image.update()
        if image.filepath:
            image.save()
            if image.packed_file is not None:
                # Saving refreshes the PNG, but an existing packed payload can still contain the old atlas.
                # Reload the new disk image before repacking so glTF exports the newly baked pixels.
                image.unpack(method='REMOVE')
                image.reload()
                image.pack()

        # One extra material primitive on the existing base, sharing the same atlas for colour and emission.
        material = kit.material('makers_mark_baked', '#ffffff', roughness=0.65, metallic=0.05,
                                emission='#ffffff', strength=0.6)
        nodes, links = material.node_tree.nodes, material.node_tree.links
        shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
        texture = next((node for node in nodes if node.type == 'TEX_IMAGE'), None) or nodes.new('ShaderNodeTexImage')
        texture.image = image
        links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        links.new(texture.outputs['Color'], shader.inputs['Emission Color'])
        slot = next((index for index, item in enumerate(base.data.materials) if item == material), None)
        if slot is None:
            slot = len(base.data.materials)
            base.data.materials.append(material)
        for face in bottom:
            face.material_index = slot
        mark_mesh = mark.data
        bpy.data.objects.remove(mark, do_unlink=True)
        if mark_mesh.users == 0:
            bpy.data.meshes.remove(mark_mesh)
        complete = True
        return {'baked': True, 'image': image.name, 'bottom_faces': len(bottom), 'material': material.name}
    finally:
        if not complete:
            image.pixels.foreach_set(pixels)
            image.update()
            live_mark = scene.objects.get(NAME)
            if live_mark is not None:
                live_mark.data.materials.clear()
                for material in old_materials:
                    live_mark.data.materials.append(material)
                live_mark.hide_render = old_hidden
        scene.render.engine, scene.cycles.samples = engine, samples
        for key, value in bake_settings.items():
            setattr(scene.render.bake, key, value)
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        for mesh in meshes:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        for material in materials:
            if material.users == 0:
                bpy.data.materials.remove(material)
        bpy.data.images.remove(snapshot)
        for obj in layer.objects:
            obj.select_set(obj.name in selected, view_layer=layer)
        layer.objects.active = scene.objects.get(active_name) if active_name else None
        if layer.objects.active is None:
            layer.objects.active = base
