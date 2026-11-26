"""Node graph baking: a material outside the direct Principled subset (procedural node graphs, textured metallic or
roughness, other shaders) is baked with Cycles at export to base colour, packed metallic-roughness, normal and emission
images on the object's render UV map, so any Blender surface material exports. No runtime code: the images are
ordinary embedded PNG textures."""
import bpy
import numpy as np

# Principled inputs baked from the socket itself; an input that is not linked stays a constant factor.
CHANNELS = ("Base Color", "Alpha", "Metallic", "Roughness", "Emission Color")


def render_uv(mesh):
    """The UV map Blender shades and renders with: the one marked active for rendering (MeshUVLoopLayer.active_render,
    which an unlinked Image Texture vector and Texture Coordinate's UV output read), not the one active for display and
    editing (UVLoopLayers.active), which Cycles' bake would otherwise rasterise on. None for a mesh without UV maps."""
    return next((layer for layer in mesh.uv_layers if layer.active_render), mesh.uv_layers.active)


def second_uv(mesh):
    """The first UV map other than the render map: TEXCOORD_1, which carries the lightmap."""
    first = render_uv(mesh)
    return next((layer for layer in mesh.uv_layers if layer.name != first.name), None) if first else None


def feed(socket):
    """The (node, output socket) Blender evaluates into the input `socket`, or None where the socket keeps its own
    value. A muted link feeds nothing, a reroute passes its input on, and a muted node passes to each output the input
    its internal link names; an output with no internal link feeds nothing (tests/blender_mute.py bakes the cases)."""
    seen = set()
    while socket.links and socket.as_pointer() not in seen:
        seen.add(socket.as_pointer())
        link = socket.links[0]
        if link.is_muted:
            break
        node, out = link.from_node, link.from_socket
        if node.type == "REROUTE":
            socket = node.inputs[0]
        elif node.mute:
            socket = next((i.from_socket for i in node.internal_links if i.to_socket == out), None)
            if socket is None:
                break
        else:
            return node, out
    return None


def principled(material):
    """The active output node and the Principled BSDF on its Surface (None for any other surface shader)."""
    outputs = [n for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output]
    surface = feed(outputs[0].inputs["Surface"]) if len(outputs) == 1 else None
    if surface is None:
        raise ValueError(f"Material '{material.name}': missing active surface output, so there is nothing to bake")
    shader = surface[0]
    return outputs[0], shader if shader.type == "BSDF_PRINCIPLED" else None


def bake_material(context, obj, material, size):
    """Bakes `material` on `obj` (an original object in the view layer with a UV map) with Cycles on the CPU, laid out
    on its render UV map (render_uv), the TEXCOORD_0 the exporter writes.
    Returns {"base", "metal_rough", "normal", "emission"}: linear float arrays of size x size x 4 in Blender's
    bottom-up row order, or None where a constant carries the channel, plus "factors" (the constants) and
    "coverage" (a boolean size x size mask of the texels the object's faces cover). The scene, selection, nodes and
    images are restored afterwards, also on failure."""
    uv = render_uv(obj.data) if obj.type == "MESH" else None
    if uv is None:
        raise ValueError(f"Material '{material.name}' needs baking: add a UV map to object '{obj.name}'")
    if obj.name not in context.view_layer.objects:
        raise ValueError(f"Material '{material.name}' needs baking on object '{obj.name}', which is not in the view layer; make the instance real")
    scene = context.scene
    tree = material.node_tree
    output, shader = principled(material)
    saved = {
        "engine": scene.render.engine,
        "samples": scene.cycles.samples,
        "device": scene.cycles.device,
        "selected": [o for o in context.view_layer.objects if o.select_get()],
        "active": context.view_layer.objects.active,
        "hide": obj.hide_render,
    }
    # The bake operator rebuilds node data, so every node, socket and image is looked up by name after it runs.
    link = output.inputs["Surface"].links[0]
    surface = (link.from_node.name, link.from_socket.identifier)
    temporary_images, others = [], []
    previous_active = tree.nodes.active.name if tree.nodes.active else None
    names = {"output": output.name, "shader": shader.name if shader else None, "uv": uv.name}
    kinds = {n.type for n in tree.nodes}  # before the temporary nodes below
    target = tree.nodes.new("ShaderNodeTexImage")
    names["target"] = target.name
    emission = tree.nodes.new("ShaderNodeEmission")
    names["emission"] = emission.name
    emission.inputs["Strength"].default_value = 1
    # Adds 0 to what feeds a float input, so Blender itself converts a colour or vector to the float the socket reads.
    convert = tree.nodes.new("ShaderNodeMath")
    names["convert"] = convert.name
    convert.operation, convert.inputs[1].default_value = "ADD", 0
    coverage = []

    def node(key):
        return material.node_tree.nodes[names[key]]

    def image(name):
        result = bpy.data.images.new(f"margo-bake-{name}", size, size, alpha=True, float_buffer=True)
        result.colorspace_settings.name = "Non-Color"
        temporary_images.append(result.name)
        return result

    def run(kind, **extra):
        made = image(kind.lower())
        node("target").image = made
        material.node_tree.nodes.active = node("target")
        bpy.ops.object.bake(type=kind, margin=4, use_clear=True, uv_layer=names["uv"], **extra)
        values = np.empty(size * size * 4, dtype=np.float32)
        bpy.data.images[temporary_images[-1]].pixels.foreach_get(values)
        values = values.reshape(size, size, 4)
        if not coverage:
            coverage.append(values[..., 3] > 0)
        if not np.isfinite(values).all():
            raise ValueError(f"Material '{material.name}': the {kind} bake gave non-finite pixels")
        return values

    def socket(name):
        """Bakes what feeds a Principled input, through an Emission shader on the output. A float input takes a colour
        as its luminance and a vector as its mean, as in the material."""
        links = material.node_tree.links
        source = feed(node("shader").inputs[name])[1]
        if node("shader").inputs[name].type == "VALUE":
            links.new(source, node("convert").inputs[0])
            source = node("convert").outputs[0]
        links.new(source, node("emission").inputs["Color"])
        links.new(node("emission").outputs["Emission"], node("output").inputs["Surface"])
        try:
            return run("EMIT")
        finally:
            source = material.node_tree.nodes[surface[0]]
            links = material.node_tree.links
            links.new(next(s for s in source.outputs if s.identifier == surface[1]), node("output").inputs["Surface"])

    def plane(*channels):
        return np.tile(np.array(channels, np.float32), (size, size, 1))

    try:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = 4
        obj.hide_render = False
        for other in context.view_layer.objects:
            other.select_set(other == obj)
        context.view_layer.objects.active = obj
        # Every other material on the object bakes into a scratch image, so only this material's faces land.
        scratch = image("scratch")
        for slot in obj.material_slots:
            if slot.material and slot.material != material and slot.material.node_tree:
                nodes = slot.material.node_tree.nodes
                held = nodes.new("ShaderNodeTexImage")
                held.image = scratch
                others.append((slot.material.name, held.name, nodes.active.name if nodes.active else None))
                nodes.active = held
        result = {"base": None, "metal_rough": None, "normal": None, "emission": None}
        factors = {"base": [1, 1, 1, 1], "metallic": 0, "roughness": 0.5, "emissive": [0, 0, 0]}
        if shader:
            linked = {name: feed(shader.inputs[name]) is not None for name in CHANNELS + ("Normal", "Emission Strength")}
            values = {name: shader.inputs[name].default_value for name in CHANNELS + ("Emission Strength",)}
            values = {name: list(v) if hasattr(v, "__len__") else v for name, v in values.items()}
            constant = values.__getitem__
            factors["base"] = list(constant("Base Color"))[:3] + [constant("Alpha")]
            factors["metallic"], factors["roughness"] = constant("Metallic"), constant("Roughness")
            if linked["Base Color"] or linked["Alpha"]:
                base = socket("Base Color") if linked["Base Color"] else plane(*factors["base"])
                base[..., 3] = socket("Alpha")[..., 0] if linked["Alpha"] else constant("Alpha")
                result["base"] = base
            if linked["Metallic"] or linked["Roughness"]:
                mr = plane(0, 0, 0, 1)
                mr[..., 1] = socket("Roughness")[..., 0] if linked["Roughness"] else constant("Roughness")
                mr[..., 2] = socket("Metallic")[..., 0] if linked["Metallic"] else constant("Metallic")
                result["metal_rough"] = mr
            if linked["Normal"]:
                result["normal"] = run("NORMAL", normal_space="TANGENT")
            strength = constant("Emission Strength")
            if linked["Emission Strength"]:
                result["emission"] = run("EMIT")
            elif linked["Emission Color"] and strength > 0:
                result["emission"] = socket("Emission Color")
                result["emission"][..., :3] *= strength
            elif not linked["Emission Color"]:
                factors["emissive"] = [v * strength for v in constant("Emission Color")[:3]]
        else:
            # Any other surface: Cycles' own passes. The diffuse colour pass is the albedo and the roughness pass
            # the roughness; the surface exports as a dielectric (metallic 0).
            base = run("DIFFUSE", pass_filter={"COLOR"})
            base[..., 3] = 1
            result["base"] = base
            mr = plane(0, 0, 0, 1)
            mr[..., 1] = run("ROUGHNESS")[..., 0]
            result["metal_rough"] = mr
            if kinds & {"NORMAL_MAP", "BUMP"}:
                result["normal"] = run("NORMAL", normal_space="TANGENT")
            if "EMISSION" in kinds:
                result["emission"] = run("EMIT")
        result["factors"] = factors
        result["coverage"] = coverage[0] if coverage else np.ones((size, size), bool)
        return result
    finally:
        for other, held, active in others:
            nodes = bpy.data.materials[other].node_tree.nodes
            nodes.remove(nodes[held])
            nodes.active = nodes[active] if active else None
        nodes = material.node_tree.nodes
        for key in ("target", "emission", "convert"):
            nodes.remove(nodes[names[key]])
        nodes.active = nodes[previous_active] if previous_active else None
        for leftover in temporary_images:
            bpy.data.images.remove(bpy.data.images[leftover])
        scene.render.engine = saved["engine"]
        scene.cycles.samples = saved["samples"]
        scene.cycles.device = saved["device"]
        obj.hide_render = saved["hide"]
        for other in context.view_layer.objects:
            other.select_set(other in saved["selected"])
        context.view_layer.objects.active = saved["active"]
