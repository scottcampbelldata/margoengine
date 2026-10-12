"""Static evaluated meshes and the supported Principled BSDF subset."""
from array import array
import hashlib
import math
import struct
import sys
import uuid

import bpy
from mathutils import Matrix, Vector
from .writer import png, write


def export_scene(context, path):
    # Blender Z-up to Margo/glTF Y-up; a proper rotation preserves winding.
    basis = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    nodes, geometry, materials, textures, images, samplers = [], [], [], [], [], []
    material_ids, texture_ids, mesh_ids = {}, {}, {}

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
            pbr["baseColorFactor"] = list(shader.inputs["Base Color"].default_value)
            pbr["baseColorFactor"][3] = shader.inputs["Alpha"].default_value
            for name, factor_key in (("Metallic", "metallicFactor"), ("Roughness", "roughnessFactor")):
                socket = shader.inputs[name]
                if socket.is_linked:
                    failure(material, f"textured {name} requires baking to a packed metallic-roughness map; v1 exports constants")
                pbr[factor_key] = socket.default_value
            base = shader.inputs["Base Color"]
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
    rotation_basis = basis.to_3x3()
    inverse_basis = basis.inverted()
    for instance in depsgraph.object_instances:
        obj = instance.object
        visible = instance.parent.original if instance.is_instance and instance.parent else obj.original
        if obj.type != "MESH" or not instance.show_self or not visible.visible_get(view_layer=context.view_layer):
            continue
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
            parts = {}
            for triangle in mesh.loop_triangles:
                part = parts.setdefault(triangle.material_index, {"vertices": bytearray(), "indices": array("I"), "shared": {}, "min": [math.inf] * 3, "max": [-math.inf] * 3})
                for loop_id in triangle.loops:
                    loop = mesh.loops[loop_id]
                    position = rotation_basis @ mesh.vertices[loop.vertex_index].co * unit_scale
                    normal = (rotation_basis @ mesh.corner_normals[loop_id].vector).normalized()
                    tangent = rotation_basis @ loop.tangent if uv_layer else Vector((0, 0, 0))
                    uv = uv_layer.data[loop_id].uv if uv_layer else (0, 0)
                    values = (*position, 1, *normal, 0, *tangent, loop.bitangent_sign if uv_layer else 0, uv[0], 1 - uv[1], 0, 0, 1, 1, 1, 1)
                    if not all(math.isfinite(v) for v in values) or normal.length < 0.5:
                        raise ValueError(f"Object '{obj.name}': invalid vertex/normal")
                    packed = struct.pack("<20f", *values)
                    if packed not in part["shared"]:
                        part["shared"][packed] = len(part["vertices"]) // 80
                        part["vertices"].extend(packed)
                    part["indices"].append(part["shared"][packed])
                    for axis in range(3):
                        part["min"][axis] = min(part["min"][axis], position[axis])
                        part["max"][axis] = max(part["max"][axis], position[axis])
            primitives = []
            for slot, part in sorted(parts.items()):
                mat = mesh.materials[slot] if slot < len(mesh.materials) else None
                mid = material_id(mat)
                if materials[mid].get("pbrMetallicRoughness", {}).get("baseColorTexture") or materials[mid].get("normalTexture") or materials[mid].get("emissiveTexture"):
                    if not uv_layer:
                        raise ValueError(f"Object '{obj.name}': textured material requires an active UV map")
                if sys.byteorder != "little":
                    part["indices"].byteswap()
                primitives.append({"vertices": bytes(part["vertices"]), "indices": part["indices"].tobytes(), "material": mid, "bounds": part["min"] + part["max"]})
            digest = tuple((hashlib.sha256(p["vertices"] + p["indices"]).digest(), p["material"]) for p in primitives)
            if digest not in mesh_ids:
                mesh_ids[digest] = len(geometry)
                geometry.append(primitives)
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
            nodes.append({"name": obj.original.name_full, "mesh": mesh_ids[digest], "translation": list(translation), "rotation": [rotation.x, rotation.y, rotation.z, rotation.w], "scale": list(scale), "extras": {"margo": {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)), "properties": properties}}})
        finally:
            obj.to_mesh_clear()
    if not nodes:
        raise ValueError("No visible mesh triangles to export")
    if len(nodes) > 100_000:
        raise ValueError("Too many exported objects")
    document = {"nodes": nodes, "materials": materials, "textures": textures, "samplers": samplers, "scenes": [{"nodes": list(range(len(nodes)))}], "scene": 0}
    return write(path, document, geometry, images)
