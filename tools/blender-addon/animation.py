"""Armatures, skins, shape keys and actions as glTF-style skins, morph targets and sampled clips (FORMAT.md, Animated files)."""
import bpy
import numpy as np
from mathutils import Matrix

MAX_INFLUENCES = 8


def animated(obj):
    """A mesh object the animation path owns: an Armature modifier or more than one shape key."""
    key = obj.data.shape_keys if obj.type == "MESH" else None
    return obj.type == "MESH" and (any(m.type == "ARMATURE" for m in obj.modifiers) or bool(key and len(key.key_blocks) > 1))


class Data:
    """The data section: little-endian accessors appended four-byte aligned, with their bufferViews and accessors."""

    def __init__(self):
        self.blob = bytearray()
        self.views = []
        self.accessors = []

    def add(self, values, kind, component, minmax=False):
        array = np.ascontiguousarray(values, dtype={5126: "<f4", 5123: "<u2"}[component])
        width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}[kind]
        flat = array.reshape(-1, width)
        self.views.append({"section": "data", "byteOffset": len(self.blob), "byteLength": array.nbytes})
        self.blob += array.tobytes()
        self.blob += b"\0" * (-len(self.blob) % 4)
        accessor = {"bufferView": len(self.views) - 1, "componentType": component, "count": len(flat), "type": kind}
        if minmax:
            accessor["min"] = flat.min(axis=0).tolist()
            accessor["max"] = flat.max(axis=0).tolist()
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def _trs(matrix):
    translation, rotation, scale = matrix.decompose()
    return list(translation), [rotation.x, rotation.y, rotation.z, rotation.w], list(scale)


def _armature(obj):
    modifiers = list(obj.modifiers)
    if any(m.type != "ARMATURE" for m in modifiers) or len(modifiers) > 1:
        raise ValueError(f"Object '{obj.name}': an animated mesh may carry one Armature modifier and no other modifiers; apply the others first")
    if not modifiers:
        return None
    mod = modifiers[0]
    if not mod.object or mod.object.type != "ARMATURE" or not mod.show_viewport:
        raise ValueError(f"Object '{obj.name}': the Armature modifier needs an armature object and must be enabled")
    if not mod.use_vertex_groups or mod.use_bone_envelopes or mod.use_deform_preserve_volume or mod.use_multi_modifier or mod.vertex_group:
        raise ValueError(f"Object '{obj.name}': the Armature modifier must deform by vertex groups only (no envelopes, Preserve Volume, multi-modifier or mask group)")
    return mod.object


def _ordered_bones(armature):
    """Parents before children, roots in file order."""
    out = []

    def walk(bone):
        out.append(bone)
        for child in bone.children:
            walk(child)

    for bone in armature.data.bones:
        if bone.parent is None:
            walk(bone)
    return out


def export_animated(context, objects, pack, convert, node_of, geometry, object_animation=False):
    """Appends nodes for `objects` through `node_of` and returns (root node ids, document fields, data bytes)."""
    data = Data()
    skins, roots, owners = [], [], []
    armature_nodes = {}
    s = context.scene.unit_settings.scale_length
    to_y_up = np.array(((s, 0, 0), (0, 0, s), (0, -s, 0)), dtype=np.float64).T  # row vectors: (x, y, z) -> s(x, z, -y)

    def joints_for(armature):
        if armature.name_full in armature_nodes:
            return armature_nodes[armature.name_full]
        bones = _ordered_bones(armature)
        arm_node = node_of(armature, None, convert(armature.matrix_world))
        roots.append(arm_node["id"])
        ids = {}
        for bone in bones:
            # The pose shown at export time is each joint's default; the bind (rest) pose goes in the skin.
            pose = armature.pose.bones[bone.name]
            local = pose.matrix if bone.parent is None else armature.pose.bones[bone.parent.name].matrix.inverted() @ pose.matrix
            node = node_of(armature, bone, convert(local))
            ids[bone.name] = node["id"]
            parent = arm_node if bone.parent is None else node_of.nodes[ids[bone.parent.name]]
            parent.setdefault("children", []).append(node["id"])
        armature_nodes[armature.name_full] = (bones, ids)
        owners.append(("armature", armature, bones, ids))
        return bones, ids

    for obj in objects:
        armature = _armature(obj)
        mesh = obj.data
        if len(mesh.vertices) > 1_000_000:
            raise ValueError(f"Object '{obj.name}': too many vertices")
        count = len(mesh.vertices)
        columns = []
        key = mesh.shape_keys
        targets = []
        rest = np.empty(count * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", rest)
        if key and len(key.key_blocks) > 1:
            if not key.use_relative:
                raise ValueError(f"Object '{obj.name}': absolute shape keys are unsupported; use relative shape keys")
            reference = key.reference_key
            reference.data.foreach_get("co", rest)
            for block in key.key_blocks:
                if block == reference:
                    continue
                if block.relative_key != reference or block.vertex_group or block.mute:
                    raise ValueError(f"Shape key '{block.name}' of '{obj.name}': keys must be relative to the basis, unmuted and without a vertex group")
                co = np.empty(count * 3, dtype=np.float32)
                block.data.foreach_get("co", co)
                targets.append(block)
                columns.append(((co - rest).reshape(-1, 3).astype(np.float64) @ to_y_up).astype(np.float32))
        if armature:
            bones, ids = joints_for(armature)
            joint_of = {}
            deform = {bone.name: i for i, bone in enumerate(bones) if bone.use_deform}
            for group in obj.vertex_groups:
                if group.name in deform:
                    joint_of[group.index] = deform[group.name]
            joints = np.zeros((count, MAX_INFLUENCES), dtype=np.float32)
            weights = np.zeros((count, MAX_INFLUENCES), dtype=np.float32)
            for vertex in mesh.vertices:
                pairs = sorted(((g.weight, joint_of[g.group]) for g in vertex.groups if g.group in joint_of and g.weight > 0), reverse=True)
                if not pairs:
                    raise ValueError(f"Object '{obj.name}': vertex {vertex.index} has no deform-bone weight; weight every vertex to a bone")
                if len(pairs) > MAX_INFLUENCES:
                    raise ValueError(f"Object '{obj.name}': vertex {vertex.index} has {len(pairs)} bone influences; limit them to {MAX_INFLUENCES} (Weights > Limit Total)")
                total = sum(w for w, _ in pairs)
                for slot, (weight, joint) in enumerate(pairs):
                    joints[vertex.index, slot] = joint
                    weights[vertex.index, slot] = weight / total
            columns = [joints, weights] + columns
        loops = np.empty(len(mesh.loops), dtype=np.int32)
        mesh.loops.foreach_get("vertex_index", loops)
        extra = np.concatenate(columns, axis=1)[loops].astype("<f4")
        slots = tuple(slot.material for slot in obj.material_slots)
        primitives = pack(obj, mesh, slots, extra, rest)
        if primitives is None:
            continue
        for primitive in primitives:
            columns_of = primitive.pop("extra")
            at = 0
            if armature:
                joint_values, weight_values = columns_of[:, :8], columns_of[:, 8:16]
                at = 16
                primitive["attributes"] = {
                    "JOINTS_0": data.add(joint_values[:, :4], "VEC4", 5123),
                    "WEIGHTS_0": data.add(weight_values[:, :4], "VEC4", 5126),
                }
                if weight_values[:, 4:].any():
                    primitive["attributes"]["JOINTS_1"] = data.add(joint_values[:, 4:], "VEC4", 5123)
                    primitive["attributes"]["WEIGHTS_1"] = data.add(weight_values[:, 4:], "VEC4", 5126)
            if targets:
                primitive["targets"] = [{"POSITION": data.add(columns_of[:, at + 3 * k:at + 3 * k + 3], "VEC3", 5126, minmax=True)} for k in range(len(targets))]
        mesh_index = len(geometry)
        geometry.append(primitives)
        if armature:
            node = node_of(obj, None, Matrix.Identity(4), mesh=mesh_index)
            bones, ids = armature_nodes[armature.name_full]
            binds = []
            for bone in bones:
                bind = convert((armature.matrix_world @ bone.matrix_local).inverted() @ obj.matrix_world)
                binds.append([bind[r][c] for c in range(4) for r in range(4)])
            node["skin"] = len(skins)
            skins.append({"joints": [ids[bone.name] for bone in bones], "inverseBindMatrices": data.add(binds, "MAT4", 5126), "name": armature.name})
        else:
            node = node_of(obj, None, convert(obj.matrix_world), mesh=mesh_index)
        roots.append(node["id"])
        if targets:
            node_of.meshes[mesh_index] = {"weights": [block.value for block in targets], "extras": {"targetNames": [block.name for block in targets]}}
            owners.append(("key", key, targets, node["id"]))
    if object_animation:
        from .objects import hierarchy
        roots, object_owners = hierarchy(context, node_of)
        owners += object_owners
    animations = _sample(context, owners, node_of, data)
    fields = {}
    if data.blob:
        fields = {"bufferViews": data.views, "accessors": data.accessors}
        if skins:
            fields["skins"] = skins
        if animations:
            fields["animations"] = animations
    return roots, fields, bytes(data.blob)


def _actions(owner):
    data = owner.animation_data
    if not data:
        return []
    actions = [data.action] if data.action else []
    for track in data.nla_tracks:
        for strip in track.strips:
            if strip.action and strip.action not in actions:
                actions.append(strip.action)
    return actions


def _assign(data, action, id_type, slot=None):
    data.action = action
    if action is not None and slot is not None and hasattr(data, "action_slot"):
        data.action_slot = slot
    if action is not None and hasattr(data, "action_slot") and data.action_slot is None:
        slots = [slot for slot in action.slots if slot.target_id_type == id_type] or list(action.slots)
        if slots:
            data.action_slot = slots[0]


def _sample(context, owners, node_of, data):  # noqa: C901
    """One clip per action, sampled at every frame of its range with NLA off; restores the scene afterwards."""
    scene = context.scene
    fps = scene.render.fps / scene.render.fps_base
    clips, uses, slots = {}, {}, {}
    for kind, owner, *_ in owners:
        uses[owner.as_pointer()] = _actions(owner)
        ad = owner.animation_data
        if ad:
            if ad.action:
                slots[(owner.as_pointer(), ad.action.as_pointer())] = getattr(ad, "action_slot", None)
            for track in ad.nla_tracks:
                for strip in track.strips:
                    if strip.action:
                        slots.setdefault((owner.as_pointer(), strip.action.as_pointer()), getattr(strip, "action_slot", None))
        for action in uses[owner.as_pointer()]:
            clips.setdefault(action.name_full, action)
    saved = []
    for kind, owner, *_ in owners:
        if owner.animation_data:
            ad = owner.animation_data
            saved.append((ad, ad.action, getattr(ad, "action_slot", None), ad.use_nla))
    frame, subframe = scene.frame_current, scene.frame_subframe
    channels_of = ("location", "rotation_quaternion", "rotation_euler", "rotation_axis_angle", "scale")
    shown = []
    for kind, owner, *rest in owners:
        if kind == "armature":
            shown += [(pose, name, tuple(getattr(pose, name))) for pose in owner.pose.bones for name in channels_of]
        elif kind == "object":
            shown += [(owner, name, tuple(getattr(owner, name))) for name in channels_of]
        else:
            shown += [(block, "value", block.value) for block in rest[0]]
    animations = []

    try:
        for name, action in clips.items():
            start, end = (int(round(v)) for v in action.frame_range)
            frames = list(range(start, max(start, end) + 1))
            active = []
            # Every clip starts from the pose shown at export, so a part the clip does not key keeps its default.
            for target, name, value in shown:
                setattr(target, name, value)
            for kind, owner, *rest in owners:
                ad = owner.animation_data
                if not ad:
                    continue
                ad.use_nla = False
                _assign(ad, None, None)
                if action in uses[owner.as_pointer()]:
                    _assign(ad, action, "KEY" if kind == "key" else "OBJECT", slots.get((owner.as_pointer(), action.as_pointer())))
            # Every joint and every shape-key set gets a channel in every clip, so a clip is whole on its own: a
            # player that keeps the last clip's values on the nodes a new clip leaves alone still shows this pose.
            for kind, owner, *rest in owners:
                active.append((kind, owner, rest))
            samples = {}
            for f in frames:
                scene.frame_set(f)
                for kind, owner, rest in active:
                    if kind == "armature":
                        bones, ids = rest
                        for bone in bones:
                            pose = owner.pose.bones[bone.name]
                            local = pose.matrix if bone.parent is None else owner.pose.bones[bone.parent.name].matrix.inverted() @ pose.matrix
                            t, r, s = _trs(node_of.convert(local))
                            samples.setdefault((ids[bone.name], "translation"), []).append(t)
                            samples.setdefault((ids[bone.name], "rotation"), []).append(r)
                            samples.setdefault((ids[bone.name], "scale"), []).append(s)
                    elif kind == "object":
                        node, local = rest
                        t, r, s = node_of.trs(owner, None, local(owner))
                        for path, value in (("translation", t), ("rotation", r), ("scale", s)):
                            samples.setdefault((node, path), []).append(value)
                    else:
                        targets, node = rest
                        samples.setdefault((node, "weights"), []).append([block.value for block in targets])
            if not samples:
                continue
            times = data.add([(f - start) / fps for f in frames], "SCALAR", 5126, minmax=True)
            still = None
            channels, samplers = [], []
            for (node, path), values in samples.items():
                values = np.array(values, dtype=np.float64)
                if path == "rotation":
                    for i in range(1, len(values)):
                        if np.dot(values[i - 1], values[i]) < 0:
                            values[i] = -values[i]
                source = times
                if len(values) > 1 and np.abs(values - values[0]).max() < 1e-7:
                    # Constant over the clip: one key on a one-key timeline.
                    if still is None:
                        still = data.add([0.0], "SCALAR", 5126, minmax=True)
                    source, values = still, values[:1]
                samplers.append({"input": source, "output": data.add(values.reshape(-1) if path == "weights" else values, "SCALAR" if path == "weights" else {"rotation": "VEC4"}.get(path, "VEC3"), 5126), "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})
            if channels:
                animations.append({"name": action.name, "channels": channels, "samplers": samplers})
    finally:
        for target, name, value in shown:
            setattr(target, name, value)
        for ad, action, slot, nla in saved:
            ad.action = action
            if slot is not None and hasattr(ad, "action_slot"):
                ad.action_slot = slot
            ad.use_nla = nla
        scene.frame_set(frame, subframe=subframe)
    return animations

