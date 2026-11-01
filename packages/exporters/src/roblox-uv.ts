// Roblox: a MeshPart texture cannot offset, so UV animation is one PNG per cel and a Luau script that swaps TextureID
// through an id map the user fills after upload. Colliders are parts made invisible with CanCollide on. Runs anywhere.
import type { Pixels } from './capture.js';
import type { ExportScene, MaterialData } from './scene.js';
import { collisionNodes, uvClips } from './uv-clips.js';

/** Inputs of {@link createRobloxUVSwap}. */
export interface RobloxUVOptions {
  /** The decoded base-color image of an animated material. */
  texture: (material: MaterialData) => Pixels;
}

const lua = (text: string): string => JSON.stringify(text);
const safe = (text: string): string => text.replace(/[^\w.-]+/g, '_');

/**
 * UV animation for Roblox: one PNG per cel, cut from the material's texture at each key's offset and scale; `UVIds.luau`,
 * a table of cel names to fill with `rbxassetid://` ids after upload; and `UVSwap.luau`, a ModuleScript whose `play(model)`
 * steps `TextureID` on each part the clip names. Upload the cels, fill the ids, require the module.
 * @example
 * ```ts
 * import {createRobloxUVSwap} from 'margoengine/exporters/roblox-uv';
 * import type {ExportScene} from 'margoengine/exporters';
 * const material = {name: 'water'};
 * const geometry = {positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1]};
 * const scene: ExportScene = {
 *   nodes: [{name: 'pool', material, geometry}],
 *   materialAnimations: [{name: 'flow', channels: [
 *     {material, texture: 'baseColorTexture', property: 'scale', interpolation: 'STEP', times: [0], values: [0.5, 1]},
 *     {material, texture: 'baseColorTexture', property: 'offset', interpolation: 'STEP', times: [0, 0.5], values: [0, 0, 0.5, 0]},
 *   ]}],
 * };
 * const files = await createRobloxUVSwap(scene, {texture: () => ({data: new Uint8Array(16), width: 2, height: 2})});
 * console.log(files.map((file) => file.name));
 * ```
 * @throws TypeError for a channel that is not a STEP base-color offset or scale, or a material no node draws; RangeError
 * for a cel outside its texture, or an unusable texture.
 */
export async function createRobloxUVSwap(
  scene: ExportScene,
  { texture }: RobloxUVOptions,
): Promise<{ name: string; data: Uint8Array | string }[]> {
  const files: { name: string; data: Uint8Array | string }[] = [],
    ids: string[] = [],
    tracks: string[] = [];
  const { png } = await import('./png.js');
  for (const { clip, material, materialName, paths, keys } of uvClips(scene)) {
    const { data, width, height } = texture(material);
    if (data?.length !== width * height * 4)
      throw new RangeError(
        `Texture of ${materialName} has ${data?.length} bytes for ${width}x${height}; pass RGBA8 rows`,
      );
    const steps: string[] = [];
    for (let k = 0; k < keys.length; k++) {
      const { offset, scale, time } = keys[k],
        x = Math.round(offset[0] * width),
        y = Math.round(offset[1] * height),
        w = Math.round(scale[0] * width),
        h = Math.round(scale[1] * height);
      if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
        throw new RangeError(
          `UV clip ${clip} cel ${k} on ${materialName} leaves its ${width}x${height} texture; keep offset and scale inside 0..1`,
        );
      const cel = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++)
        cel.set(data.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
      const name = safe(`${clip}_${materialName}_${k}`);
      files.push({ name: `cels/${name}.png`, data: await png({ data: cel, width: w, height: h }, Infinity, false) });
      ids.push(`	[${lua(name)}] = "",`);
      steps.push(`{ time = ${time}, cel = ${lua(name)} }`);
    }
    const end = keys.at(-1)!.time + (keys.length > 1 ? keys.at(-1)!.time - keys.at(-2)!.time : 1);
    tracks.push(
      `	{ clip = ${lua(clip)}, length = ${end}, parts = { ${paths.map(lua).join(', ')} }, steps = { ${steps.join(', ')} } },`,
    );
  }
  files.push({
    name: 'UVIds.luau',
    data: `-- Fill each cel with its rbxassetid:// after uploading cels/.\nreturn {\n${ids.join('\n')}\n}\n`,
  });
  files.push({
    name: 'UVSwap.luau',
    data: `-- Steps TextureID through each clip's cels. Keep UVIds beside this script.
local ids = require(script.Parent.UVIds)
local TRACKS = {
${tracks.join('\n')}
}

local function find(model, path)
	local at = model
	for name in string.gmatch(path, "[^/]+") do
		at = at and at:FindFirstChild(name, false) or nil
	end
	return at
end

local M = {}
-- Plays every clip on the model until it is destroyed. Pass a clip name to play one.
function M.play(model, only)
	for _, track in TRACKS do
		if only == nil or track.clip == only then
			for _, step in track.steps do
				if ids[step.cel] == "" then
					error("UVIds has no id for " .. step.cel .. "; upload cels/ and fill it in")
				end
			end
			task.spawn(function()
				while model.Parent do
					local start = os.clock()
					for i, step in track.steps do
						local wake = start + step.time
						task.wait(math.max(0, wake - os.clock()))
						for _, path in track.parts do
							local part = find(model, path)
							if part then part.TextureID = ids[step.cel] end
						end
					end
					task.wait(math.max(0, start + track.length - os.clock()))
				end
			end)
		end
	end
end
return M
`,
  });
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Luau that applies a scene's collision suffixes to an imported Model: `-colonly` and `-convcolonly` parts become invisible with
 * CanCollide on, `-col` and `-convcol` keep drawing and collide; convex ones use a Hull fidelity, the rest
 * PreciseConvexDecomposition. Every other MeshPart stays as imported. Require it and call `apply(model)`.
 * @example
 * ```ts
 * import {createRobloxCollisionScript} from 'margoengine/exporters/roblox-uv';
 * const luau: string = createRobloxCollisionScript({nodes: [{name: 'wall-colonly'}]});
 * ```
 */
export function createRobloxCollisionScript(scene: ExportScene): string {
  const entries = collisionNodes(scene)
    .map(({ path, convex, visible }) => `	{ path = ${lua(path)}, convex = ${convex}, visible = ${visible} },`)
    .join('\n');
  return `-- Collision from the scene's node suffixes.
local NODES = {
${entries}
}

local M = {}
function M.apply(model)
	for _, node in NODES do
		local at = model
		for name in string.gmatch(node.path, "[^/]+") do
			at = at and at:FindFirstChild(name, false) or nil
		end
		if not at or not at:IsA("MeshPart") then
			error("No MeshPart at " .. node.path .. "; import the GLB with its node names kept")
		end
		at.CanCollide = true
		at.CanQuery = true
		at.CollisionFidelity = node.convex and Enum.CollisionFidelity.Hull or Enum.CollisionFidelity.PreciseConvexDecomposition
		if not node.visible then
			at.Transparency = 1
			at.CastShadow = false
		end
	end
end
return M
`;
}
