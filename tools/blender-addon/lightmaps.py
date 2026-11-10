"""Cycles diffuse lighting on UV1; temporary meshes and bake targets never persist in the user's scene."""
from contextlib import contextmanager
import bpy
import numpy as np


@contextmanager
def lightmaps(context, size):
    if not isinstance(size, int) or not 16 <= size <= 4096:
        raise ValueError("lightmap_size must be 0 (off) or an integer 16 to 4096")
    scene = context.scene
    selected = [o for o in context.view_layer.objects if o.select_get()]
    active = context.view_layer.objects.active
    engine, device = scene.render.engine, scene.cycles.device
    originals, targets, records = [], [], {}
    try:
        scene.render.engine, scene.cycles.device = "CYCLES", "CPU"
        for obj in context.view_layer.objects:
            if obj.type != "MESH" or not obj.visible_get(view_layer=context.view_layer) or not obj.data.polygons:
                continue
            if obj.mode != "OBJECT":
                raise ValueError(f"Object '{obj.name}': lightmap baking needs Object Mode")
            mesh = obj.data.copy()
            originals.append((obj, obj.data, mesh))
            obj.data = mesh
            for other in context.view_layer.objects:
                other.select_set(False)
            obj.select_set(True)
            context.view_layer.objects.active = obj
            # UV0 remains the artist's material unwrap; a separate non-overlapping chart map carries illumination.
            if not mesh.uv_layers:
                mesh.uv_layers.new(name="UVMap")
            if len(mesh.uv_layers) < 2:
                mesh.uv_layers.new(name="MargoLightmap")
                mesh.uv_layers.active_index = 1
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.uv.smart_project(island_margin=4 / size)
                bpy.ops.object.mode_set(mode="OBJECT")
            mesh.uv_layers.active_index = 0
            # UV0 remains active for shading; bake's explicit uv_layer selects UV1 only for rasterisation.
            image = bpy.data.images.new("MargoLightmap", size, size, alpha=True, float_buffer=True)
            image.colorspace_settings.name = "Non-Color"
            targets.append(image)
            temporary = []
            try:
                for slot in obj.material_slots:
                    material = slot.material
                    if not material or not material.use_nodes:
                        raise ValueError(f"Object '{obj.name}': lightmap baking needs node materials in every slot")
                    tree = material.node_tree
                    previous = tree.nodes.active
                    node = tree.nodes.new("ShaderNodeTexImage")
                    node.image = image
                    tree.nodes.active = node
                    temporary.append((tree, node, previous))
                if not temporary:
                    raise ValueError(f"Object '{obj.name}': lightmap baking needs a material")
                bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer=mesh.uv_layers[1].name, margin=4, use_clear=True)
                pixels = np.empty(size * size * 4, dtype=np.float32)
                image.pixels.foreach_get(pixels)
                pixels = pixels.reshape(size, size, 4)
                if not np.isfinite(pixels).all() or (pixels[..., :3] < 0).any():
                    raise ValueError(f"Object '{obj.name}': Cycles lightmap contains invalid lighting")
                pixels[..., :3] *= np.pi  # Cycles colour-free diffuse bake is irradiance / pi.
                records[obj.as_pointer()] = pixels
            finally:
                for tree, node, previous in reversed(temporary):
                    tree.nodes.remove(node)
                    tree.nodes.active = previous
        yield records
    finally:
        for obj, original, mesh in originals:
            if obj.mode != "OBJECT":
                context.view_layer.objects.active = obj
                bpy.ops.object.mode_set(mode="OBJECT")
            obj.data = original
            bpy.data.meshes.remove(mesh)
        for image in targets:
            bpy.data.images.remove(image)
        scene.render.engine, scene.cycles.device = engine, device
        for obj in context.view_layer.objects:
            obj.select_set(obj in selected)
        context.view_layer.objects.active = active
