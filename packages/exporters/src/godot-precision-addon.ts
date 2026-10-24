// Godot 4 editor addon that imports an exact static precision bundle as a persistent scene.
import { nativeAppNames, nativeExtension } from './native-names.js';

/** Options for {@link createGodotPrecisionAddon}. */
export interface GodotPrecisionAddonOptions {
  /** The owning application: names the plugin, importer ID (`<appname>.precision.v1`), metadata keys and log lines. */
  appName: string;
  /** The bundle manifest's file extension, without the dot, that the importer claims. */
  extension: string;
}

/** The addon's four files, to be written beneath `addons/<folder>/` in the bundle. */
export interface GodotPrecisionAddon {
  /** `precision.gdshader`: unshaded, unculled, nearest/clamp atlas, normals from CUSTOM0. */
  readonly shader: string;
  /** `plugin.cfg`. */
  readonly pluginConfig: string;
  /** `plugin.gd`: registers the importer. */
  readonly plugin: string;
  /** `importer.gd`: the EditorImportPlugin. */
  readonly importer: string;
}

/**
 * A Godot 4 EditorImportPlugin addon for precision bundles: Float32 positions as written, normals carried in CUSTOM0,
 * original atlas pixels with nearest and clamp sampling, and every source object, surface and material tagged with
 * `<appname>_source_*` metadata. The importer checks the result after import and on reopen, and prints
 * `<APPNAME>_GODOT_PRECISION PASS` or `FAIL`.
 * @throws TypeError for an invalid `appName` or `extension`.
 */
export function createGodotPrecisionAddon(options: GodotPrecisionAddonOptions): GodotPrecisionAddon {
  const n = nativeAppNames(options?.appName);
  const o = { extension: nativeExtension(options.extension, 'extension') };
  return Object.freeze({
    shader: `shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_opaque;
uniform sampler2D atlas_texture : source_color, filter_nearest, repeat_disable;
void vertex() { NORMAL = CUSTOM0.xyz; }
void fragment() { ALBEDO = texture(atlas_texture, UV).rgb * COLOR.rgb; }
`,
    pluginConfig: `[plugin]
name="${n.name} Precision"
description="Import static exact Float32 geometry, CUSTOM0 normals and original atlas pixels."
author="${n.name}"
version="1.0"
script="plugin.gd"
`,
    plugin: `@tool
extends EditorPlugin
var importer: EditorImportPlugin
func _enter_tree() -> void:
    importer = preload("importer.gd").new()
    add_import_plugin(importer)
func _exit_tree() -> void:
    remove_import_plugin(importer)
    importer = null
`,
    importer: String.raw`@tool
extends EditorImportPlugin
var failed := false
func _get_importer_name() -> String: return "${n.lower}.precision.v1"
func _get_visible_name() -> String: return "${n.name} static Float32 precision scene"
func _get_recognized_extensions() -> PackedStringArray: return PackedStringArray(["${o.extension}"])
func _get_save_extension() -> String: return "scn"
func _get_resource_type() -> String: return "PackedScene"
func _get_preset_count() -> int: return 1
func _get_preset_name(_index: int) -> String: return "Preserve every source attribute"
func _get_import_options(_path: String, _index: int) -> Array[Dictionary]: return []
func _get_format_version() -> int: return 1
func _can_import_threaded() -> bool: return false
func sha(bytes: PackedByteArray) -> String:
    var hashing := HashingContext.new()
    hashing.start(HashingContext.HASH_SHA256)
    hashing.update(bytes)
    return hashing.finish().hex_encode()
func check(ok: bool, label: String) -> bool:
    if not ok:
        failed = true
        push_error("${n.upper}_GODOT_PRECISION FAIL " + label)
    return ok
func local_file(base: String, filename: String) -> String:
    if not check(not filename.is_empty() and filename == filename.get_file() and not filename.contains("\\") and filename != "." and filename != "..", "Unsafe source member path"):
        return ""
    return base.path_join(filename)
func stream(geometry: PackedByteArray, info: Dictionary) -> PackedByteArray:
    var offset := int(info.offset)
    var length := int(info.byteLength)
    if not check(offset >= 0 and length > 0 and offset + length <= geometry.size(), "Raw stream range"):
        return PackedByteArray()
    var result := geometry.slice(offset, offset + length)
    check(sha(result) == str(info.sha256), "Every source stream SHA-256")
    check(length == int(info.count) * int(info.components) * 4, "Raw stream element count")
    return result
func floats(data: PackedByteArray) -> PackedFloat32Array:
    var result := PackedFloat32Array()
    result.resize(int(data.size()/4))
    for index in result.size(): result[index] = data.decode_float(index*4)
    return result
func vec3(values: PackedFloat32Array) -> PackedVector3Array:
    var result := PackedVector3Array()
    result.resize(int(values.size()/3))
    for index in result.size(): result[index] = Vector3(values[index*3],values[index*3+1],values[index*3+2])
    return result
func vec2(values: PackedFloat32Array) -> PackedVector2Array:
    var result := PackedVector2Array()
    result.resize(int(values.size()/2))
    for index in result.size(): result[index] = Vector2(values[index*2],values[index*2+1])
    return result
func colors(values: PackedFloat32Array) -> PackedColorArray:
    var result := PackedColorArray()
    result.resize(int(values.size()/4))
    for index in result.size(): result[index] = Color(values[index*4],values[index*4+1],values[index*4+2],values[index*4+3])
    return result
func build_scene(manifest: Dictionary, geometry: PackedByteArray, base: String, shader: Shader) -> Node3D:
    var textures := {}
    for image_info: Dictionary in manifest.images:
        var png := FileAccess.get_file_as_bytes(local_file(base,str(image_info.filename)))
        if not check(sha(png) == str(image_info.pngSha256), "Original PNG bytes"): return null
        var image := Image.new()
        if not check(image.load_png_from_buffer(png) == OK, "Decode original PNG"): return null
        image.convert(Image.FORMAT_RGBA8)
        if not check(image.get_width() == int(image_info.width) and image.get_height() == int(image_info.height) and sha(image.get_data()) == str(image_info.rgbaSha256), "Original full image dimensions and RGBA"): return null
        textures[str(image_info.id)] = ImageTexture.create_from_image(image)
    var asset := Node3D.new()
    asset.name = "${n.name}PrecisionAsset"
    asset.set_meta("${n.lower}_source_snapshot_sha256", str(manifest.sourceSnapshotSha256))
    asset.set_meta("${n.lower}_capture_options_json", str(manifest.sourceSnapshotOptionsJSON))
    asset.set_meta("${n.lower}_source_master_sha256", str(manifest.sourceMaster.sha256))
    asset.set_meta("${n.lower}_coordinate_frame", "captured-world-baked-identity-nodes")
    var objects := {}
    for index in manifest.objects.size():
        var info: Dictionary = manifest.objects[index]
        var node := Node3D.new()
        node.name = "Object_%06d" % index
        node.set_meta("${n.lower}_source_object_id", str(info.id))
        node.set_meta("${n.lower}_source_object_name", str(info.name))
        node.set_meta("${n.lower}_authored_transform_json", str(info.authoredTransformJSON))
        if not check(not objects.has(str(info.id)), "Unique logical source objects"):
            asset.free()
            return null
        objects[str(info.id)] = node
    for info: Dictionary in manifest.objects:
        var node: Node3D = objects[str(info.id)]
        var parent: Node3D = asset if info.parentId == null else objects.get(str(info.parentId))
        if not check(parent != null, "Complete logical parents"):
            asset.free()
            return null
        parent.add_child(node)
    # Ownership is assigned only after all ancestors are attached. Source IDs need
    # not sort parent-before-child, and PackedScene must include every child.
    for node: Node3D in objects.values():
        node.owner = asset
    for index in manifest.surfaces.size():
        var info: Dictionary = manifest.surfaces[index]
        var attrs: Dictionary = info.attributes
        var arrays: Array = []
        arrays.resize(Mesh.ARRAY_MAX)
        arrays[Mesh.ARRAY_VERTEX] = vec3(floats(stream(geometry,attrs.position)))
        var original_normals := floats(stream(geometry,attrs.normal))
        arrays[Mesh.ARRAY_NORMAL] = vec3(original_normals)
        arrays[Mesh.ARRAY_CUSTOM0] = original_normals
        arrays[Mesh.ARRAY_TEX_UV] = vec2(floats(stream(geometry,attrs.uv)))
        arrays[Mesh.ARRAY_COLOR] = colors(floats(stream(geometry,attrs.color)))
        var raw_indices := stream(geometry,attrs.indices)
        var indices := PackedInt32Array()
        indices.resize(int(raw_indices.size()/4))
        for at in indices.size(): indices[at] = raw_indices.decode_s32(at*4)
        arrays[Mesh.ARRAY_INDEX] = indices
        if failed:
            asset.free()
            return null
        var mesh := ArrayMesh.new()
        var flags: int = Mesh.ARRAY_CUSTOM_RGB_FLOAT << Mesh.ARRAY_FORMAT_CUSTOM0_SHIFT
        mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES,arrays,[],{},flags)
        if not check(mesh.get_surface_count() == 1, "Native complete surface creation"):
            asset.free()
            return null
        var material := ShaderMaterial.new()
        material.shader = shader
        material.set_shader_parameter("atlas_texture",textures[str(info.imageId)])
        material.set_meta("${n.lower}_source_material_id",str(info.materialId))
        material.set_meta("${n.lower}_source_image_id",str(info.imageId))
        mesh.surface_set_material(0,material)
        var instance := MeshInstance3D.new()
        instance.name = "Geometry_%06d" % index
        instance.mesh = mesh
        instance.set_meta("${n.lower}_source_surface_index",index)
        objects[str(info.objectId)].add_child(instance)
        instance.owner = asset
    return asset
func collect(node: Node, objects: Dictionary, surfaces: Dictionary, is_root := false) -> void:
    var logical := node.has_meta("${n.lower}_source_object_id")
    var surface := node.has_meta("${n.lower}_source_surface_index")
    check(node.get_script() == null,"Native geometry graph has no behavior scripts")
    if is_root:
        check(node.get_class() == "Node3D" and not logical and not surface,"Exact owned native root role")
    else:
        check(logical != surface,"Every native descendant has exactly one captured source role")
        if logical: check(node.get_class() == "Node3D","Logical owner remains a plain native transform node")
        if surface: check(node.get_class() == "MeshInstance3D" and node.get_child_count() == 0,"Geometry remains an owned native mesh leaf")
    if node.has_meta("${n.lower}_source_object_id"):
        var id := str(node.get_meta("${n.lower}_source_object_id"))
        check(not objects.has(id),"No duplicate native object identity")
        objects[id] = node
    if node.has_meta("${n.lower}_source_surface_index"):
        var index := int(node.get_meta("${n.lower}_source_surface_index"))
        check(not surfaces.has(index),"No duplicate native surface identity")
        surfaces[index] = node
    for child in node.get_children(): collect(child,objects,surfaces)
func audit(asset: Node3D, manifest: Dictionary) -> Dictionary:
    var objects := {}
    var surfaces := {}
    collect(asset,objects,surfaces,true)
    check(asset.transform == Transform3D.IDENTITY and asset.visible,"Native root preserves baked world geometry and visibility")
    check(objects.size() == manifest.objects.size() and surfaces.size() == manifest.surfaces.size(),"Every native logical object and surface")
    check(str(asset.get_meta("${n.lower}_source_snapshot_sha256","")) == str(manifest.sourceSnapshotSha256),"Captured source snapshot identity")
    check(str(asset.get_meta("${n.lower}_capture_options_json","")) == str(manifest.sourceSnapshotOptionsJSON),"Exact captured frame/selection/pose/origin options")
    check(str(asset.get_meta("${n.lower}_source_master_sha256","")) == str(manifest.sourceMaster.sha256),"Original master identity")
    for info: Dictionary in manifest.objects:
        var node: Node3D = objects.get(str(info.id))
        if not check(node != null,"Native source object exists"): return {}
        var parent_id: Variant = null if node.get_parent() == asset else node.get_parent().get_meta("${n.lower}_source_object_id",null)
        check(parent_id == info.parentId,"Exact logical ancestry")
        check(node.transform == Transform3D.IDENTITY,"Explicit baked native identity transform")
        check(node.visible,"Captured logical owner remains visible")
        check(str(node.get_meta("${n.lower}_source_object_name","")) == str(info.name),"Original object name")
        check(str(node.get_meta("${n.lower}_authored_transform_json","")) == str(info.authoredTransformJSON),"Exact authored TRS JSON retained")
    var triangles := 0
    var vertices := 0
    for index in manifest.surfaces.size():
        var info: Dictionary = manifest.surfaces[index]
        var instance: MeshInstance3D = surfaces.get(index) as MeshInstance3D
        if not check(instance != null and instance.mesh != null,"Native MeshInstance3D exists"): return {}
        check(instance.transform == Transform3D.IDENTITY,"Native geometry identity transform")
        check(instance.visible and instance.transparency == 0.0 and instance.visibility_range_begin == 0.0 and instance.visibility_range_end == 0.0,"Complete opaque native geometry remains visible without distance filtering")
        check(instance.material_override == null and instance.material_overlay == null and instance.get_surface_override_material(0) == null,"Stored precision material is not bypassed by native overrides")
        check(instance.skin == null and instance.skeleton.is_empty() and instance.get_blend_shape_count() == 0,"Static native geometry has no deformation binding")
        check(str(instance.get_parent().get_meta("${n.lower}_source_object_id","")) == str(info.objectId),"Exact surface owner")
        var mesh := instance.mesh as ArrayMesh
        if not check(mesh != null,"Native geometry retains its explicit ArrayMesh representation"): return {}
        if not check(mesh.get_surface_count() == 1,"One complete native associated surface"): return {}
        check(mesh.surface_get_primitive_type(0) == Mesh.PRIMITIVE_TRIANGLES and mesh.shadow_mesh == null,"Native indices render as the complete triangle mesh without shadow substitutes")
        var arrays := mesh.surface_get_arrays(0)
        var p: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
        var n: PackedFloat32Array = arrays[Mesh.ARRAY_CUSTOM0]
        var uv: PackedVector2Array = arrays[Mesh.ARRAY_TEX_UV]
        var c: PackedColorArray = arrays[Mesh.ARRAY_COLOR]
        var ix: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
        check(p.size() == int(info.vertexCount) and uv.size() == p.size() and c.size() == p.size() and n.size() == p.size()*3,"Complete native associated corner attribute counts")
        check(ix.size() == int(info.triangleCount)*3,"Actual native triangle count")
        check(sha(p.to_byte_array()) == str(info.attributes.position.sha256),"Every native Float32 position exact")
        check(sha(n.to_byte_array()) == str(info.attributes.normal.sha256),"Every native effective CUSTOM0 normal exact")
        check(sha(uv.to_byte_array()) == str(info.attributes.uv.sha256),"Every native Float32 UV exact")
        check(sha(c.to_byte_array()) == str(info.attributes.color.sha256),"Every native white Float32 RGBA exact")
        check(sha(ix.to_byte_array()) == str(info.attributes.indices.sha256),"Every native CW index association exact")
        var format := mesh.surface_get_format(0)
        check(((format >> Mesh.ARRAY_FORMAT_CUSTOM0_SHIFT) & Mesh.ARRAY_FORMAT_CUSTOM_MASK) == Mesh.ARRAY_CUSTOM_RGB_FLOAT and (format & Mesh.ARRAY_FLAG_COMPRESS_ATTRIBUTES) == 0,"Actual uncompressed native RGB_FLOAT normal channel")
        var material := mesh.surface_get_material(0) as ShaderMaterial
        if not check(material != null and material.shader != null,"Native explicit precision ShaderMaterial"): return {}
        check(instance.get_active_material(0) == material and material.next_pass == null,"Effective native material is exactly the qualified single-pass shader")
        check(sha(material.shader.code.to_utf8_buffer()) == str(manifest.shaderSha256),"Exact effective-normal shader")
        check(str(material.get_meta("${n.lower}_source_material_id","")) == str(info.materialId) and str(material.get_meta("${n.lower}_source_image_id","")) == str(info.imageId),"Exact native material and image ownership")
        var texture := material.get_shader_parameter("atlas_texture") as Texture2D
        if not check(texture != null,"Live native original-image material binding"): return {}
        var image := texture.get_image()
        if not check(image != null,"Native texture pixels available"): return {}
        if image.is_compressed(): check(image.decompress() == OK,"Native original image decompresses")
        image.convert(Image.FORMAT_RGBA8)
        var found := false
        for row: Dictionary in manifest.images:
            if str(row.id) == str(info.imageId):
                found = true
                check(image.get_width() == int(row.width) and image.get_height() == int(row.height) and sha(image.get_data()) == str(row.rgbaSha256),"Every native original RGBA pixel and dimension")
        check(found,"Associated source image identity exists")
        triangles += int(ix.size()/3)
        vertices += p.size()
    check(triangles == int(manifest.triangles) and vertices == int(manifest.vertices),"Complete native scene conservation")
    return {"passed":not failed,"triangles":triangles,"vertices":vertices,"surfaces":surfaces.size(),"objects":objects.size(),"normalChannel":"CUSTOM0_RGB_FLOAT","shaderOutputNumericPrecisionClaimed":false}
func _import(source_file: String, save_path: String, _options: Dictionary, _platform_variants: Array[String], _gen_files: Array[String]) -> Error:
    return import_scene(source_file,save_path + ".scn")
func import_scene(source_file: String, output_file: String) -> Error:
    failed = false
    var source_bytes := FileAccess.get_file_as_bytes(source_file)
    var parsed: Variant = JSON.parse_string(source_bytes.get_string_from_utf8())
    if not check(parsed is Dictionary,"Readable precision manifest"): return ERR_INVALID_DATA
    var manifest: Dictionary = parsed
    if not check(int(manifest.get("version",0)) == 1 and str(manifest.get("profileId","")) == "godot-static-custom0-float32-v1", "Supported precision manifest version"): return ERR_INVALID_DATA
    var base := source_file.get_base_dir()
    var geometry := FileAccess.get_file_as_bytes(local_file(base,str(manifest.geometry.filename)))
    if not check(geometry.size() == int(manifest.geometry.byteLength) and sha(geometry) == str(manifest.geometry.sha256),"Complete source geometry hash"): return ERR_INVALID_DATA
    var master := FileAccess.get_file_as_bytes(local_file(base,str(manifest.sourceMaster.filename)))
    if not check(sha(master) == str(manifest.sourceMaster.sha256),"Complete editable source and workspace hash"): return ERR_INVALID_DATA
    var addon_path: String = get_script().resource_path.get_base_dir()
    var shader_bytes := FileAccess.get_file_as_bytes(addon_path.path_join("precision.gdshader"))
    if not check(sha(shader_bytes) == str(manifest.shaderSha256) and sha(FileAccess.get_file_as_bytes(get_script().resource_path)) == str(manifest.importerSha256),"Exact versioned native shader and importer source"): return ERR_INVALID_DATA
    var shader := Shader.new()
    shader.code = shader_bytes.get_string_from_utf8()
    var asset := build_scene(manifest,geometry,base,shader)
    if asset == null or failed: return ERR_INVALID_DATA
    var before := audit(asset,manifest)
    if not bool(before.get("passed",false)):
        asset.free()
        return ERR_INVALID_DATA
    var packed := PackedScene.new()
    if not check(packed.pack(asset) == OK,"Native PackedScene packing"):
        asset.free()
        return ERR_CANT_CREATE
    var save_error := ResourceSaver.save(packed,output_file)
    asset.free()
    if not check(save_error == OK,"Actual persistent native scene save"): return save_error
    var reopened := ResourceLoader.load(output_file,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
    if not check(reopened != null,"Actual cache-ignored native scene reopen"): return ERR_CANT_OPEN
    var instance := reopened.instantiate() as Node3D
    if not check(instance != null,"Saved native scene instantiates"): return ERR_INVALID_DATA
    var after := audit(instance,manifest)
    instance.free()
    check(sha(FileAccess.get_file_as_bytes(source_file)) == sha(source_bytes),"Source manifest unchanged")
    check(sha(FileAccess.get_file_as_bytes(local_file(base,str(manifest.geometry.filename)))) == str(manifest.geometry.sha256),"Source geometry unchanged")
    check(sha(FileAccess.get_file_as_bytes(local_file(base,str(manifest.sourceMaster.filename)))) == str(manifest.sourceMaster.sha256),"Complete editable master unchanged")
    if failed or not bool(after.get("passed",false)): return ERR_INVALID_DATA
    print("${n.upper}_GODOT_PRECISION PASS " + JSON.stringify({"sourceManifestSha256":sha(source_bytes),"nativeSceneSha256":sha(FileAccess.get_file_as_bytes(output_file)),"beforeSave":before,"afterCacheIgnoredReopen":after,"nativePersistenceVerified":true}))
    return OK
`,
  });
}
