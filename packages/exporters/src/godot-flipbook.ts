// Godot 4 runtime script that plays UV flipbooks on imported meshes.
import { nativeAppNames } from './native-names.js';

/** One flipbook: the emitted node and surface it animates and its frames (UV offset and scale per frame). */
export interface GodotFlipbookBinding {
  readonly nodePath: string;
  readonly surface: number;
  readonly fps: number;
  readonly startFrame: number;
  readonly frames: readonly {
    readonly offset: readonly [number, number];
    readonly scale: readonly [number, number];
  }[];
}

/**
 * A Godot 4 `Node3D` script that reads `flipbook-bindings.json` (format `<appName>Flipbook`, version 1: a list of
 * {@link GodotFlipbookBinding}) beside it and steps each bound surface's UV offset and scale. Each binding owns a
 * surface override, so imported meshes and textures stay shared.
 * @throws TypeError for an invalid `appName`.
 */
export function createGodotFlipbookPlayer(options: { appName: string }): string {
  const n = nativeAppNames(options?.appName);
  return String.raw`extends Node3D
## ${n.name} flipbooks. bindings_path is relative to this script's directory.
## Each binding owns a surface override; imported meshes and textures stay shared.
@export var bindings_path: String = "flipbook-bindings.json"
@export var playing: bool = true

var last_error: String = ""
var _bindings: Array[Dictionary] = []
var _elapsed: float = 0.0

func _ready() -> void:
    if not reload_bindings():
        push_error("${n.name} flipbook: " + last_error)

func _process(delta: float) -> void:
    if playing and not _bindings.is_empty():
        if not is_finite(delta) or delta < 0.0:
            _fail("Playback delta must be finite and nonnegative.")
            return
        seek(_elapsed + delta)

func seek(seconds: float) -> bool:
    if not is_finite(seconds) or seconds < 0.0:
        return _fail("Seek time must be finite and nonnegative.")
    _elapsed = seconds
    _apply_frames()
    return true

## A rejected reload leaves every currently playing surface and clock unchanged.
func reload_bindings() -> bool:
    last_error = ""
    if bindings_path.is_empty() or bindings_path.is_absolute_path() or bindings_path.contains(":") or bindings_path.contains("\\"):
        return _fail("bindings_path must be a relative JSON path beside the player script.")
    for part: String in bindings_path.split("/"):
        if part.is_empty() or part == "..":
            return _fail("bindings_path must not contain empty or parent-directory segments.")
    var script_path: String = get_script().resource_path
    if script_path.is_empty():
        return _fail("Save the player script before loading its relative JSON bindings.")
    var path: String = script_path.get_base_dir().path_join(bindings_path)
    var file: FileAccess = FileAccess.open(path, FileAccess.READ)
    if file == null:
        return _fail("Cannot read bindings JSON: " + path + " (" + error_string(FileAccess.get_open_error()) + ").")
    var contents: String = file.get_as_text()
    file.close()
    var parser: JSON = JSON.new()
    if parser.parse(contents) != OK:
        return _fail("Invalid bindings JSON at line " + str(parser.get_error_line()) + ": " + parser.get_error_message())
    var candidate: Array[Dictionary] = _prepare_bindings(parser.data)
    if not last_error.is_empty():
        return false
    # All validation and duplication succeeded before the first visible mutation.
    dispose()
    _bindings = candidate
    _elapsed = 0.0
    for binding: Dictionary in _bindings:
        var target: MeshInstance3D = binding["target"].get_ref() as MeshInstance3D
        target.set_surface_override_material(binding["surface"], binding["material"])
    _apply_frames()
    return true

## Restore only overrides still owned by this player. Safe to call repeatedly.
func dispose() -> void:
    for binding: Dictionary in _bindings:
        var target: MeshInstance3D = binding["target"].get_ref() as MeshInstance3D
        if is_instance_valid(target) and target.mesh != null and binding["surface"] < target.mesh.get_surface_count():
            if target.get_surface_override_material(binding["surface"]) == binding["material"]:
                target.set_surface_override_material(binding["surface"], binding["original_override"])
    _bindings.clear()

func _exit_tree() -> void:
    dispose()

func _fail(message: String) -> bool:
    last_error = message
    return false

func _finite_number(value: Variant) -> bool:
    return (typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT) and is_finite(float(value))

func _integer(value: Variant) -> bool:
    return _finite_number(value) and float(value) == floor(float(value))

func _pair(value: Variant) -> bool:
    return value is Array and value.size() == 2 and _finite_number(value[0]) and _finite_number(value[1])

func _keys(value: Dictionary, expected: Array[String]) -> bool:
    if value.size() != expected.size():
        return false
    for key: String in expected:
        if not value.has(key):
            return false
    return true

func _prepare_bindings(data: Variant) -> Array[Dictionary]:
    var prepared: Array[Dictionary] = []
    if not data is Dictionary:
        _fail("Bindings JSON must be an object.")
        return prepared
    if not _keys(data, ["format", "version", "bindings"]) or data.get("format") != "${n.name}Flipbook" or not _integer(data.get("version")) or data.get("version") != 1:
        _fail("Expected ${n.name}Flipbook bindings schema version 1.")
        return prepared
    if not data["bindings"] is Array:
        _fail("bindings must be an array.")
        return prepared
    var seen: Dictionary = {}
    for index: int in range(data["bindings"].size()):
        var entry: Variant = data["bindings"][index]
        var label: String = "Binding " + str(index) + ": "
        if not entry is Dictionary:
            _fail(label + "expected an object.")
            return []
        if not _keys(entry, ["nodePath", "surface", "fps", "startFrame", "frames"]):
            _fail(label + "expected nodePath, surface, fps, startFrame and frames only.")
            return []
        if not entry["nodePath"] is String or entry["nodePath"].is_empty():
            _fail(label + "nodePath must be a nonempty relative node path.")
            return []
        var node_path: NodePath = NodePath(entry["nodePath"])
        if node_path.is_absolute() or node_path.get_subname_count() != 0:
            _fail(label + "nodePath must target a descendant mesh, without resource/property subnames.")
            return []
        for part: int in range(node_path.get_name_count()):
            if node_path.get_name(part) == &"..":
                _fail(label + "nodePath must not traverse parent nodes.")
                return []
        var target: MeshInstance3D = get_node_or_null(node_path) as MeshInstance3D
        if target == null or not is_ancestor_of(target) or target.mesh == null:
            _fail(label + "nodePath must resolve to an existing descendant MeshInstance3D with a mesh.")
            return []
        if not _integer(entry["surface"]) or entry["surface"] < 0 or entry["surface"] >= target.mesh.get_surface_count():
            _fail(label + "surface must be an existing nonnegative mesh surface index.")
            return []
        var surface: int = int(entry["surface"])
        var key: String = str(target.get_instance_id()) + ":" + str(surface)
        if seen.has(key):
            _fail(label + "duplicate target mesh surface.")
            return []
        seen[key] = true
        if not _finite_number(entry["fps"]) or entry["fps"] < 4.0 or entry["fps"] > 12.0:
            _fail(label + "fps must be finite and between 4 and 12.")
            return []
        if not entry["frames"] is Array or entry["frames"].is_empty():
            _fail(label + "frames must be a nonempty array.")
            return []
        if not _integer(entry["startFrame"]) or entry["startFrame"] < 0 or entry["startFrame"] >= entry["frames"].size():
            _fail(label + "startFrame must be an integer within frames.")
            return []
        var frames: Array[Dictionary] = []
        var boundaries: PackedFloat64Array = PackedFloat64Array()
        var duration: float = 1.0 / float(entry["fps"])
        var boundary: float = 0.0
        for frame_index: int in range(entry["frames"].size()):
            var frame: Variant = entry["frames"][frame_index]
            var frame_label: String = label + "frame " + str(frame_index) + ": "
            if not frame is Dictionary or not _keys(frame, ["offset", "scale"]) or not _pair(frame.get("offset")) or not _pair(frame.get("scale")):
                _fail(frame_label + "expected finite offset and scale pairs.")
                return []
            var offset: Vector2 = Vector2(float(frame["offset"][0]), float(frame["offset"][1]))
            var scale: Vector2 = Vector2(float(frame["scale"][0]), float(frame["scale"][1]))
            # Validate JSON doubles before converting to Godot's Vector float width.
            # A half-pixel inset on a one-texel axis collapses exactly to its center.
            for axis: int in range(2):
                if frame["offset"][axis] < 0.0 or frame["scale"][axis] < 0.0 or frame["offset"][axis] + frame["scale"][axis] > 1.0:
                    _fail(frame_label + "rectangle must have nonnegative size and fit inside normalized atlas coordinates.")
                    return []
            frames.append({"offset": Vector3(offset.x, offset.y, 0.0), "scale": Vector3(scale.x, scale.y, 1.0)})
            boundary += duration
            boundaries.append(boundary)
        if target.material_override != null or target.material_overlay != null:
            _fail(label + "mesh-wide material_override/material_overlay is unsupported; use surface materials.")
            return []
        var original_override: Material = target.get_surface_override_material(surface)
        var original_material: Material = target.get_active_material(surface)
        # On reload, retain the true original rather than an earlier animated copy.
        for previous: Dictionary in _bindings:
            if previous["target"].get_ref() == target and previous["surface"] == surface and original_override == previous["material"]:
                original_override = previous["original_override"]
                original_material = previous["original_material"]
                break
        var source: BaseMaterial3D = original_material as BaseMaterial3D
        if source == null:
            _fail(label + "surface requires BaseMaterial3D; missing or ShaderMaterial surfaces are unsupported.")
            return []
        if source.next_pass != null or source.uv1_triplanar:
            _fail(label + "multipass and UV1 triplanar materials are unsupported.")
            return []
        var material: BaseMaterial3D = source.duplicate(false) as BaseMaterial3D
        if material == null or material == source:
            _fail(label + "could not isolate the surface material.")
            return []
        material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
        prepared.append({"target": weakref(target), "surface": surface, "original_override": original_override, "original_material": source, "material": material, "frames": frames, "start": int(entry["startFrame"]), "boundaries": boundaries, "period": boundary})
    return prepared

func _apply_frames() -> void:
    for binding: Dictionary in _bindings:
        var phase: float = fmod(_elapsed, binding["period"])
        var frame_index: int = binding["start"]
        for boundary: float in binding["boundaries"]:
            if phase < boundary:
                break
            frame_index = (frame_index + 1) % binding["frames"].size()
        var frame: Dictionary = binding["frames"][frame_index]
        var material: BaseMaterial3D = binding["material"]
        material.uv1_offset = frame["offset"]
        material.uv1_scale = frame["scale"]
`;
}
