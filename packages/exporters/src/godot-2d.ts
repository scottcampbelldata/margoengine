// Godot 4 2D export, from the public TSCN/TRES format documentation and the class reference: SpriteFrames and TileSet
// text resources, cells as JSON, and a script that places them with set_cell. Godot's internal tile_map_data bytes are
// never written. Text only: no I/O.
import type { AtlasManifest } from './atlas.js';
import { clipSeconds, type EngineClip, gridTilesets, type MapSource, mapCells, shapeOutline } from './map-source.js';

export type { EngineClip, MapSource } from './map-source.js';

const quoted = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
// Numbers as Godot writes them: a float keeps its point.
const real = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(+value.toFixed(6)));
const resourcePath = (folder: string, image: string): string => `${folder.replace(/\/*$/, '')}/${image}`;

/**
 * A `SpriteFrames` resource (`.tres`) of a packed atlas: one `AtlasTexture` per frame used, with a margin that restores
 * trimmed borders, and one animation per clip. Put the page images under `folder`; open it in an `AnimatedSprite2D`.
 * @example
 * ```ts
 * import {atlasManifest, packAtlasFrames} from 'margoengine/exporters/atlas';
 * import {godotSpriteFrames} from 'margoengine/exporters/godot-2d';
 * const pixel = {data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1};
 * const manifest = atlasManifest(packAtlasFrames([{...pixel, name: 'a'}]), {image: 'hero.png'});
 * const tres: string = godotSpriteFrames(manifest, {idle: {frames: ['a'], fps: 8}});
 * ```
 * @param folder `res://` folder of the page images. Default `res://`.
 * @throws RangeError for a clip with no frames, a frame not in the atlas, or a bad rate or time.
 */
export function godotSpriteFrames(
  manifest: AtlasManifest,
  clips: Readonly<Record<string, EngineClip>>,
  { folder = 'res://' }: { folder?: string } = {},
): string {
  const entries = Object.entries(clips ?? {});
  if (!entries.length) throw new RangeError('godotSpriteFrames needs clips; pass at least one by name');
  const used = new Map<string, string>(),
    pages = new Set<number>(),
    animations = entries.map(([name, clip]) => {
      const seconds = clipSeconds(name, clip, manifest.frames),
        fps = clip.fps ?? 12,
        frames = clip.frames.map((frame, i) => {
          if (!used.has(frame)) used.set(frame, `AtlasTexture_${used.size}`);
          pages.add(manifest.frames[frame].page ?? 0);
          // A frame's duration is relative to the animation's speed.
          return `{\n"duration": ${real(seconds[i] * fps)},\n"texture": SubResource(${quoted(used.get(frame)!)})\n}`;
        });
      return `{\n"frames": [${frames.join(', ')}],\n"loop": ${clip.loop !== false},\n"name": &${quoted(name)},\n"speed": ${real(fps)}\n}`;
    }),
    pageList = [...pages].sort((a, b) => a - b),
    head = `[gd_resource type="SpriteFrames" load_steps=${pageList.length + used.size + 1} format=3]\n\n`,
    externals = pageList
      .map(
        (page) =>
          `[ext_resource type="Texture2D" path=${quoted(resourcePath(folder, manifest.meta.pages[page].image))} id="page_${page}"]\n`,
      )
      .join(''),
    subs = [...used]
      .map(([name, id]) => {
        const { frame: f, spriteSourceSize: at, sourceSize: size, page = 0 } = manifest.frames[name];
        return `[sub_resource type="AtlasTexture" id=${quoted(id)}]\natlas = ExtResource("page_${page}")\nregion = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})\nmargin = Rect2(${at.x}, ${at.y}, ${size.w - f.w}, ${size.h - f.h})\n\n`;
      })
      .join('');
  return `${head}${externals}\n${subs}[resource]\nanimations = [${animations.join(', ')}]\n`;
}

/**
 * A `TileSet` resource (`.tres`) of a tile map: one `TileSetAtlasSource` per tileset (margins and separation kept), one
 * physics layer with each tile's collision outline, tile animations, and a custom data layer per tile property, plus
 * `type`. Godot animates only tiles in a block of consecutive atlas cells, so another order is refused.
 * @example
 * ```ts
 * import {godotTileSet} from 'margoengine/exporters/godot-2d';
 * const tres: string = godotTileSet({
 *   width: 1, height: 1, tileWidth: 16, tileHeight: 16, layers: [],
 *   tilesets: [{name: 'ground', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 1, columns: 1,
 *     image: {source: 'ground.png', width: 16, height: 16},
 *     tiles: [{id: 0, type: 'wall', collision: [{kind: 'rect', x: 0, y: 0, width: 16, height: 16}]}]}],
 * });
 * ```
 * @param folder `res://` folder of the tileset images. Default `res://`.
 * @throws RangeError for an image-collection tileset, a point or polyline collision, a tile animation Godot cannot
 * hold, or a property name used with two types.
 */
export function godotTileSet(map: MapSource, { folder = 'res://' }: { folder?: string } = {}): string {
  const tilesets = gridTilesets(map),
    // Name to Godot variant type: 1 bool, 2 int, 3 float, 4 string.
    custom = new Map<string, number>(),
    variant = (value: unknown): number =>
      typeof value === 'boolean' ? 1 : typeof value === 'number' ? (Number.isInteger(value) ? 2 : 3) : 4,
    propertiesOf = (tile: NonNullable<(typeof tilesets)[number]['tiles']>[number]): [string, unknown][] => [
      ...(tile.type ? ([['type', tile.type]] as [string, unknown][]) : []),
      ...Object.entries(tile.properties ?? {}),
    ];
  for (const tileset of tilesets)
    for (const tile of tileset.tiles ?? [])
      for (const [name, value] of propertiesOf(tile)) {
        const seen = custom.get(name),
          now = variant(value);
        // An int and a float share the float layer.
        if (seen !== undefined && seen !== now && !(seen + now === 5 && seen !== 1 && now !== 1))
          throw new RangeError(`Tile property ${name} is used with two types; use one type for each name`);
        custom.set(name, seen === undefined ? now : Math.max(seen, now));
      }
  const layerOf = [...custom.keys()],
    literal = (type: number, value: unknown): string =>
      type === 4
        ? quoted(typeof value === 'string' ? value : JSON.stringify(value))
        : type === 3
          ? real(value as number)
          : String(value),
    sources = tilesets.map((tileset, index) => {
      const { tileWidth: w, tileHeight: h, columns, tileCount, margin = 0, spacing = 0, tiles = [] } = tileset,
        byId = new Map(tiles.map((tile) => [tile.id, tile])),
        covered = new Set<number>(),
        lines: string[] = [];
      for (const tile of tiles) {
        const steps = tile.animation ?? [];
        if (steps.length < 2) continue;
        const inBlock = steps.every((step, i) => step.tileId === tile.id + i),
          column = tile.id % columns,
          fits = column + steps.length <= columns || column === 0;
        if (!inBlock || !fits)
          throw new RangeError(
            `Tile ${tile.id} of ${tileset.name} animates cells Godot cannot hold; lay its frames out as consecutive atlas cells`,
          );
        for (let i = 1; i < steps.length; i++) covered.add(tile.id + i);
      }
      for (let id = 0; id < tileCount; id++) {
        if (covered.has(id)) continue;
        const cell = `${id % columns}:${Math.floor(id / columns)}`,
          tile = byId.get(id);
        lines.push(`${cell}/0 = 0`);
        const steps = tile?.animation ?? [];
        if (steps.length > 1) {
          lines.push(`${cell}/animation_columns = ${Math.min(steps.length, columns)}`);
          lines.push(`${cell}/animation_speed = 1.0`);
          steps.forEach((step, i) =>
            lines.push(`${cell}/animation_frame_${i}/duration = ${real(step.duration / 1000)}`),
          );
        }
        (tile?.collision ?? []).forEach((shape, i) => {
          // Godot's outlines are relative to the tile's centre.
          const points = shapeOutline(shape, tileset.name, id).flatMap(([x, y]) => [x - w / 2, y - h / 2]);
          lines.push(
            `${cell}/0/physics_layer_0/polygon_${i}/points = PackedVector2Array(${points.map((v) => +v.toFixed(6)).join(', ')})`,
          );
        });
        if (tile)
          for (const [name, value] of propertiesOf(tile)) {
            const layer = layerOf.indexOf(name);
            lines.push(`${cell}/0/custom_data_${layer} = ${literal(custom.get(name)!, value)}`);
          }
      }
      return `[sub_resource type="TileSetAtlasSource" id="source_${index}"]\ntexture = ExtResource("image_${index}")\nmargins = Vector2i(${margin}, ${margin})\nseparation = Vector2i(${spacing}, ${spacing})\ntexture_region_size = Vector2i(${w}, ${h})\n${lines.join('\n')}\n\n`;
    }),
    externals = tilesets
      .map(
        (tileset, index) =>
          `[ext_resource type="Texture2D" path=${quoted(resourcePath(folder, tileset.image!.source))} id="image_${index}"]\n`,
      )
      .join(''),
    resource = [
      `tile_size = Vector2i(${map.tileWidth}, ${map.tileHeight})`,
      'physics_layer_0/collision_layer = 1',
      ...layerOf.flatMap((name, i) => [
        `custom_data_layer_${i}/name = ${quoted(name)}`,
        `custom_data_layer_${i}/type = ${custom.get(name)}`,
      ]),
      ...tilesets.map((_, i) => `sources/${i} = SubResource("source_${i}")`),
    ].join('\n');
  return `[gd_resource type="TileSet" load_steps=${tilesets.length * 2 + 1} format=3]\n\n${externals}\n${sources.join('')}[resource]\n${resource}\n`;
}

/** The JSON that {@link createGodotTileMapScript} places. */
export interface GodotTileCells {
  version: 1;
  /** Each cell is `[x, y, source, atlasColumn, atlasRow, alternative]`, the flips as the alternative's transform bits. */
  layers: { name: string; cells: [number, number, number, number, number, number][] }[];
}

/**
 * The map's visible tile layers as JSON for {@link createGodotTileMapScript}: `JSON.stringify` it into a file. Flips use
 * the `TileSetAtlasSource` transform bits Godot 4.2 and later read in the alternative id.
 * @throws RangeError for a tile in no tileset, or an image-collection tileset.
 */
export function godotTileCells(map: MapSource): GodotTileCells {
  return {
    version: 1,
    layers: mapCells(map).map(({ name, cells }) => ({
      name,
      cells: cells.map(({ x, y, source, column, row, flipH, flipV, flipD }) => [
        x,
        y,
        source,
        column,
        row,
        (flipH ? 4096 : 0) | (flipV ? 8192 : 0) | (flipD ? 16384 : 0),
      ]),
    })),
  };
}

/**
 * A Godot 4.3 `Node2D` script: at `_ready` it reads the {@link godotTileCells} JSON and creates one `TileMapLayer` child
 * per layer, calling `set_cell` for every cell. Assign `tile_set` from {@link godotTileSet} in the inspector.
 */
export function createGodotTileMapScript(): string {
  return `extends Node2D
## Builds TileMapLayer children from JSON written by Margo Engine's godot-2d export.
@export var tile_set: TileSet
@export_file("*.json") var cells_path: String = "cells.json"

func _ready() -> void:
	var text := FileAccess.get_file_as_string(cells_path)
	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY or int(parsed.get("version", 0)) != 1:
		push_error("Tile cells at " + cells_path + " are not version 1 JSON; export them again.")
		return
	for entry in parsed["layers"]:
		var layer := TileMapLayer.new()
		layer.name = entry["name"]
		layer.tile_set = tile_set
		add_child(layer)
		for c in entry["cells"]:
			layer.set_cell(Vector2i(int(c[0]), int(c[1])), int(c[2]), Vector2i(int(c[3]), int(c[4])), int(c[5]))
`;
}
