// Unity 2D export: PNG pages and tileset images with TextureImporter .meta files that slice them, the clips and the map
// as JSON, and Editor C# that builds AnimationClips, Tile assets and a Grid with Tilemaps from that JSON. Text and bytes
// only, no I/O. GUIDs come from a hash of the file name, so a re-export keeps every reference.
import type { AtlasManifest } from './atlas.js';
import { SHA256 } from './hash.js';
import {
  clipSeconds,
  type EngineClip,
  gridTilesets,
  type MapSource,
  type MapSourceTileset,
  mapCells,
  shapeOutline,
} from './map-source.js';

export type { EngineClip, MapSource } from './map-source.js';

/** Inputs of {@link createUnity2DBundle}. */
export interface Unity2DOptions {
  /** Folder under `Assets/` the files go in, also the C# namespace's last part. Default `Sprites2D`. */
  folder?: string;
  /** A packed atlas's manifest. */
  manifest?: AtlasManifest;
  /** The encoded PNG of each atlas page. Required with `manifest`. */
  pages?: readonly Uint8Array[];
  /** Animations of atlas frames, by name. */
  clips?: Readonly<Record<string, EngineClip>>;
  /** 9-slice borders in pixels per atlas frame name. */
  borders?: Readonly<Record<string, { left: number; bottom: number; right: number; top: number }>>;
  /** A tile map, with `tilesetImages`. */
  map?: MapSource;
  /** The encoded PNG of each tileset, by tileset name. Required with `map`. */
  tilesetImages?: Readonly<Record<string, Uint8Array>>;
  /** Pixels per Unity unit. Default 100. */
  pixelsPerUnit?: number;
}
/** One file of a bundle. */
export interface Unity2DFile {
  /** Path relative to `Assets/`. */
  name: string;
  data: Uint8Array | string;
}

const hashOf = (text: string): string => new SHA256().update(new TextEncoder().encode(text)).hex();
const guidOf = (name: string): string => hashOf(`margoengine:unity-2d:${name}`).slice(0, 32);
// A positive int64 from the hash, with the high bit clear so YAML and C# read it the same way.
const internalIdOf = (name: string): string =>
  (BigInt(`0x${hashOf(`margoengine:unity-2d-id:${name}`).slice(0, 16)}`) >> 1n).toString();
const yamlName = (text: string): string => JSON.stringify(text);
const round = (value: number): number => +value.toFixed(6);

interface MetaSprite {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pivotX: number;
  pivotY: number;
  border?: { left: number; bottom: number; right: number; top: number };
  /** Outlines in pixels from the sprite's centre, Y up. */
  shapes?: [number, number][][];
}

function spriteMeta(path: string, pixelsPerUnit: number, sprites: readonly MetaSprite[]): string {
  const physics = (shapes: [number, number][][] = []): string =>
      shapes.length
        ? `\n${shapes
            .map(
              (shape) =>
                `      - ${shape.map(([x, y], i) => `${i ? '        ' : ''}- {x: ${round(x)}, y: ${round(y)}}`).join('\n')}`,
            )
            .join('\n')}`
        : ' []',
    entries = sprites
      .map((s) => {
        const b = s.border ?? { left: 0, bottom: 0, right: 0, top: 0 };
        return `    - serializedVersion: 2
      name: ${yamlName(s.name)}
      rect:
        serializedVersion: 2
        x: ${s.x}
        y: ${s.y}
        width: ${s.width}
        height: ${s.height}
      alignment: 9
      pivot: {x: ${round(s.pivotX)}, y: ${round(s.pivotY)}}
      border: {x: ${b.left}, y: ${b.bottom}, z: ${b.right}, w: ${b.top}}
      outline: []
      physicsShape:${physics(s.shapes)}
      tessellationDetail: 0
      bones: []
      spriteID: ${guidOf(`${path}#${s.name}`)}
      internalID: ${internalIdOf(`${path}#${s.name}`)}
      vertices: []
      indices:
      edges: []
      weights: []`;
      })
      .join('\n'),
    table = sprites.map((s) => `      ${yamlName(s.name)}: ${internalIdOf(`${path}#${s.name}`)}`).join('\n');
  return `fileFormatVersion: 2
guid: ${guidOf(path)}
TextureImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 12
  mipmaps:
    enableMipMap: 0
    sRGBTexture: 1
  isReadable: 0
  streamingMipmaps: 0
  textureSettings:
    serializedVersion: 2
    filterMode: 0
    aniso: 1
    mipBias: 0
    wrapU: 1
    wrapV: 1
    wrapW: 1
  nPOTScale: 0
  lightmap: 0
  compressionQuality: 50
  spriteMode: 2
  spriteExtrude: 1
  spriteMeshType: 0
  alignment: 0
  spritePivot: {x: 0.5, y: 0.5}
  spritePixelsToUnits: ${pixelsPerUnit}
  spriteGenerateFallbackPhysicsShape: 0
  alphaUsage: 1
  alphaIsTransparency: 1
  textureType: 8
  textureShape: 1
  spriteSheet:
    serializedVersion: 2
    sprites:
${entries}
    outline: []
    physicsShape: []
    bones: []
    spriteID:
    internalID: 0
    vertices: []
    indices:
    edges: []
    weights: []
    secondaryTextures: []
    nameFileIdTable:
${table}
  spritePackingTag:
  pSDRemoveMatte: 0
  userData:
  assetBundleName:
  assetBundleVariant:
`;
}

const folderMeta = (path: string): string =>
  `fileFormatVersion: 2\nguid: ${guidOf(path)}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`;
const scriptMeta = (path: string): string =>
  `fileFormatVersion: 2\nguid: ${guidOf(path)}\nMonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`;
const textMeta = (path: string): string =>
  `fileFormatVersion: 2\nguid: ${guidOf(path)}\nTextScriptImporter:\n  externalObjects: {}\n  userData:\n  assetBundleName:\n  assetBundleVariant:\n`;

const tileScript = (space: string): string => `using UnityEngine;
using UnityEngine.Tilemaps;

namespace MargoExport.${space}
{
    /// <summary>A tile with one sprite, or a looped run of sprites, and an optional sprite-shaped collider.</summary>
    public sealed class MapTile : TileBase
    {
        public Sprite sprite;
        public Sprite[] frames = new Sprite[0];
        public float framesPerSecond = 1f;
        public Tile.ColliderType collider = Tile.ColliderType.None;

        public override void GetTileData(Vector3Int position, ITilemap tilemap, ref TileData data)
        {
            data.sprite = sprite;
            data.colliderType = collider;
            data.color = Color.white;
            data.transform = Matrix4x4.identity;
            data.flags = TileFlags.None;
        }

        public override bool GetTileAnimationData(Vector3Int position, ITilemap tilemap, ref TileAnimationData data)
        {
            if (frames.Length < 2) return false;
            data.animatedSprites = frames;
            data.animationSpeed = framesPerSecond;
            data.animationStartTime = 0f;
            return true;
        }
    }
}
`;

const editorScript = (space: string, folder: string): string => `using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace MargoExport.${space}
{
    /// <summary>Builds AnimationClips, Tile assets and a Grid prefab from the exported JSON. Menu: Tools/Margo Export/${folder}.</summary>
    public static class Build2D
    {
        const string Root = "Assets/${folder}";

        [Serializable] class Frame { public string sprite = ""; public string page = ""; public float seconds = 0f; }
        [Serializable] class Clip { public string name = ""; public bool loop = true; public Frame[] frames = new Frame[0]; }
        [Serializable] class TileEntry { public string name = ""; public string image = ""; public bool solid = false; public string[] frames = new string[0]; public float framesPerSecond = 1f; }
        [Serializable] class Cell { public int x = 0; public int y = 0; public string tile = ""; public bool flipH = false; public bool flipV = false; public bool flipD = false; }
        [Serializable] class Layer { public string name = ""; public Cell[] cells = new Cell[0]; }
        [Serializable] class Data { public Clip[] clips = new Clip[0]; public TileEntry[] tiles = new TileEntry[0]; public Layer[] layers = new Layer[0]; public float cellWidth = 1f; public float cellHeight = 1f; }

        [MenuItem("Tools/Margo Export/${folder}")]
        public static void Build()
        {
            AssetDatabase.Refresh();
            var path = Root + "/export-2d.json";
            var json = AssetDatabase.LoadAssetAtPath<TextAsset>(path);
            if (json == null) throw new FileNotFoundException("Keep the exported folder at " + Root + "; " + path + " is missing.");
            var data = JsonUtility.FromJson<Data>(json.text);
            foreach (var clip in data.clips) BuildClip(clip);
            var tiles = new Dictionary<string, MapTile>();
            foreach (var entry in data.tiles) tiles[entry.name] = BuildTile(entry);
            if (data.layers.Length > 0) BuildGrid(data, tiles);
            AssetDatabase.SaveAssets();
            Debug.Log("Margo export built in " + Root + ": " + data.clips.Length + " clips, " + data.tiles.Length + " tiles, " + data.layers.Length + " layers.");
        }

        static void Folder(string name)
        {
            if (!AssetDatabase.IsValidFolder(Root + "/" + name)) AssetDatabase.CreateFolder(Root, name);
        }

        static Sprite Find(string image, string name)
        {
            var path = Root + "/" + image;
            var sprite = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Sprite>().FirstOrDefault(s => s.name == name);
            if (sprite == null) throw new InvalidDataException("Sprite " + name + " is not in " + path + "; export the folder again.");
            return sprite;
        }

        static void BuildClip(Clip clip)
        {
            var result = new AnimationClip();
            var keys = new ObjectReferenceKeyframe[clip.frames.Length + 1];
            float time = 0f, last = 0f;
            for (int i = 0; i < clip.frames.Length; i++)
            {
                keys[i] = new ObjectReferenceKeyframe { time = time, value = Find(clip.frames[i].page, clip.frames[i].sprite) };
                last = clip.frames[i].seconds;
                time += last;
            }
            // A last key holds the final frame for its full time.
            keys[clip.frames.Length] = new ObjectReferenceKeyframe { time = time, value = keys[clip.frames.Length - 1].value };
            result.frameRate = Mathf.Max(1f, Mathf.Ceil(1f / Mathf.Max(0.001f, clip.frames.Min(f => f.seconds))));
            var binding = EditorCurveBinding.PPtrCurve("", typeof(SpriteRenderer), "m_Sprite");
            AnimationUtility.SetObjectReferenceCurve(result, binding, keys);
            var settings = AnimationUtility.GetAnimationClipSettings(result);
            settings.loopTime = clip.loop;
            AnimationUtility.SetAnimationClipSettings(result, settings);
            Folder("Clips");
            AssetDatabase.CreateAsset(result, Root + "/Clips/" + clip.name + ".anim");
        }

        static MapTile BuildTile(TileEntry entry)
        {
            var tile = ScriptableObject.CreateInstance<MapTile>();
            tile.sprite = Find(entry.image, entry.name);
            tile.frames = entry.frames.Select(name => Find(entry.image, name)).ToArray();
            tile.framesPerSecond = entry.framesPerSecond;
            tile.collider = entry.solid ? Tile.ColliderType.Sprite : Tile.ColliderType.None;
            Folder("Tiles");
            AssetDatabase.CreateAsset(tile, Root + "/Tiles/" + entry.name + ".asset");
            return tile;
        }

        static void BuildGrid(Data data, Dictionary<string, MapTile> tiles)
        {
            var root = new GameObject("Map");
            root.AddComponent<Grid>().cellSize = new Vector3(data.cellWidth, data.cellHeight, 0f);
            foreach (var layer in data.layers)
            {
                var child = new GameObject(layer.name);
                child.transform.SetParent(root.transform, false);
                var map = child.AddComponent<Tilemap>();
                child.AddComponent<TilemapRenderer>();
                child.AddComponent<TilemapCollider2D>();
                foreach (var cell in layer.cells)
                {
                    // The map's rows run down; Tilemap rows run up.
                    var position = new Vector3Int(cell.x, -cell.y - 1, 0);
                    map.SetTile(position, tiles[cell.tile]);
                    if (!cell.flipH && !cell.flipV && !cell.flipD) continue;
                    map.SetTileFlags(position, TileFlags.None);
                    map.SetTransformMatrix(position, FlipMatrix(cell.flipH, cell.flipV, cell.flipD));
                }
            }
            PrefabUtility.SaveAsPrefabAsset(root, Root + "/Map.prefab");
            UnityEngine.Object.DestroyImmediate(root);
        }

        // The map's flips: the diagonal first, then horizontal and vertical. With Y up the diagonal maps (x, y) to (-y, -x).
        static Matrix4x4 FlipMatrix(bool h, bool v, bool d)
        {
            float sx = h ? -1f : 1f, sy = v ? -1f : 1f;
            var m = Matrix4x4.identity;
            m.m00 = d ? 0f : sx;
            m.m01 = d ? -sx : 0f;
            m.m10 = d ? -sy : 0f;
            m.m11 = d ? 0f : sy;
            return m;
        }
    }
}
`;

/**
 * A folder to copy under `Assets/`: atlas pages and tileset images with `.meta` files that slice them into sprites
 * (Unity rects, Y up, with pivots that keep trimmed frames in place), the clips and map as `export-2d.json`, and C# that
 * adds the menu `Tools/Margo Export/<folder>` to build `.anim` clips, Tile assets and a `Map.prefab` with a `Tilemap` and
 * `TilemapCollider2D` per layer. Files come sorted by name, and the same input gives the same bytes and GUIDs.
 * @example
 * ```ts
 * import {atlasManifest, packAtlasFrames} from 'margoengine/exporters/atlas';
 * import {encodePNG} from 'margoengine/exporters/capture';
 * import {createUnity2DBundle} from 'margoengine/exporters/unity-2d';
 * const pixel = {data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1};
 * const atlas = packAtlasFrames([{...pixel, name: 'a'}]);
 * const files = createUnity2DBundle({
 *   manifest: atlasManifest(atlas, {image: 'hero.png'}),
 *   pages: [await encodePNG(atlas.pages[0])],
 *   clips: {idle: {frames: ['a'], fps: 8}},
 * });
 * console.log(files.map((file) => file.name));
 * ```
 * @throws RangeError for a bad folder or scale, a missing image, a bad clip, an image-collection tileset, or a point or
 * polyline collision.
 */
export function createUnity2DBundle(options: Unity2DOptions): Unity2DFile[] {
  const {
    folder = 'Sprites2D',
    manifest,
    pages = [],
    clips = {},
    borders = {},
    map,
    tilesetImages = {},
    pixelsPerUnit = 100,
  } = options ?? {};
  if (!/^[A-Za-z][A-Za-z0-9]{0,47}$/.test(folder))
    throw new RangeError(
      `Unity folder ${folder} is invalid; pass 1-48 ASCII letters and digits starting with a letter`,
    );
  if (!(pixelsPerUnit > 0 && Number.isFinite(pixelsPerUnit)))
    throw new RangeError(`Unity pixelsPerUnit ${pixelsPerUnit} is invalid; pass a number above 0`);
  if (!manifest && !map) throw new RangeError('createUnity2DBundle needs a manifest or a map; pass at least one');
  const files: Unity2DFile[] = [],
    add = (name: string, data: Uint8Array | string, meta: (path: string) => string): void => {
      files.push({ name, data }, { name: `${name}.meta`, data: meta(`${folder}/${name}`) });
    },
    pageOf = new Map<string, string>(),
    data: Record<string, unknown> = {};
  if (manifest) {
    if (pages.length !== manifest.meta.pages.length)
      throw new RangeError(
        `Unity export has ${pages.length} page images for ${manifest.meta.pages.length} pages; pass one PNG each`,
      );
    manifest.meta.pages.forEach(({ image, size }, page) => {
      const sprites: MetaSprite[] = [];
      for (const [name, f] of Object.entries(manifest.frames)) {
        if ((f.page ?? 0) !== page) continue;
        pageOf.set(name, image);
        sprites.push({
          name,
          x: f.frame.x,
          y: size.h - f.frame.y - f.frame.h,
          width: f.frame.w,
          height: f.frame.h,
          // The pivot of the untrimmed image, measured from the trimmed rect's bottom left.
          pivotX: (f.pivot.x * f.sourceSize.w - f.spriteSourceSize.x) / f.frame.w,
          pivotY: 1 - (f.pivot.y * f.sourceSize.h - f.spriteSourceSize.y) / f.frame.h,
          border: borders[name],
        });
      }
      add(image, pages[page], (path) => spriteMeta(path, pixelsPerUnit, sprites));
    });
    data.clips = Object.entries(clips).map(([name, clip]) => {
      const seconds = clipSeconds(name, clip, manifest.frames);
      return {
        name,
        loop: clip.loop !== false,
        frames: clip.frames.map((sprite, i) => ({ sprite, page: pageOf.get(sprite), seconds: seconds[i] })),
      };
    });
  } else if (Object.keys(clips).length)
    throw new RangeError('Unity clips need a manifest of their atlas; pass the manifest and its pages');
  if (map) {
    const tilesets = gridTilesets(map),
      tileName = (set: MapSourceTileset, id: number): string => `${set.name}_${id}`,
      tiles: Record<string, unknown>[] = [],
      used = new Set<string>(),
      layers = mapCells(map).map(({ name, cells }) => ({
        name,
        cells: cells.map(({ x, y, source, column, row, flipH, flipV, flipD }) => {
          const set = tilesets[source],
            tile = tileName(set, row * set.columns + column);
          used.add(tile);
          return { x, y, tile, flipH, flipV, flipD };
        }),
      }));
    for (const set of tilesets) {
      const image = tilesetImages[set.image!.source] ?? tilesetImages[set.name];
      if (!image) throw new RangeError(`Tileset ${set.name} has no image; pass its PNG in tilesetImages by name`);
      const { tileWidth: w, tileHeight: h, margin = 0, spacing = 0, columns, tiles: defs = [] } = set,
        byId = new Map(defs.map((tile) => [tile.id, tile])),
        sprites = Array.from({ length: set.tileCount }, (_, id): MetaSprite => {
          const column = id % columns,
            row = Math.floor(id / columns),
            shapes = (byId.get(id)?.collision ?? []).map((shape) =>
              shapeOutline(shape, set.name, id).map(([x, y]): [number, number] => [x - w / 2, h / 2 - y]),
            );
          return {
            name: tileName(set, id),
            x: margin + column * (w + spacing),
            y: set.image!.height - margin - row * (h + spacing) - h,
            width: w,
            height: h,
            pivotX: 0.5,
            pivotY: 0.5,
            ...(shapes.length ? { shapes } : {}),
          };
        });
      add(set.image!.source, image, (path) => spriteMeta(path, pixelsPerUnit, sprites));
      for (let id = 0; id < set.tileCount; id++) {
        const def = byId.get(id),
          name = tileName(set, id);
        if (!used.has(name)) continue;
        const steps = def?.animation ?? [],
          // Unity runs a tile's frames at one rate, so unequal times repeat frames at their common divisor.
          unit = steps.reduce((a, { duration }) => {
            let [x, y] = [a, Math.round(duration)];
            while (y) [x, y] = [y, x % y];
            return x;
          }, 0);
        if (steps.length && !(unit > 0))
          throw new RangeError(
            `Tile ${id} of ${set.name} has a frame time under 1 ms; pass whole milliseconds above 0`,
          );
        tiles.push({
          name,
          image: set.image!.source,
          solid: !!def?.collision?.length,
          frames: steps.flatMap(({ tileId, duration }) =>
            new Array<string>(Math.round(duration / unit)).fill(tileName(set, tileId)),
          ),
          framesPerSecond: unit ? 1000 / unit : 1,
        });
      }
    }
    data.tiles = tiles;
    data.layers = layers;
    data.cellWidth = map.tileWidth / pixelsPerUnit;
    data.cellHeight = map.tileHeight / pixelsPerUnit;
  }
  add('export-2d.json', JSON.stringify(data, null, 2), textMeta);
  add('MapTile.cs', tileScript(folder), scriptMeta);
  files.push({ name: 'Editor.meta', data: folderMeta(`${folder}/Editor`) });
  add('Editor/Build2D.cs', editorScript(folder, folder), scriptMeta);
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
