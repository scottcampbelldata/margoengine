"""Static evaluated meshes and the supported Principled BSDF subset."""
from array import array
import hashlib
import math
import uuid

import bpy
import numpy as np
from mathutils import Matrix, Vector
from .writer import png, write


def export_scene(context, path):
    # Blender Z-up to Margo/glTF Y-up; a proper rotation preserves winding.
    basis = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    nodes, geometry, materials, textures, images, samplers = [], [], [], [], [], []
    material_ids, texture_ids, mesh_ids, mesh_cache = {}, {}, {}, {}

    def failure(material, detail):
        raise ValueError(f"Material '{material.name}': {detail}")

    def pixels(image):
        width, height = image.size
        if not 0 < width <= 4096 or not 0 < height <= 4096:
            raise ValueError(f"Image '{image.name}' exceeds 4096 x 4096 or has no pixels")
        if image.source not in {"FILE", "GENERATED"} or image.channels != 4:
            raise ValueError(f"Image '{image.name}': only static RGBA images are supported")
        values = array("f", [0]) * (width * height * 4)
        image.pixels.foreach_get(values)
        if any(not math.isfinite(v) for v in values):
            raise ValueError(f"Image '{image.name}': non-finite pixels")
        return width, height, values

    def texture(image, node, color=False):
        color_space = image.colorspace_settings.name
        if color and color_space != "sRGB" or not color and color_space not in {"Non-Color", "Raw"}:
            raise ValueError(f"Image '{image.name}': use {'sRGB' if color else 'Non-Color'} color space")
        key = (image.as_pointer(), node.extension, node.interpolation, color)
        if key in texture_ids:
            return texture_ids[key]
        if node.extension not in {"REPEAT", "EXTEND"} or node.interpolation not in {"Linear", "Closest"}:
            raise ValueError(f"Image '{image.name}': unsupported wrapping/filtering")
        width, height, values = pixels(image)
        rgba = bytearray(width * height * 4)
        for y in range(height):
            for x in range(width):
                for c in range(4):
                    value = values[((height - 1 - y) * width + x) * 4 + c]
                    if value < -1e-5 or value > 1.00001:
                        raise ValueError(f"Image '{image.name}': HDR textures are unsupported")
                    rgba[(y * width + x) * 4 + c] = round(min(1, max(0, value)) * 255)
        image_id = len(images)
        images.append(png(width, height, rgba))
        wrap = 10497 if node.extension == "REPEAT" else 33071
        filtering = 9728 if node.interpolation == "Closest" else 9729
        sampler = len(samplers)
        samplers.append({"wrapS": wrap, "wrapT": wrap, "magFilter": filtering, "minFilter": filtering})
        texture_ids[key] = len(textures)
        textures.append({"source": image_id, "sampler": sampler})
        return texture_ids[key]

    def image_node(material, socket):
        if len(socket.links) != 1:
            failure(material, f"unsupported links on {socket.name}")
        link = socket.links[0]
        node = link.from_node
        if node.type != "TEX_IMAGE" or not node.image or node.projection != "FLAT" or link.from_socket.name != "Color":
            failure(material, f"{socket.name} must use a direct Image Texture Color output")
        vector = node.inputs["Vector"]
        if vector.is_linked:
            source = vector.links[0]
            if source.from_node.type != "TEX_COORD" or source.from_socket.name != "UV":
                failure(material, "texture mapping must use the active UV map")
        return node

    def material_id(material):
        key = (material.name_full, material.library.filepath if material.library else "") if material else None
        if key in material_ids:
            return material_ids[key]
        result = {"doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.8, 1], "metallicFactor": 0, "roughnessFactor": 0.5}}
        if material:
            if bpy.app.version < (5, 0, 0) and not material.use_nodes:
                failure(material, "enable nodes and use Principled BSDF")
            outputs = [n for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output]
            if len(outputs) != 1 or not outputs[0].inputs["Surface"].is_linked:
                failure(material, "missing active surface output")
            output = outputs[0]
            shader = output.inputs["Surface"].links[0].from_node
            if shader.type != "BSDF_PRINCIPLED" or output.inputs["Volume"].is_linked or output.inputs["Displacement"].is_linked:
                failure(material, "only a direct Principled surface without volume/displacement is supported")
            supported = {"Base Color", "Metallic", "Roughness", "Alpha", "Normal", "Emission Color", "Emission Strength"}
            defaults = {"IOR": 1.5, "Transmission Weight": 0, "Coat Weight": 0, "Sheen Weight": 0, "Subsurface Weight": 0, "Anisotropic IOR Level": 0, "Specular IOR Level": 0.5, "Specular Tint": (1, 1, 1, 1), "Coat Tint": (1, 1, 1, 1)}
            for socket in shader.inputs:
                if socket.is_linked and socket.name not in supported:
                    failure(material, f"unsupported linked input {socket.name}")
                if socket.name in defaults:
                    expected = defaults[socket.name]
                    value = socket.default_value
                    matches = abs(value - expected) < 1e-5 if isinstance(expected, (int, float)) else all(abs(a - b) < 1e-5 for a, b in zip(value, expected))
                    if not matches:
                        failure(material, f"unsupported {socket.name}; expected {expected}")
            pbr = result["pbrMetallicRoughness"]
            base = shader.inputs["Base Color"]
            # Principled RGB is linear; viewport diffuse_color can differ on CAD materials.
            pbr["baseColorFactor"] = list(base.default_value)
            pbr["baseColorFactor"][3] = shader.inputs["Alpha"].default_value
            for name, factor_key in (("Metallic", "metallicFactor"), ("Roughness", "roughnessFactor")):
                socket = shader.inputs[name]
                if socket.is_linked:
                    failure(material, f"textured {name} requires baking to a packed metallic-roughness map; v1 exports constants")
                pbr[factor_key] = socket.default_value
            if base.is_linked:
                node = image_node(material, base)
                pbr["baseColorTexture"] = {"index": texture(node.image, node, color=True)}
                pbr["baseColorFactor"][:3] = [1, 1, 1]
            alpha = shader.inputs["Alpha"]
            if alpha.is_linked:
                link = alpha.links[0]
                if not base.is_linked or link.from_node != base.links[0].from_node or link.from_socket.name != "Alpha":
                    failure(material, "Alpha must come from the base color image")
                pbr["baseColorFactor"][3] = 1
            if alpha.is_linked or pbr["baseColorFactor"][3] < 1:
                result["alphaMode"] = "BLEND"
            normal = shader.inputs["Normal"]
            if normal.is_linked:
                normal_node = normal.links[0].from_node
                if normal_node.type != "NORMAL_MAP" or normal_node.space != "TANGENT" or normal_node.uv_map or normal_node.inputs["Strength"].is_linked:
                    failure(material, "Normal requires tangent-space Normal Map using the active UV map")
                image = image_node(material, normal_node.inputs["Color"])
                result["normalTexture"] = {"index": texture(image.image, image), "scale": normal_node.inputs["Strength"].default_value}
            emission = shader.inputs["Emission Color"]
            strength = shader.inputs["Emission Strength"]
            if strength.is_linked:
                failure(material, "Emission Strength must be constant")
            factor = [v * strength.default_value for v in emission.default_value[:3]]
            if emission.is_linked:
                node = image_node(material, emission)
                result["emissiveTexture"] = {"index": texture(node.image, node, color=True)}
                factor = [strength.default_value] * 3
            if any(v < 0 or v > 1 for v in factor):
                failure(material, "HDR emission is unsupported; emissive factors must be in [0,1]")
            result["emissiveFactor"] = factor
            result["name"] = material.name
        for value in result["pbrMetallicRoughness"]["baseColorFactor"] + [result["pbrMetallicRoughness"]["metallicFactor"], result["pbrMetallicRoughness"]["roughnessFactor"]]:
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("PBR material factors must be finite and in [0,1]")
        material_ids[key] = len(materials)
        materials.append(result)
        return material_ids[key]

    depsgraph = context.evaluated_depsgraph_get()
    unit_scale = context.scene.unit_settings.scale_length
    inverse_basis = basis.inverted()
    for instance in depsgraph.object_instances:
        obj = instance.object
        visible = instance.parent.original if instance.is_instance and instance.parent else obj.original
        if obj.type != "MESH" or not instance.show_self or not visible.visible_get(view_layer=context.view_layer):
            continue
        slots = tuple(slot.material for slot in obj.material_slots)
        cache_key = (obj.data.name, tuple(mat.as_pointer() if mat else None for mat in slots))
        # Evaluated data pointers distinguish modifiers and linked libraries with the same mesh name.
        data_key = obj.data.as_pointer()
        cached = mesh_cache.setdefault(cache_key, {})
        mesh_index = cached.get(data_key)
        if mesh_index is None:
            mesh = obj.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
            try:
                mesh.calc_loop_triangles()
                if not mesh.loop_triangles:
                    continue
                if len(mesh.loop_triangles) > 1_000_000:
                    raise ValueError(f"Object '{obj.name}': too many triangles")
                uv_layer = mesh.uv_layers.active
                if uv_layer:
                    mesh.calc_tangents(uvmap=uv_layer.name)
                stride = 24 if not uv_layer and not mesh.color_attributes else 80
                triangle_loops = np.empty(len(mesh.loop_triangles) * 3, dtype=np.int32)
                triangle_materials = np.empty(len(mesh.loop_triangles), dtype=np.int32)
                loop_vertices = np.empty(len(mesh.loops), dtype=np.int32)
                coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
                normals = np.empty(len(mesh.loops) * 3, dtype=np.float32)
                mesh.loop_triangles.foreach_get("loops", triangle_loops)
                mesh.loop_triangles.foreach_get("material_index", triangle_materials)
                mesh.loops.foreach_get("vertex_index", loop_vertices)
                mesh.vertices.foreach_get("co", coordinates)
                mesh.loops.foreach_get("normal", normals)
                coordinates = coordinates.reshape(-1, 3)[:, (0, 2, 1)]
                coordinates[:, 2] *= -1
                coordinates *= unit_scale
                normals = normals.reshape(-1, 3)[:, (0, 2, 1)]
                normals[:, 2] *= -1
                # CAD tessellation can carry invalid corner normals; export those as +Y.
                with np.errstate(over="ignore", invalid="ignore"):
                    lengths = np.einsum("ij,ij->i", normals, normals)
                valid = np.isfinite(normals).all(axis=1) & np.isfinite(lengths) & (lengths >= 1e-6)
                normals[valid] /= np.sqrt(lengths[valid])[:, None]
                normals[~valid] = (0, 1, 0)
                values = np.zeros((len(mesh.loops), stride // 4), dtype="<f4")
                values[:, :3] = coordinates[loop_vertices]
                values[:, 3:6] = normals if stride == 24 else 0
                if stride == 80:
                    values[:, 3] = 1
                    values[:, 4:7] = normals
                    values[:, 16:20] = 1
                    if uv_layer:
                        tangents = np.empty(len(mesh.loops) * 3, dtype=np.float32)
                        signs = np.empty(len(mesh.loops), dtype=np.float32)
                        uv = np.empty(len(mesh.loops) * 2, dtype=np.float32)
                        mesh.loops.foreach_get("tangent", tangents)
                        mesh.loops.foreach_get("bitangent_sign", signs)
                        uv_layer.data.foreach_get("uv", uv)
                        values[:, 8:11] = tangents.reshape(-1, 3)[:, (0, 2, 1)]
                        values[:, 10] *= -1
                        values[:, 11] = signs
                        values[:, 12:14] = uv.reshape(-1, 2)
                        values[:, 13] = 1 - values[:, 13]
                if not np.isfinite(values).all():
                    raise ValueError(f"Object '{obj.name}': invalid vertex")
                triangle_loops = triangle_loops.reshape(-1, 3)
                primitives = []
                for slot in np.unique(triangle_materials):
                    corners = values[triangle_loops[triangle_materials == slot].ravel()]
                    _, first, inverse = np.unique(corners.view(f"V{stride}").ravel(), return_index=True, return_inverse=True)
                    order = np.argsort(first)
                    remap = np.empty(len(first), dtype="<u4")
                    remap[order] = np.arange(len(first), dtype=np.uint32)
                    vertices = corners[first[order]]
                    mat = slots[slot] if slot < len(slots) else None
                    mid = material_id(mat)
                    if materials[mid].get("pbrMetallicRoughness", {}).get("baseColorTexture") or materials[mid].get("normalTexture") or materials[mid].get("emissiveTexture"):
                        if not uv_layer:
                            raise ValueError(f"Object '{obj.name}': textured material requires an active UV map")
                    bounds = vertices[:, :3].min(axis=0).tolist() + vertices[:, :3].max(axis=0).tolist()
                    primitives.append({"vertices": vertices.tobytes(), "indices": remap[inverse].tobytes(), "material": mid, "stride": stride, "bounds": bounds})
                digest = tuple((hashlib.sha256(p["vertices"] + p["indices"]).digest(), p["material"], p["stride"]) for p in primitives)
                if digest not in mesh_ids:
                    mesh_ids[digest] = len(geometry)
                    geometry.append(primitives)
                mesh_index = mesh_ids[digest]
                cached[data_key] = mesh_index
            finally:
                obj.to_mesh_clear()
        world = basis @ instance.matrix_world @ inverse_basis
        world.translation *= unit_scale
        translation, rotation, scale = world.decompose()
        rebuilt = Matrix.LocRotScale(translation, rotation, scale)
        if any(abs(world[r][c] - rebuilt[r][c]) > 1e-4 * max(1, abs(world[r][c])) for r in range(4) for c in range(4)) or any(abs(v) < 1e-8 for v in scale):
            raise ValueError(f"Object '{obj.name}': shear/singular transforms must be applied before export")
        identity = f"{obj.original.library.filepath if obj.original.library else ''}:{obj.original.name_full}:{tuple(instance.persistent_id) if instance.is_instance else ''}"
        properties = {}
        for key in obj.original.keys():
            if not key.startswith("margo:"):
                continue
            value = obj.original[key]
            if hasattr(value, "to_list"):
                value = value.to_list()
            if isinstance(value, list):
                if len(value) > 32 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value):
                    raise ValueError(f"Object '{obj.name}': '{key}' requires at most 32 finite numbers")
            elif not isinstance(value, (str, bool, int, float)) or isinstance(value, (int, float)) and not math.isfinite(value):
                raise ValueError(f"Object '{obj.name}': unsupported custom property '{key}'")
            properties[key] = value
        nodes.append({"name": obj.original.name_full, "mesh": mesh_index, "translation": list(translation), "rotation": [rotation.x, rotation.y, rotation.z, rotation.w], "scale": list(scale), "extras": {"margo": {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)), "properties": properties}}})
    if not nodes:
        raise ValueError("No visible mesh triangles to export")
    if len(nodes) > 100_000:
        raise ValueError("Too many exported objects")
    document = {"nodes": nodes, "materials": materials, "textures": textures, "samplers": samplers, "scenes": [{"nodes": list(range(len(nodes)))}], "scene": 0}
    return write(path, document, geometry, images)
