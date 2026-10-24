// Godot material for baked GLBs: an unshaded lightmap shader and the post-import script that applies it.
import { type BundleEntry, utf8 } from './import-data.js';

export type { BundleEntry } from './import-data.js';

/** Options for {@link createGodotLightmapImport}: the bundle's file names, relative to the GLB's folder. */
export interface GodotLightmapImportOptions {
  /** Base colour PNG (sRGB) on TEXCOORD_0. */
  albedo: string;
  /** Lightmap PNG (linear, multiplied by `lightmapScale`) on TEXCOORD_1. */
  lightmap: string;
  /** Emission PNG (sRGB, multiplied by `emissionScale`) on TEXCOORD_0. Default none. */
  emission?: string;
  /** The lightmap's `lightmapScale` (at least 1). Default 1. */
  lightmapScale?: number;
  /** The emission's scale (at least 1). Default 1. */
  emissionScale?: number;
  /** Where to write the shader. Default 'godot/lightmap.gdshader'. */
  shader?: string;
  /** Where to write the post-import script. Default 'godot/lightmap_import.gd'. */
  script?: string;
}

const relative = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+$/.test(value))
    throw new TypeError(`${label} must be a relative path of letters, digits, _, -, . and /; pass a bundle file name`);
  return value;
};
const scale = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1)
    throw new RangeError(`${label} must be a finite number of at least 1; pass the bake's scale`);
  return value;
};

/**
 * A Godot 4 unshaded shader and an `EditorScenePostImport` script that show a baked GLB (a lightmap on TEXCOORD_1,
 * as the exporters write {@link LightmapData}) the way it was baked: `albedo * lightmap * lightmapScale + emission *
 * emissionScale`. Select the script as the GLB's Import Script and reimport; every MeshInstance3D gets the material.
 * Texture paths are read relative to the GLB's folder.
 * @throws TypeError for a path that is not a plain relative path; RangeError for a scale below 1.
 */
export function createGodotLightmapImport(options: GodotLightmapImportOptions): BundleEntry[] {
  const albedo = relative(options?.albedo, 'albedo'),
    lightmap = relative(options.lightmap, 'lightmap'),
    emission = options.emission === undefined ? undefined : relative(options.emission, 'emission'),
    lightmapScale = scale(options.lightmapScale ?? 1, 'lightmapScale'),
    emissionScale = scale(options.emissionScale ?? 1, 'emissionScale'),
    shader = relative(options.shader ?? 'godot/lightmap.gdshader', 'shader'),
    script = relative(options.script ?? 'godot/lightmap_import.gd', 'script');
  const shaderText = `shader_type spatial;
render_mode unshaded, cull_back;
uniform sampler2D albedo_texture : source_color, filter_linear, repeat_disable;
${emission ? 'uniform sampler2D emission_texture : source_color, filter_linear, repeat_disable;\n' : ''}uniform sampler2D lightmap_texture : filter_linear, repeat_disable;
uniform float lightmap_scale = 1.0;
${emission ? 'uniform float emission_scale = 1.0;\n' : ''}void fragment() {
  vec4 base = texture(albedo_texture, UV);
  ALBEDO = base.rgb * texture(lightmap_texture, UV2).rgb * lightmap_scale${emission ? '\n    + texture(emission_texture, UV).rgb * emission_scale' : ''};
  ALPHA = base.a;
}
`;
  const parameter = (name: string, value: string) => `    material.set_shader_parameter("${name}", ${value})\n`;
  const scriptText = `@tool
extends EditorScenePostImport

# Select this script as the GLB's Import Script, then Reimport.
func _post_import(scene: Node) -> Object:
    var folder := get_source_file().get_base_dir()
    var material := ShaderMaterial.new()
    material.shader = load(folder.path_join(${JSON.stringify(shader)}))
${parameter('albedo_texture', `load(folder.path_join(${JSON.stringify(albedo)}))`)}${emission ? parameter('emission_texture', `load(folder.path_join(${JSON.stringify(emission)}))`) : ''}${parameter('lightmap_texture', `load(folder.path_join(${JSON.stringify(lightmap)}))`)}${parameter('lightmap_scale', JSON.stringify(lightmapScale))}${emission ? parameter('emission_scale', JSON.stringify(emissionScale)) : ''}    if scene is MeshInstance3D:
        scene.material_override = material
    for mesh in scene.find_children("*", "MeshInstance3D", true, false):
        mesh.material_override = material
    return scene
`;
  return [
    { name: shader, data: utf8.encode(shaderText) },
    { name: script, data: utf8.encode(scriptText) },
  ];
}
