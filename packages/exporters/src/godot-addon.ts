// Godot editor add-on fixing linear COLOR_0 and clip looping on glTF import; separate from the import bundle.
import { type BundleEntry, utf8 } from './import-data.js';

export type { BundleEntry } from './import-data.js';

const ADDON = 'addons/gltf_import';

const pluginScript = `@tool
extends EditorPlugin

var extension: GLTFDocumentExtension

func _enter_tree() -> void:
\textension = preload("extension.gd").new()
\tGLTFDocument.register_gltf_document_extension(extension)

func _exit_tree() -> void:
\tGLTFDocument.unregister_gltf_document_extension(extension)
\textension = null
`;

// Runs after Godot parses a glTF and before it builds the scene. Every binding is checked before anything changes.
const extensionScript = `@tool
extends GLTFDocumentExtension

func _import_post_parse(state: GLTFState) -> Error:
\tvar clips: Variant = state.json.get("animations", [])
\tvar animations: Array[GLTFAnimation] = state.get_animations()
\tif not clips is Array or clips.size() != animations.size():
\t\treturn ERR_INVALID_DATA
\tvar source_meshes: Variant = state.json.get("meshes", [])
\tvar meshes: Array[GLTFMesh] = state.get_meshes()
\tif not source_meshes is Array or source_meshes.size() != meshes.size():
\t\treturn ERR_INVALID_DATA
\tvar bindings: Array = []
\tvar usages: Dictionary = {}
\tfor m in meshes.size():
\t\tvar primitives: Variant = source_meshes[m].get("primitives") if source_meshes[m] is Dictionary else null
\t\tvar entry: GLTFMesh = meshes[m]
\t\tif not primitives is Array or entry == null or entry.mesh == null or primitives.size() != entry.mesh.get_surface_count():
\t\t\treturn ERR_INVALID_DATA
\t\tvar overrides: Array[Material] = entry.instance_materials
\t\tif not overrides.is_empty() and overrides.size() != primitives.size():
\t\t\treturn ERR_INVALID_DATA
\t\tfor surface in primitives.size():
\t\t\tvar attributes: Variant = primitives[surface].get("attributes") if primitives[surface] is Dictionary else null
\t\t\tif not attributes is Dictionary:
\t\t\t\treturn ERR_INVALID_DATA
\t\t\tvar colored: bool = attributes.has("COLOR_0")
\t\t\tvar materials: Array = [entry.mesh.get_surface_material(surface)]
\t\t\tif not overrides.is_empty():
\t\t\t\tmaterials.append(overrides[surface])
\t\t\tfor material in materials:
\t\t\t\tif material == null and not colored:
\t\t\t\t\tcontinue
\t\t\t\tif not material is BaseMaterial3D:
\t\t\t\t\treturn ERR_UNAVAILABLE
\t\t\t\tusages[material] = int(usages.get(material, 0)) | (1 if colored else 2)
\t\t\tbindings.append({"entry": entry, "surface": surface, "colored": colored, "materials": materials})
\t# A material used by colored and uncolored primitives is cloned once; textures and sharing stay.
\tvar targets: Dictionary = {}
\tfor original in usages:
\t\tvar both: bool = usages[original] == 3
\t\tvar variants: Dictionary = {(original.vertex_color_use_as_albedo if both else usages[original] == 1): original}
\t\tif both:
\t\t\tvariants[not original.vertex_color_use_as_albedo] = original.duplicate(false)
\t\tfor colored in variants:
\t\t\tvariants[colored].vertex_color_use_as_albedo = colored
\t\t\tvariants[colored].vertex_color_is_srgb = false
\t\ttargets[original] = variants
\tfor binding in bindings:
\t\tvar materials: Array = binding.materials
\t\tif materials[0] != null:
\t\t\tbinding.entry.mesh.set_surface_material(binding.surface, targets[materials[0]][binding.colored])
\t\tif materials.size() == 2 and materials[1] != null:
\t\t\tvar overrides: Array[Material] = binding.entry.instance_materials
\t\t\toverrides[binding.surface] = targets[materials[1]][binding.colored]
\t\t\tbinding.entry.instance_materials = overrides
\tfor i in animations.size():
\t\tvar extras: Variant = clips[i].get("extras") if clips[i] is Dictionary else null
\t\tif extras is Dictionary and extras.get("loop") is bool:
\t\t\tanimations[i].loop = extras.loop
\treturn OK
`;

/**
 * A Godot 4 editor add-on, as files under `addons/gltf_import/`, that corrects two things Godot's glTF import gets
 * wrong for these exporters' GLBs: linear `COLOR_0` (Godot treats it as sRGB, and ignores it unless the material
 * opts in), and clip looping (glTF has no loop flag; the add-on reads each clip's `extras.loop`). Save the files in the
 * project, enable "glTF vertex colors and loops" under Project Settings > Plugins and reimport. Only material
 * vertex-color flags and clip loop flags change; a material shared by colored and uncolored primitives is cloned
 * once. Pack the entries with `encodeZIP` or write them out as they are.
 */
export function createGodotImportAddon(): BundleEntry[] {
  return [
    [
      'plugin.cfg',
      '[plugin]\nname="glTF vertex colors and loops"\ndescription="Linear glTF COLOR_0 and extras.loop clip looping on import."\nauthor="Margo Engine"\nversion="1.0.0"\nscript="plugin.gd"\n',
    ],
    ['plugin.gd', pluginScript],
    ['extension.gd', extensionScript],
  ].map(([name, text]) => ({ name: `${ADDON}/${name}`, data: utf8.encode(text) }));
}
