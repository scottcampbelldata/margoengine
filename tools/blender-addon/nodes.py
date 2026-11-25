"""Clean-room live socket graph serialization. No shader code or texture baking."""
import math
import struct

from .bake import render_uv

# F-curve keys of one live parameter, in seconds from the scene start, when Blender's own evaluation can be reproduced
# exactly between frames: CONSTANT, LINEAR, BEZIER and every easing (ELASTIC with its amplitude, and its period in seconds),
# with no modifier, driver, NLA or mute. An F-curve that carries a Noise modifier is sampled by Blender's own evaluation
# (fcurve.evaluate) at power-of-two subframe steps and written as LINEAR keys, reduced greedily, that give every sample back
# within single-precision rounding (KB5339d): the reader plays those values and has no noise model. Anything else keeps the per-frame
# samples alone.
EXACT_INTERPOLATIONS = {"CONSTANT", "LINEAR", "BEZIER", "SINE", "QUAD", "CUBIC", "QUART", "QUINT", "EXPO", "CIRC", "BACK", "BOUNCE",
                        "ELASTIC"}


def _fcurves(animation):
    action = animation.action
    if action is None:
        return None
    slot = getattr(animation, "action_slot", None)
    if slot is not None:
        from bpy_extras import anim_utils
        bag = anim_utils.action_get_channelbag_for_slot(action, slot)
        return list(bag.fcurves) if bag else []
    return list(action.fcurves)


def _float32(v):
    return struct.unpack("f", struct.pack("f", v))[0]


def _ulp32(v):
    """The gap from float32 v to the next float32 away from zero (Blender evaluates curves in single precision)."""
    bits = struct.unpack("<I", struct.pack("<f", abs(v)))[0]
    return struct.unpack("<f", struct.pack("<I", bits + 1))[0] - abs(v)


def within_rounding(got, sample):
    """True when got, rounded to float32, is the sample or one of its float32 neighbours."""
    return abs(_float32(got) - sample) <= _ulp32(sample)


def _reduce(times, values):
    """Indices of the samples a greedy pass keeps so that linear interpolation between kept neighbours, computed as the
    reader computes it in double precision, rounds to every dropped sample's float32 value or a float32 neighbour of it."""
    def gives_back(a, b):
        ta, tb, va, vb = times[a], times[b], values[a], values[b]
        return all(within_rounding(va + (vb - va) * ((times[m] - ta) / (tb - ta)), values[m]) for m in range(a + 1, b))

    kept, a, n = [0], 0, len(times)
    while a < n - 1:
        b = a + 1
        # Grow the span while a line from its first sample still reaches every sample's float32 rounding interval
        # (one float32 step either side), then confirm the span exactly; shrink it if the bound was loose.
        low, high, c = -math.inf, math.inf, a + 1
        while c < n:
            dt = times[c] - times[a]
            tol = _ulp32(values[c])
            low, high = max(low, (values[c] - tol - values[a]) / dt), min(high, (values[c] + tol - values[a]) / dt)
            if low > high:
                break
            b, c = c, c + 1
        while b > a + 1 and not gives_back(a, b):
            b -= 1
        kept.append(b)
        a = b
    return kept


def noise_step(fcurve, coarsen=0):
    """Sampling step in frames for a Noise-modified F-curve: an eighth of a frame, finer when the finest noise octave is
    shorter (8 samples per octave length scale / lacunarity^depth), a power of two from 1/1024 up to one frame."""
    finest = min((m.scale / (getattr(m, "lacunarity", 2.0) ** m.depth) for m in fcurve.modifiers if m.type == "NOISE" and m.scale > 0),
                 default=1.0)
    step = 1 / 8
    while step > 1 / 1024 and step > finest / 8:
        step /= 2
    return min(1.0, step * 2 ** coarsen)


def noise_keys(fcurve, start, end, fps, coarsen=0):
    step = noise_step(fcurve, coarsen)
    count = round((end - start) / step)
    frames = [start + i * step for i in range(count + 1)]
    times = [(f - start) / fps for f in frames]
    values = [fcurve.evaluate(f) for f in frames]
    if any(not math.isfinite(v) for v in values):
        return None
    keys = [{"t": times[i], "v": values[i], "l": [times[i], values[i]], "r": [times[i], values[i]], "i": "LINEAR", "e": "AUTO", "b": 0.0}
            for i in _reduce(times, values)]
    return {"extrapolation": "CONSTANT", "keys": keys}


def has_noise(fcurve):
    return any(m.type == "NOISE" for m in fcurve.modifiers)


def exact_curves(animation, path, width, start, fps, end=None, coarsen=0):
    if path is None or animation.nla_tracks or any(d.data_path == path for d in animation.drivers):
        return None
    fcurves = _fcurves(animation)
    if fcurves is None:
        return None
    curves = []
    for index in range(width):
        found = [f for f in fcurves if f.data_path == path and f.array_index == index]
        if not found:
            curves.append(None)
            continue
        fcurve = found[0]
        points = fcurve.keyframe_points
        if not fcurve.mute and end is not None and has_noise(fcurve):
            curve = noise_keys(fcurve, start, end, fps, coarsen)
            if curve is None or len(curve["keys"]) > 65536:
                return None
            curves.append(curve)
            continue
        if fcurve.mute or len(fcurve.modifiers) or not len(points) or fcurve.extrapolation not in {"CONSTANT", "LINEAR"}:
            return None
        if any(k.interpolation not in EXACT_INTERPOLATIONS for k in points[:-1]):
            return None
        if any(points[n].co[0] <= points[n - 1].co[0] for n in range(1, len(points))):
            return None
        seconds = lambda frame: (frame - start) / fps
        curves.append({"extrapolation": fcurve.extrapolation, "keys": [
            {"t": seconds(k.co[0]), "v": k.co[1], "l": [seconds(k.handle_left[0]), k.handle_left[1]],
             "r": [seconds(k.handle_right[0]), k.handle_right[1]], "i": k.interpolation, "e": k.easing, "b": k.back,
             **({"a": k.amplitude, "p": k.period / fps} if k.interpolation == "ELASTIC" else {})}
            for k in points]})
    return curves if any(c is not None for c in curves) else None


def noise_trees(material):
    """The node trees (node groups included) on the way from the active output when a Noise Texture feeds it; else None."""
    seen, trees, found = set(), [], False
    stack = [(material.node_tree, n) for n in material.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output] if material.node_tree else []
    while stack:
        tree, node = stack.pop()
        if node.as_pointer() in seen:
            continue
        seen.add(node.as_pointer())
        if tree not in trees:
            trees.append(tree)
        found = found or node.type == "TEX_NOISE"
        if node.type == "GROUP" and node.node_tree:
            stack += [(node.node_tree, n) for n in node.node_tree.nodes if n.type == "GROUP_OUTPUT" and n.is_active_output]
        stack += [(tree, link.from_node) for s in node.inputs for link in s.links]
    return trees if found else None


def graph(context, material, owner):
    tree = material.node_tree
    outputs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output]
    if len(outputs) != 1 or not outputs[0].inputs["Surface"].is_linked:
        raise ValueError(f"Material '{material.name}': connect one active surface output")
    output = outputs[0]
    shader = output.inputs["Surface"].links[0].from_node
    if shader.type != "BSDF_PRINCIPLED" or output.inputs["Volume"].is_linked or output.inputs["Displacement"].is_linked:
        raise ValueError(f"Material '{material.name}': live nodes require a direct Principled surface")
    nodes, parameters, readers, memo, active, paths = [], {}, {}, {}, set(), {}

    def fail(node, detail):
        raise ValueError(f"Material '{material.name}', node '{node.name}': {detail}; disable live_nodes to bake this graph")

    def parameter(key, read, path=None):
        paths[key] = path
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
        return parameter(f"{node.name}/inputs/{index}", lambda: s.default_value, s.path_from_id("default_value"))

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
            data.update(op="value", inputs=[parameter(f"{node.name}/outputs/0", lambda: out.default_value, out.path_from_id("default_value"))])
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
                data["stops"].append([parameter(f"{node.name}/stops/{i}/position", lambda e=element: e.position, element.path_from_id("position")), parameter(f"{node.name}/stops/{i}/color", lambda e=element: e.color, element.path_from_id("color"))])
            data["alpha"] = out.name == "Alpha"
        elif t == "TEX_NOISE":
            data.update(op="noise", dimensions=int(node.noise_dimensions[0]), normalize=getattr(node, "normalize", True), noiseType=getattr(node, "noise_type", "FBM"), color=out.name == "Color")
            data["inputs"] = [socket(node, i) for i in range(len(node.inputs))]
            data["sockets"] = [s.name for s in node.inputs]
            if not node.inputs["Vector"].is_linked:
                data["inputs"][0] = {"link": coordinate("generated")}
        elif t in {"UVMAP", "TEX_COORD"}:
            mode = "uv" if t == "UVMAP" or out.name == "UV" else out.name.lower()
            if mode not in {"uv", "generated", "object", "normal"} or t == "UVMAP" and node.uv_map and node.uv_map != getattr(render_uv(owner.data), "name", None) or t == "TEX_COORD" and node.object:
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
        animated = [k for k, values in samples.items() if any(v != values[0] for v in values[1:])]
        for k in animated:
            parameters[k]["samples"] = samples[k]
        # Noise-sampled keys count toward the reader's 262144 samples: coarsen their step, never past one frame, until
        # the file fits; a parameter that still does not fit keeps its frame samples alone.
        for coarsen in range(11):
            total = len(animated) * len(result["times"])
            for k in animated:
                curves = exact_curves(animation, paths[k], len(samples[k][0]), start, fps, end, coarsen)
                parameters[k].pop("curves", None)
                if curves:
                    parameters[k]["curves"] = curves
                    total += sum(len(c["keys"]) for c in curves if c)
            if total <= 262144:
                break
        else:
            for k in animated:
                parameters[k].pop("curves", None)
    return result


def live_material(context, material, owner):
    data = graph(context, material.original, owner.original)
    alpha = data["surface"]["alpha"]
    opacity = data["parameters"].get(alpha.get("parameter"))
    blended = opacity is None or opacity["value"][0] < 1 or any(v[0] < 1 for v in opacity.get("samples", []))
    return {"name": material.name, "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.5},
            "alphaMode": "BLEND" if blended else "OPAQUE",
            "doubleSided": not material.use_backface_culling, "extras": {"margo:nodes": data}}
