"""Clean-room live socket graph serialization. No shader code or texture baking."""
import math


def graph(context, material, owner):
    tree = material.node_tree
    outputs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output]
    if len(outputs) != 1 or not outputs[0].inputs["Surface"].is_linked:
        raise ValueError(f"Material '{material.name}': connect one active surface output")
    output = outputs[0]
    shader = output.inputs["Surface"].links[0].from_node
    if shader.type != "BSDF_PRINCIPLED" or output.inputs["Volume"].is_linked or output.inputs["Displacement"].is_linked:
        raise ValueError(f"Material '{material.name}': live nodes require a direct Principled surface")
    nodes, parameters, readers, memo, active = [], {}, {}, {}, set()

    def fail(node, detail):
        raise ValueError(f"Material '{material.name}', node '{node.name}': {detail}; disable live_nodes to bake this graph")

    def parameter(key, read):
        def value():
            v = read()
            v = [float(v)] if isinstance(v, (int, float)) else list(v)
            if len(v) not in (1, 3, 4) or any(not math.isfinite(x) for x in v):
                raise ValueError(f"Live parameter '{key}' requires finite scalar, vector or RGBA values")
            return v
        parameters[key] = {"value": value()}
        readers[key] = value
        return {"parameter": key}

    def socket(node, index):
        s = node.inputs[index]
        if s.is_linked:
            link = s.links[0]
            return visit(link.from_node, link.from_socket)
        return parameter(f"{node.name}/inputs/{index}", lambda: s.default_value)

    def visit(node, out):
        key = (node.as_pointer(), out.identifier)
        if key in active:
            fail(node, "cyclic graph")
        if key in memo:
            return {"link": memo[key]}
        if len(nodes) + len(active) >= 256:
            fail(node, "more than 256 live outputs")
        active.add(key)
        t = node.type
        data = {"name": node.name, "type": "float" if out.type == "VALUE" else "color" if out.type == "RGBA" else "vector"}
        if t == "REROUTE":
            result = socket(node, 0)
            active.remove(key)
            return result
        if t in {"VALUE", "RGB"}:
            data.update(op="value", inputs=[parameter(f"{node.name}/outputs/0", lambda: out.default_value)])
        elif t == "MATH":
            data.update(op="math", operation=node.operation, clamp=node.use_clamp, inputs=[socket(node, i) for i in range(3)])
        elif t in {"MIX", "MIX_RGB"}:
            if t == "MIX_RGB":
                indices = [0, 1, 2]
                data.update(mode="RGBA", blend=node.blend_type, clampFactor=True, clamp=node.use_clamp)
            else:
                mode = node.data_type
                if mode not in {"FLOAT", "VECTOR", "RGBA"}:
                    fail(node, f"unsupported Mix data type {mode}")
                indices = [0, 2, 3] if mode == "FLOAT" else [1 if node.factor_mode == "NON_UNIFORM" else 0, 4, 5] if mode == "VECTOR" else [0, 6, 7]
                data.update(mode=mode, blend=node.blend_type if mode == "RGBA" else "MIX", clampFactor=node.clamp_factor, clamp=node.clamp_result)
            data.update(op="mix", inputs=[socket(node, i) for i in indices])
        elif t == "VALTORGB":
            ramp = node.color_ramp
            data.update(op="ramp", interpolation=ramp.interpolation, colorMode=ramp.color_mode, hue=ramp.hue_interpolation, inputs=[socket(node, 0)], stops=[])
            for i, element in enumerate(ramp.elements):
                data["stops"].append([parameter(f"{node.name}/stops/{i}/position", lambda e=element: e.position), parameter(f"{node.name}/stops/{i}/color", lambda e=element: e.color)])
            data["alpha"] = out.name == "Alpha"
        elif t == "TEX_NOISE":
            data.update(op="noise", dimensions=int(node.noise_dimensions[0]), normalize=getattr(node, "normalize", True), noiseType=getattr(node, "noise_type", "FBM"), color=out.name == "Color")
            data["inputs"] = [socket(node, i) for i in range(len(node.inputs))]
            data["sockets"] = [s.name for s in node.inputs]
            if not node.inputs["Vector"].is_linked:
                data["inputs"][0] = {"link": coordinate("generated")}
        elif t in {"UVMAP", "TEX_COORD"}:
            mode = "uv" if t == "UVMAP" or out.name == "UV" else out.name.lower()
            if mode not in {"uv", "generated", "object", "normal"} or t == "UVMAP" and node.uv_map and node.uv_map != owner.data.uv_layers.active.name or t == "TEX_COORD" and node.object:
                fail(node, "unsupported coordinate source")
            data.update(op=mode, inputs=[])
        elif t in {"SEPXYZ", "SEPRGB", "SEPARATE_COLOR"}:
            if t == "SEPARATE_COLOR" and node.mode != "RGB":
                fail(node, "separate color requires RGB mode")
            data.update(op="separate", component=list(node.outputs).index(out), inputs=[socket(node, 0)])
        elif t in {"COMBXYZ", "COMBRGB", "COMBINE_COLOR"}:
            if t == "COMBINE_COLOR" and node.mode != "RGB":
                fail(node, "combine color requires RGB mode")
            data.update(op="combine", inputs=[socket(node, i) for i in range(3)])
        else:
            fail(node, f"unsupported live node {t}")
        active.remove(key)
        memo[key] = len(nodes)
        nodes.append(data)
        return {"link": memo[key]}

    def coordinate(mode):
        nodes.append({"name": mode, "op": mode, "type": "vector", "inputs": []})
        return len(nodes) - 1

    surface = {}
    names = {"Base Color": "base", "Metallic": "metal", "Roughness": "roughness", "Alpha": "alpha", "Emission Color": "emission", "Emission Strength": "strength", "IOR": "ior"}
    for i, s in enumerate(shader.inputs):
        if s.name in names:
            surface[names[s.name]] = socket(shader, i)
        elif s.is_linked:
            fail(shader, f"unsupported linked surface input {s.name}")
    # Reject static lobes that the compact live surface cannot represent instead of silently losing them.
    for name in ("Transmission Weight", "Coat Weight", "Sheen Weight", "Subsurface Weight", "Anisotropic IOR Level"):
        if shader.inputs.get(name) and shader.inputs[name].default_value != 0:
            fail(shader, f"unsupported live surface lobe {name}")
    bounds = [list(v) for v in owner.bound_box]
    result = {"version": 1, "nodes": nodes, "parameters": parameters, "surface": surface,
              "bounds": [[min(v[c] for v in bounds) for c in range(3)], [max(v[c] for v in bounds) for c in range(3)]],
              "unitScale": context.scene.unit_settings.scale_length}
    animation = tree.animation_data
    if animation and (animation.action or animation.drivers):
        scene = context.scene
        start, end = scene.frame_start, scene.frame_end
        if end - start > 3600 or (end - start + 1) * len(readers) > 262144:
            raise ValueError("Live node animation exceeds 3601 frames or 262144 parameter samples; shorten the scene range")
        fps = scene.render.fps / scene.render.fps_base
        frame, subframe = scene.frame_current, scene.frame_subframe
        samples = {k: [] for k in readers}
        try:
            for f in range(start, end + 1):
                scene.frame_set(f)
                for k, read in readers.items():
                    samples[k].append(read())
        finally:
            scene.frame_set(frame, subframe=subframe)
        result["times"] = [(f - start) / fps for f in range(start, end + 1)]
        for k, values in samples.items():
            if any(v != values[0] for v in values[1:]):
                parameters[k]["samples"] = values
    return result


def live_material(context, material, owner):
    data = graph(context, material.original, owner.original)
    alpha = data["surface"]["alpha"]
    opacity = data["parameters"].get(alpha.get("parameter"))
    blended = opacity is None or opacity["value"][0] < 1 or any(v[0] < 1 for v in opacity.get("samples", []))
    return {"name": material.name, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.5},
            "alphaMode": "BLEND" if blended else "OPAQUE",
            "doubleSided": not material.use_backface_culling, "extras": {"margo:nodes": data}}
