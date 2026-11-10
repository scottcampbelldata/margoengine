"""Static evaluated meshes, the direct Principled BSDF subset and baked node materials."""
from array import array
import hashlib
import math
import uuid

import bpy
import numpy as np
from mathutils import Matrix, Vector
from .animation import animated, export_animated
from .bake import bake_material, principled
from .curves import KINDS, GeometryData, read_object
from .writer import png, write


class NeedsBake(ValueError):
    """A node graph the direct Principled subset cannot carry; baking turns it into images."""


def export_scene(context, path, bake_size=1024, lights_cameras=True, curves=False, object_animation=False):
    """Writes the visible scene to `path` and returns the file size. Materials outside the direct Principled subset
    (procedural node graphs, textured metallic or roughness, other shaders) are baked with Cycles to bake_size x
    bake_size images on each object's active UV map; bake_size=0 turns baking off, so they fail by name instead.
    lights_cameras writes visible point, spot and sun lights and cameras as nodes with `margo:` light and camera tags,
    which @margoengine/blender/components builds; False leaves them out as before. curves writes visible curves
    objects as splines, point clouds as points and volumes as OpenVDB grids (header flag 2), which
    @margoengine/blender/curves reads; False leaves them out as before."""
    if bake_size and not 16 <= bake_size <= 4096:
        raise ValueError("bake_size must be 0 (off) or 16 to 4096 pixels")
    # Blender Z-up to Margo/glTF Y-up; a proper rotation preserves winding.
    basis = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))
    nodes, geometry, materials, textures, images, samplers = [], [], [], [], [], []
    material_ids, texture_ids, mesh_ids, mesh_cache = {}, {}, {}, {}
    baked = {}  # (material key, original mesh name) -> bake_material() result

    def failure(material, detail, bake=False):
        hint = "; it needs baking, so export with baking on" if bake else ""
        raise (NeedsBake if bake else ValueError)(f"Material '{material.name}': {detail}{hint}")

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

    def texture(image, node, color=False, dry=False):
        """The texture index of an image node's image; `dry` only validates (for the bake pre-pass)."""
        color_space = image.colorspace_settings.name
        if color and color_space != "sRGB" or not color and color_space not in {"Non-Color", "Raw"}:
            raise ValueError(f"Image '{image.name}': use {'sRGB' if color else 'Non-Color'} color space")
        key = (image.as_pointer(), node.extension, node.interpolation, color)
        if key in texture_ids:
            return texture_ids[key]
        if node.extension not in {"REPEAT", "EXTEND"} or node.interpolation not in {"Linear", "Closest"}:
            raise ValueError(f"Image '{image.name}': unsupported wrapping/filtering")
        if dry:
            return -1
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

    def baked_texture(values, color):
        """An embedded PNG of a baked float image (Blender's bottom-up rows), sRGB-encoded when it holds colour."""
        height, width = values.shape[:2]
        rgba = np.clip(values[::-1], 0, 1)
        if color:
            rgb = rgba[..., :3]
            rgba[..., :3] = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
        images.append(png(width, height, np.round(rgba * 255).astype(np.uint8).tobytes()))
        samplers.append({"wrapS": 10497, "wrapT": 10497, "magFilter": 9729, "minFilter": 9729})
        textures.append({"source": len(images) - 1, "sampler": len(samplers) - 1})
        return len(textures) - 1

    def image_node(material, socket):
        if len(socket.links) != 1:
            failure(material, f"unsupported links on {socket.name}")
        link = socket.links[0]
        node = link.from_node
        if node.type != "TEX_IMAGE" or not node.image or node.projection != "FLAT" or link.from_socket.name != "Color":
            failure(material, f"{socket.name} must use a direct Image Texture Color output", bake=True)
        vector = node.inputs["Vector"]
        if vector.is_linked:
            source = vector.links[0]
            if source.from_node.type != "TEX_COORD" or source.from_socket.name != "UV":
                failure(material, "texture mapping must use the active UV map", bake=True)
        return node

    def material_key(material):
        return (material.name_full, material.library.filepath if material.library else "") if material else None

    def direct(material, dry=False):
        """The glTF material of a direct Principled BSDF; raises NeedsBake for a node graph it cannot carry."""
        result = {"doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.8, 1], "metallicFactor": 0, "roughnessFactor": 0.5}}
        if not material:
            return result
        if bpy.app.version < (5, 0, 0) and not material.use_nodes:
            failure(material, "enable nodes and use Principled BSDF")
        outputs = [n for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output]
        if len(outputs) != 1 or not outputs[0].inputs["Surface"].is_linked:
            failure(material, "missing active surface output")
        output = outputs[0]
        shader = output.inputs["Surface"].links[0].from_node
        if output.inputs["Volume"].is_linked or output.inputs["Displacement"].is_linked:
            failure(material, "only a surface without volume/displacement is supported")
        if shader.type != "BSDF_PRINCIPLED":
            failure(material, f"the surface is a {shader.bl_label} node, not a direct Principled BSDF", bake=True)
        supported = {"Base Color", "Metallic", "Roughness", "Alpha", "Normal", "Emission Color", "Emission Strength"}
        # Transmission, IOR, coat, sheen and subsurface map to glTF material extensions (extended() below).
        defaults = {"Anisotropic IOR Level": 0, "Specular IOR Level": 0.5, "Specular Tint": (1, 1, 1, 1)}
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
        # Principled RGB is linear; viewport diffuse_color can differ on imported materials.
        pbr["baseColorFactor"] = list(base.default_value)
        pbr["baseColorFactor"][3] = shader.inputs["Alpha"].default_value
        for name, factor_key in (("Metallic", "metallicFactor"), ("Roughness", "roughnessFactor")):
            socket = shader.inputs[name]
            if socket.is_linked:
                failure(material, f"textured {name} needs a packed metallic-roughness map", bake=True)
            pbr[factor_key] = socket.default_value
        if base.is_linked:
            node = image_node(material, base)
            pbr["baseColorTexture"] = {"index": texture(node.image, node, color=True, dry=dry)}
            pbr["baseColorFactor"][:3] = [1, 1, 1]
        alpha = shader.inputs["Alpha"]
        if alpha.is_linked:
            link = alpha.links[0]
            if not base.is_linked or link.from_node != base.links[0].from_node or link.from_socket.name != "Alpha":
                failure(material, "Alpha must come from the base color image", bake=True)
            pbr["baseColorFactor"][3] = 1
        if alpha.is_linked or pbr["baseColorFactor"][3] < 1:
            result["alphaMode"] = "BLEND"
        normal = shader.inputs["Normal"]
        if normal.is_linked:
            normal_node = normal.links[0].from_node
            if normal_node.type != "NORMAL_MAP" or normal_node.space != "TANGENT" or normal_node.uv_map or normal_node.inputs["Strength"].is_linked:
                failure(material, "Normal requires tangent-space Normal Map using the active UV map", bake=True)
            image = image_node(material, normal_node.inputs["Color"])
            result["normalTexture"] = {"index": texture(image.image, image, dry=dry), "scale": normal_node.inputs["Strength"].default_value}
        emission = shader.inputs["Emission Color"]
        strength = shader.inputs["Emission Strength"]
        if strength.is_linked:
            failure(material, "Emission Strength must be constant", bake=True)
        factor = [v * strength.default_value for v in emission.default_value[:3]]
        if emission.is_linked:
            node = image_node(material, emission)
            result["emissiveTexture"] = {"index": texture(node.image, node, color=True, dry=dry)}
            factor = [strength.default_value] * 3
        if any(v < 0 or v > 1 for v in factor):
            failure(material, "HDR emission is unsupported; emissive factors must be in [0,1]")
        result["emissiveFactor"] = factor
        extensions = extended(material, shader)
        if extensions:
            result["extensions"] = extensions
        result["name"] = material.name
        return result

    def extended(material, shader):
        """The glTF material extensions of a Principled BSDF's transmission, IOR, coat, sheen and subsurface (constants;
        a linked input of these already failed). Blender's Principled BSDF and glTF's extensions share one model: the
        same IOR, a transmission weight, a coat layer of IOR 1.5, a sheen tint and roughness. Subsurface becomes
        diffuse transmission into a scattering volume (KHR_materials_volume_scatter, a draft): the base colour is the
        multiple-scattering albedo and the radius, times the scale, each channel's mean free path."""
        value = lambda name: shader.inputs[name].default_value
        result = {}
        ior = value("IOR")
        if not 1 <= ior <= 10:
            failure(material, "IOR must be between 1 and 10")
        if abs(ior - 1.5) > 1e-5:
            result["KHR_materials_ior"] = {"ior": ior}
        if value("Transmission Weight") > 0:
            result["KHR_materials_transmission"] = {"transmissionFactor": value("Transmission Weight")}
        if value("Coat Weight") > 0:
            if abs(value("Coat IOR") - 1.5) > 1e-5 or any(abs(c - 1) > 1e-5 for c in value("Coat Tint")[:3]):
                failure(material, "a coat needs Coat IOR 1.5 and a white Coat Tint, as glTF's clearcoat has")
            if shader.inputs["Coat Normal"].is_linked:
                failure(material, "a coat normal map is unsupported; the coat uses the surface normal")
            result["KHR_materials_clearcoat"] = {"clearcoatFactor": value("Coat Weight"), "clearcoatRoughnessFactor": value("Coat Roughness")}
        if value("Sheen Weight") > 0:
            weight = value("Sheen Weight")
            result["KHR_materials_sheen"] = {"sheenColorFactor": [min(1, c * weight) for c in value("Sheen Tint")[:3]], "sheenRoughnessFactor": value("Sheen Roughness")}
        if value("Subsurface Weight") > 0:
            radius = [r * value("Subsurface Scale") * unit_scale for r in value("Subsurface Radius")]
            if min(radius) <= 0:
                failure(material, "subsurface needs a positive radius and scale in every channel")
            # One attenuation distance d with colours exp(-d / r) gives each channel extinction 1 / r.
            distance = max(radius)
            albedo = list(value("Base Color"))[:3]
            result["KHR_materials_diffuse_transmission"] = {"diffuseTransmissionFactor": value("Subsurface Weight"), "diffuseTransmissionColorFactor": albedo}
            result["KHR_materials_volume"] = {"thicknessFactor": distance, "attenuationDistance": distance, "attenuationColor": [math.exp(-distance / r) for r in radius]}
            result["KHR_materials_volume_scatter"] = {"multiscatterColorFactor": albedo, "scatterAnisotropy": value("Subsurface Anisotropy")}
        return result

    needs = {}

    def needs_baking(material):
        """True when only baking can export `material`; any other error is left for the export itself to raise."""
        key = material_key(material)
        if key not in needs:
            try:
                direct(material, dry=True)
                needs[key] = False
            except NeedsBake:
                needs[key] = True
            except ValueError:
                needs[key] = False
        return needs[key]

    def baked_material(material, bake):
        """The glTF material of a bake_material() result: its images as embedded textures, its constants as factors."""
        factors = bake["factors"]
        pbr = {"baseColorFactor": list(factors["base"]), "metallicFactor": factors["metallic"], "roughnessFactor": factors["roughness"]}
        result = {"doubleSided": True, "pbrMetallicRoughness": pbr, "emissiveFactor": list(factors["emissive"]), "name": material.name}
        if bake["base"] is not None:
            pbr["baseColorTexture"] = {"index": baked_texture(bake["base"], True)}
            pbr["baseColorFactor"] = [1, 1, 1, 1]
        if bake["metal_rough"] is not None:
            pbr["metallicRoughnessTexture"] = {"index": baked_texture(bake["metal_rough"], False)}
            pbr["metallicFactor"] = pbr["roughnessFactor"] = 1
        if bake["normal"] is not None:
            result["normalTexture"] = {"index": baked_texture(bake["normal"], False), "scale": 1}
        if bake["emission"] is not None:
            if bake["emission"][..., :3].max() > 1 + 1 / 255:
                failure(material, "HDR emission is unsupported; baked emission must stay in [0,1]")
            result["emissiveTexture"] = {"index": baked_texture(bake["emission"], True)}
            result["emissiveFactor"] = [1, 1, 1]
        shader = principled(material)[1]
        extensions = extended(material, shader) if shader else {}
        if extensions:
            result["extensions"] = extensions
        # Texels no face covers (gaps between UV islands) are never drawn, so they do not make the material blend.
        covered = bake["base"][..., 3][bake["coverage"]] if bake["base"] is not None else None
        alpha = covered.min() if covered is not None and covered.size else pbr["baseColorFactor"][3]
        if alpha < 1 - 0.5 / 255:
            result["alphaMode"] = "BLEND"
        return result

    def material_id(material, owner=None):
        """The material index of `material` on the object `owner`; a baked material is per mesh (its UV layout)."""
        key = material_key(material)
        bake_key = (key, owner.original.data.name) if owner is not None and material else None
        if bake_key not in baked:
            bake_key = None
        id_key = ("baked",) + bake_key if bake_key else key
        if id_key in material_ids:
            return material_ids[id_key]
        result = baked_material(material, baked[bake_key]) if bake_key else direct(material)
        for value in result["pbrMetallicRoughness"]["baseColorFactor"] + [result["pbrMetallicRoughness"]["metallicFactor"], result["pbrMetallicRoughness"]["roughnessFactor"]]:
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("PBR material factors must be finite and in [0,1]")
        material_ids[id_key] = len(materials)
        materials.append(result)
        return material_ids[id_key]

    def pack(obj, mesh, slots, extra=None, rest=None):
        """Corner-split, deduplicated primitives per material slot; `extra` adds per-loop columns kept with each vertex."""
        mesh.calc_loop_triangles()
        if not mesh.loop_triangles:
            return None
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
        if rest is not None:
            coordinates = rest.copy()
        mesh.loops.foreach_get("normal", normals)
        coordinates = coordinates.reshape(-1, 3)[:, (0, 2, 1)]
        coordinates[:, 2] *= -1
        coordinates *= unit_scale
        normals = normals.reshape(-1, 3)[:, (0, 2, 1)]
        normals[:, 2] *= -1
        # Imported tessellated meshes can carry invalid corner normals; export those as +Y.
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
        columns = values if extra is None else np.concatenate([values, extra], axis=1)
        width = columns.shape[1] * 4
        primitives = []
        for slot in np.unique(triangle_materials):
            corners = columns[triangle_loops[triangle_materials == slot].ravel()]
            _, first, inverse = np.unique(corners.view(f"V{width}").ravel(), return_index=True, return_inverse=True)
            order = np.argsort(first)
            remap = np.empty(len(first), dtype="<u4")
            remap[order] = np.arange(len(first), dtype=np.uint32)
            unique = corners[first[order]]
            vertices = np.ascontiguousarray(unique[:, :stride // 4])
            mat = slots[slot] if slot < len(slots) else None
            mid = material_id(mat, obj)
            pbr = materials[mid]["pbrMetallicRoughness"]
            if pbr.get("baseColorTexture") or pbr.get("metallicRoughnessTexture") or materials[mid].get("normalTexture") or materials[mid].get("emissiveTexture"):
                if not uv_layer:
                    raise ValueError(f"Object '{obj.name}': textured material requires an active UV map")
            bounds = vertices[:, :3].min(axis=0).tolist() + vertices[:, :3].max(axis=0).tolist()
            primitives.append({"vertices": vertices.tobytes(), "indices": remap[inverse].tobytes(), "material": mid, "stride": stride, "bounds": bounds})
            if extra is not None:
                primitives[-1]["extra"] = unique[:, stride // 4:]
        return primitives

    depsgraph = context.evaluated_depsgraph_get()
    unit_scale = context.scene.unit_settings.scale_length
    inverse_basis = basis.inverted()
    def convert(matrix):
        """A Blender world-space matrix in Margo's Y-up metres."""
        result = basis @ matrix @ inverse_basis
        result.translation *= unit_scale
        return result

    class NodeOf:
        """Appends one node per call: TRS from a converted matrix, asset ID and `margo:` properties."""

        def __init__(self):
            self.nodes, self.meshes, self.convert, self.objects = nodes, {}, convert, {}

        def trs(self, obj, bone, world):
            translation, rotation, scale = world.decompose()
            rebuilt = Matrix.LocRotScale(translation, rotation, scale)
            label = f"Bone '{bone.name}' of '{obj.name}'" if bone else f"Object '{obj.name}'"
            if any(abs(world[r][c] - rebuilt[r][c]) > 1e-4 * max(1, abs(world[r][c])) for r in range(4) for c in range(4)) or any(abs(v) < 1e-8 for v in scale):
                raise ValueError(f"{label}: shear/singular transforms must be applied before export")
            return list(translation), [rotation.x, rotation.y, rotation.z, rotation.w], list(scale)

        def __call__(self, obj, bone, world, mesh=None, instance=""):
            if object_animation and bone is None and not instance:
                world = Matrix.Identity(4)  # The hierarchy pass validates local TRS; a valid world may have shear.
            translation, rotation, scale = self.trs(obj, bone, world)
            identity = f"{obj.library.filepath if obj.library else ''}:{obj.name_full}:{instance}" + (f":{bone.name}" if bone else "")
            node = {"name": bone.name if bone else obj.name_full}
            if mesh is not None:
                node["mesh"] = mesh
            node.update({"translation": translation, "rotation": rotation, "scale": scale, "extras": {"margo": {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, identity)), "properties": {} if bone else properties(obj)}}})
            node["id"] = len(nodes)
            nodes.append(node)
            if bone is None and not instance:
                self.objects[obj.as_pointer()] = (obj, node)
            return node

    def properties(obj):
        result = {}
        for key in obj.keys():
            if not key.startswith("margo:"):
                continue
            value = obj[key]
            if hasattr(value, "to_list"):
                value = value.to_list()
            if isinstance(value, list):
                if len(value) > 32 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value):
                    raise ValueError(f"Object '{obj.name}': '{key}' requires at most 32 finite numbers")
            elif not isinstance(value, (str, bool, int, float)) or isinstance(value, (int, float)) and not math.isfinite(value):
                raise ValueError(f"Object '{obj.name}': unsupported custom property '{key}'")
            result[key] = value
        return result

    def exported(instance):
        """True for a visible mesh instance, the only kind the export writes."""
        obj = instance.object
        visible = instance.parent.original if instance.is_instance and instance.parent else obj.original
        return obj.type == "MESH" and instance.show_self and visible.visible_get(view_layer=context.view_layer)

    if bake_size:
        # Bake first: baking changes the scene, so it never runs while the depsgraph's instances are iterated.
        pending = {}
        for instance in depsgraph.object_instances:
            if not exported(instance):
                continue
            obj = instance.object
            used = np.zeros(len(obj.data.polygons), dtype=np.int32)
            obj.data.polygons.foreach_get("material_index", used)
            for index in np.unique(used).tolist():
                material = obj.material_slots[index].material if index < len(obj.material_slots) else None
                if material and needs_baking(material):
                    # Bake the original material: the evaluated copy is rebuilt from it whenever the scene updates.
                    pending.setdefault((material_key(material), obj.original.data.name), (obj.original, material.original))
        for key, (owner, material) in pending.items():
            baked[key] = bake_material(context, owner, material, bake_size)
        if pending:
            depsgraph = context.evaluated_depsgraph_get()

    LUMENS_PER_WATT = 683  # the luminous efficacy glTF's KHR_lights_punctual and Blender's glTF guidance assume

    def light_properties(obj):
        """`margo:` light tags for a Blender light: the components entry builds a KHR_lights_punctual light from them."""
        light = obj.data
        if light.type == "AREA":
            raise ValueError(f"Light '{obj.name}': area lights have no glTF punctual equivalent; use a point, spot or sun light")
        color = [float(c) for c in light.color]
        if light.type == "SUN":
            # Sun strength is irradiance in W/m2; a directional light's intensity is illuminance in lux.
            result = {"margo:light": "directional", "margo:intensity": float(light.energy) * LUMENS_PER_WATT}
        else:
            # Power in W over the whole sphere; a spot's power is that of the point light it is cut from.
            result = {"margo:light": "point" if light.type == "POINT" else "spot", "margo:intensity": float(light.energy) * LUMENS_PER_WATT / (4 * math.pi)}
            if light.use_custom_distance:
                result["margo:range"] = float(light.cutoff_distance) * unit_scale
            if light.type == "SPOT":
                outer = min(float(light.spot_size) / 2, math.pi / 2)
                result["margo:outer_cone"] = outer
                result["margo:inner_cone"] = outer * (1 - float(light.spot_blend))
        result["margo:color"] = color
        return result

    def camera_properties(obj, active):
        """`margo:` camera tags for a Blender camera: the components entry builds a glTF camera from them."""
        camera = obj.data
        render = context.scene.render
        width, height = render.resolution_x * render.pixel_aspect_x, render.resolution_y * render.pixel_aspect_y
        aspect = width / height
        if camera.shift_x or camera.shift_y:
            raise ValueError(f"Camera '{obj.name}': lens shift has no glTF equivalent; set Shift X and Y to 0")
        fit = camera.sensor_fit
        if fit == "AUTO":
            fit = "HORIZONTAL" if aspect >= 1 else "VERTICAL"
            sensor = camera.sensor_width
        else:
            sensor = camera.sensor_width if fit == "HORIZONTAL" else camera.sensor_height
        result = {"margo:znear": float(camera.clip_start) * unit_scale, "margo:zfar": float(camera.clip_end) * unit_scale, "margo:aspect": aspect}
        if camera.type == "PERSP":
            half = math.atan(sensor / (2 * camera.lens))  # half the angle along the fitted side
            result["margo:camera"] = "perspective"
            result["margo:yfov"] = 2 * (math.atan(math.tan(half) / aspect) if fit == "HORIZONTAL" else half)
        elif camera.type == "ORTHO":
            half = camera.ortho_scale / 2 * unit_scale
            result["margo:camera"] = "orthographic"
            result["margo:ymag"] = half / aspect if fit == "HORIZONTAL" else half
        else:
            raise ValueError(f"Camera '{obj.name}': panoramic cameras have no glTF equivalent; use a perspective or orthographic camera")
        if active:
            result["margo:active"] = True
        return result

    node_of = NodeOf()
    moving = []
    for instance in depsgraph.object_instances:
        obj = instance.object
        if not exported(instance):
            continue
        if animated(obj.original):
            if instance.is_instance:
                raise ValueError(f"Object '{obj.name}': animated meshes cannot be instanced; make the instance real")
            moving.append(obj.original)
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
                primitives = pack(obj, mesh, slots)
                if primitives is None:
                    continue
                digest = tuple((hashlib.sha256(p["vertices"] + p["indices"]).digest(), p["material"], p["stride"]) for p in primitives)
                if digest not in mesh_ids:
                    mesh_ids[digest] = len(geometry)
                    geometry.append(primitives)
                mesh_index = mesh_ids[digest]
                cached[data_key] = mesh_index
            finally:
                obj.to_mesh_clear()
        node_of(obj.original, None, convert(instance.matrix_world), mesh=mesh_index, instance=tuple(instance.persistent_id) if instance.is_instance else "")
    if lights_cameras:
        for instance in depsgraph.object_instances:
            obj = instance.object
            visible = instance.parent.original if instance.is_instance and instance.parent else obj.original
            if obj.type not in ("LIGHT", "CAMERA") or not instance.show_self or not visible.visible_get(view_layer=context.view_layer):
                continue
            tags = light_properties(obj) if obj.type == "LIGHT" else camera_properties(obj, obj.original == context.scene.camera)
            own = properties(obj.original)
            clash = sorted(set(own) & set(tags))
            if clash:
                raise ValueError(f"Object '{obj.name}': remove the custom property '{clash[0]}'; the exporter writes it from the {obj.type.lower()}")
            # A light or camera looks down its local -Z with +Y up in Blender and in glTF alike, so only the world
            # axes change (basis @ M); the mesh conversion basis @ M @ basis^-1 would turn its local axes too.
            world = basis @ instance.matrix_world
            world.translation *= unit_scale
            node = node_of(obj.original, None, world, instance=tuple(instance.persistent_id) if instance.is_instance else "")
            node["extras"]["margo"]["properties"] = {**own, **tags}
    extra = GeometryData(unit_scale)
    if curves:
        for instance in depsgraph.object_instances:
            obj = instance.object
            visible = instance.parent.original if instance.is_instance and instance.parent else obj.original
            if obj.type not in KINDS or not instance.show_self or not visible.visible_get(view_layer=context.view_layer):
                continue
            added = read_object(obj, extra)
            if not added:
                continue
            if "volume" in added:
                # OpenVDB grids keep Blender's Z-up object space, so the node turns them (scale, basis, world).
                world = Matrix.Scale(unit_scale, 4) @ basis @ instance.matrix_world
            else:
                world = convert(instance.matrix_world)
            node = node_of(obj.original, None, world, instance=tuple(instance.persistent_id) if instance.is_instance else "")
            node.update(added)
    if (extra.curves or extra.points or extra.volumes) and (moving or object_animation):
        raise ValueError("Curves, point clouds and volumes cannot be exported with skins, shape keys or actions yet; "
                         "export them from a scene without animation, or turn off Curves, Points and Volumes")
    roots = [node["id"] for node in nodes]
    fields, animation = {}, b""
    if moving or object_animation:
        animated_roots, fields, animation = export_animated(context, moving, pack, convert, node_of, geometry, object_animation)
        roots = animated_roots if object_animation else roots + animated_roots
    for node in nodes:
        del node["id"]
    shapes = {key: value for key, value in (("curves", extra.curves), ("pointClouds", extra.points), ("volumes", extra.volumes)) if value}
    if not geometry and not shapes:
        raise ValueError("No visible mesh triangles to export")
    if len(nodes) > 100_000:
        raise ValueError("Too many exported objects")
    meshes = [node_of.meshes.get(i, {}) for i in range(len(geometry))]
    document = {"nodes": nodes, "meshes": meshes, "materials": materials, "textures": textures, "samplers": samplers, "scenes": [{"nodes": roots}], "scene": 0, **fields, **shapes}
    used = sorted({name for material in materials for name in material.get("extensions", {})})
    if used:
        document["extensionsUsed"] = used
    return write(path, document, geometry, images, animation, extra.data(), extra.vdbs)
