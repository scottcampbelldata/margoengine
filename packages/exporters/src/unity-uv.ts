// Unity UV clips for a glTFast import: AnimationClips with constant keys on the material's base-color scale and offset.
// The property is baseColorTexture_ST, the main texture of the glTFast shaders the Unity support package pins.
import type { ExportScene } from './scene.js';
import { uvClips } from './uv-clips.js';

/** One property curve of a Unity UV clip. */
export interface UnityUVCurve {
  /** Renderer's path under the imported root. */
  path: string;
  /** "material.baseColorTexture_ST.x" for scale x, ".y" scale y, ".z" offset x, ".w" offset y. */
  property: string;
  times: number[];
  values: number[];
}
/** The data {@link createUnityUVClips} writes. */
export interface UnityUVClip {
  name: string;
  curves: UnityUVCurve[];
}

/**
 * A scene's material animations as Unity clips. glTF puts the image origin at the top and Unity at the bottom, so a cel's
 * offset y becomes 1 - scale y - offset y.
 * @throws TypeError for a channel that is not a STEP base-color offset or scale, or a material no node draws.
 */
export function unityUVClips(scene: ExportScene): UnityUVClip[] {
  const clips = new Map<string, UnityUVCurve[]>();
  for (const { clip, paths, keys } of uvClips(scene)) {
    const curves = clips.get(clip) ?? [];
    clips.set(clip, curves);
    const times = keys.map((key) => key.time),
      columns: [string, number[]][] = [
        ['x', keys.map((key) => key.scale[0])],
        ['y', keys.map((key) => key.scale[1])],
        ['z', keys.map((key) => key.offset[0])],
        ['w', keys.map((key) => 1 - key.scale[1] - key.offset[1])],
      ];
    for (const path of paths)
      for (const [axis, values] of columns)
        curves.push({ path, property: `material.baseColorTexture_ST.${axis}`, times, values });
  }
  return [...clips].map(([name, curves]) => ({ name, curves }));
}

/**
 * Two files to copy under `Assets/`: the clips as JSON and Editor C# adding the menu `Tools/Margo Export/<folder> UV Clips`,
 * which writes one looped `.anim` per clip with constant keys. Add them to an `Animator` on the imported root.
 * @example
 * ```ts
 * import {createUnityUVClips} from 'margoengine/exporters/unity-uv';
 * const files = createUnityUVClips({nodes: []}, {folder: 'Hero'});
 * console.log(files.map((file) => file.name));
 * ```
 * @param folder Folder under Assets/, letters and digits. Default `UVClips`.
 * @throws RangeError for a bad folder; TypeError as {@link unityUVClips}.
 */
export function createUnityUVClips(
  scene: ExportScene,
  { folder = 'UVClips' }: { folder?: string } = {},
): { name: string; data: string }[] {
  if (!/^[A-Za-z][A-Za-z0-9]{0,47}$/.test(folder))
    throw new RangeError(
      `Unity folder ${folder} is invalid; pass 1-48 ASCII letters and digits starting with a letter`,
    );
  return [
    { name: 'Editor/BuildUVClips.cs', data: script(folder) },
    { name: 'uv-clips.json', data: JSON.stringify({ clips: unityUVClips(scene) }, null, 2) },
  ];
}

const script = (folder: string): string => `using System;
using UnityEditor;
using UnityEngine;

namespace MargoExport.${folder}
{
    public static class BuildUVClips
    {
        const string Root = "Assets/${folder}";

        [Serializable] class Curve { public string path = ""; public string property = ""; public float[] times = new float[0]; public float[] values = new float[0]; }
        [Serializable] class Clip { public string name = ""; public Curve[] curves = new Curve[0]; }
        [Serializable] class Data { public Clip[] clips = new Clip[0]; }

        [MenuItem("Tools/Margo Export/${folder} UV Clips")]
        public static void Build()
        {
            var json = AssetDatabase.LoadAssetAtPath<TextAsset>(Root + "/uv-clips.json");
            if (json == null) throw new System.IO.FileNotFoundException("Keep the exported folder at " + Root + "; uv-clips.json is missing.");
            foreach (var clip in JsonUtility.FromJson<Data>(json.text).clips)
            {
                var result = new AnimationClip();
                foreach (var curve in clip.curves)
                {
                    var keys = new Keyframe[curve.times.Length];
                    // An infinite tangent holds each value until the next key.
                    for (int i = 0; i < keys.Length; i++)
                        keys[i] = new Keyframe(curve.times[i], curve.values[i], float.PositiveInfinity, float.PositiveInfinity);
                    result.SetCurve(curve.path, typeof(MeshRenderer), curve.property, new AnimationCurve(keys));
                }
                var settings = AnimationUtility.GetAnimationClipSettings(result);
                settings.loopTime = true;
                AnimationUtility.SetAnimationClipSettings(result, settings);
                AssetDatabase.CreateAsset(result, Root + "/" + clip.name + ".anim");
            }
            AssetDatabase.SaveAssets();
        }
    }
}
`;
