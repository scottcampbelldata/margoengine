// The settings of BiomeView.attach and the option types it takes. Split from view.ts along this seam; view.ts re-exports
// every name.

import type { Terrain, TerrainOptions } from '@margoengine/terrain';
import type { TerrainReliefLightingOptions } from '@margoengine/terrain/relief-lighting';
import type { WetGroundLook } from '@margoengine/terrain/wet-ground';
import type { WaterLight, WaterOptions } from '@margoengine/water';
import type { DisturbanceStatesOptions } from './disturbance.js';
import type { PlacementGraph } from './graph.js';
import type { MaterialLook } from './looks.js';
import type { BiomeSeasons } from './seasons.js';

/** Settings of {@link BiomeView.attach}. */
export interface BiomeViewOptions {
  /** Metres per heightmap and weights texel, a multiple of the world resolution. Default 2 (raised when the world
   * would exceed the device's largest 2D texture). */
  readonly textureResolution?: number;
  /** Tiles within this distance of the camera are drawn at full detail, nearest first. Default 1,000 m. */
  readonly radius?: number;
  /** Material looks by key, over `MATERIALS`. Default none. */
  readonly materials?: Readonly<Record<string, MaterialLook>>;
  /** Clipmap settings passed to the terrain. Default cell 1 m, 64 cells per ring, and as many rings as the world and
   * `radius` need (`clipmapLevels`: 9 for a 4 km world). Explicit settings that reach less than `radius` are a
   * RangeError. */
  readonly clipmap?: {
    readonly cellSize?: number;
    readonly resolution?: number;
    readonly levels?: number;
    /** World XZ centre for terrain and horizon. Defaults to the starting camera XZ. Use `'camera'` for a moving window. */
    readonly anchor?: TerrainOptions['clipmapAnchor'];
  };
  /**
   * Ground materials that share a texel drawn as patches with crisp edges rather than their average (the terrain's
   * `patches`, over the world; the horizon ring keeps its means): a slope of rock, gravel and turf reads as outcrops,
   * scree and turf islands from a kilometre off instead of one grey-brown felt. `size` is the patch cell in metres
   * (default 14), `contrast` 0 to 1 (default 0.6). Default: none (the ground blends as painted).
   */
  readonly patches?: TerrainOptions['patches'];
  /**
   * Bare rock drawn with structure at 10 to 100 m (the terrain's `rock`, on the world and the horizon ring): ledges,
   * jointed facets and, over the world, gullies carved along the drainage with talus fans and streams below the walls
   * (`drainageStructure` of `@margoengine/biomes/hydrology`, multiple flow over the world's region grid, made once at
   * attach). `debris` names the ground material that benches, gully floors and fans take (one of `materials`, such as
   * `'gravel'`); `drainage: false` leaves the gullies and fans out, or sets `drainageStructure`'s options. Default: none.
   * @example
   * await BiomeView.attach(engine, world, { rock: { debris: 'gravel', strata: 10, facets: 22 } });
   */
  readonly rock?: BiomeViewRock;
  /**
   * How far tree crowns darken the ground, 0 to 1: a material `'canopy'` (its look in `MATERIALS`) takes this share of
   * the ground weight times `canopyCover`, on far hills and on the forest floor, and `materials` lists it last. Nothing
   * is added for worlds without trees or with 16 ground materials already. Default 0.6 with `objects`, 0 without.
   */
  readonly canopy?: number;
  /**
   * Trees beyond `radius`: a 12-triangle stand-in per tree over the world's canopy cover (`BiomeObjects` `far`), from
   * the last tile of the stored trees out to `far.radius`. Needs `objects`. `false` turns it off. Default radius 2,500 m
   * and count 300,000; off when the view's `radius` reaches that far.
   */
  readonly far?: false | { readonly radius?: number; readonly count?: number };
  /** Rejects `attach` and stops streaming when aborted. */
  readonly signal?: AbortSignal;
  /** Draws the stored objects (trees, shrubs, rocks) and the detail (grass, ferns) of the world's biomes through
   * scatter. Default true. */
  readonly objects?: boolean;
  /**
   * Shrubs, hedge shrubs, rocks and props (every species off the canopy layer) are drawn within this distance of the
   * camera, at most `radius` (`BiomeObjects` `nearRadius`). Raise it for hedged country seen from a hill or the air.
   * Default 300 m.
   */
  readonly nearRadius?: number;
  /** Detail is drawn within this distance of the camera. Default 120 m. */
  readonly detailRadius?: number;
  /** Seconds ahead along the camera's velocity that tiles are fetched early. Default 3. */
  readonly lookahead?: number;
  /** Milliseconds per frame the page may spend streaming: sending tile jobs to the world's workers and copying
   * arrived tiles in, nearest first (one always goes in). Default 0.25. */
  readonly budget?: number;
  /**
   * Streaming steps a frame may take, a work count: the same tiles go in on the same frame on any machine, so a film
   * frame is the same on every run (draw after `await view.whenIdle()` and every arrived tile is in, whatever the
   * count). When set it replaces the millisecond `budget`; 1 or more, Infinity for every arrived tile. Default unset.
   */
  readonly maxSteps?: number;
  /** Clock in milliseconds for the `budget` and the idle check. Default `performance.now`; pass a simulation clock for replay. */
  readonly clock?: () => number;
  /** Most bytes of detail density maps (`BiomeObjects` `detailBudget`); the view coarsens detail maps to fit. Default
   * 128 MiB. */
  readonly detailBudget?: number;
  /**
   * A `Shadows` from `@margoengine/shadows`: the view adds its terrain (casting and receiving) and every stored-object
   * mesh (`objects.casters`) to it, and removes them on dispose. Default none.
   */
  readonly shadows?: BiomeShadows;
  /**
   * The sea: a `@margoengine/water` surface at the world's `climate.seaLevel`, covering the whole world and, when an
   * edge of the world stands at or below sea level, out to the horizon, loaded with import() only when drawn. The
   * terrain hides it under land, so its shore follows the coast, with the water's shoreline foam. `'auto'` draws it
   * when the world's heights reach below sea level; an object draws it with those `Water` settings over the sea
   * defaults (`SEA`; pass `depth: () => bloom.depthTexture` when Bloom, SSAO or DOF owns the scene depth). Rivers and
   * lakes stay dry unless the settings ask for them (`rivers`, `lakes`). Default `'auto'`.
   */
  readonly water?: boolean | 'auto' | BiomeWaterSettings;
  /**
   * Far ground past the world's edge out to the horizon (`horizonHeights`): the edge's own relief carried outward,
   * a valley leaving the world keeps going, fading over up to 3 km into eroded mountains as high as the world's relief,
   * in the world's own edge materials with rock on the steep. Each far point takes the mean of a stretch of edge an
   * eighth of its distance wide each way (`HORIZON_SPREAD`), so the edge blurs out with distance and no edge texel runs
   * to the horizon as a streak. It reaches 3 world sizes (at most 48 km) past each edge,
   * a texel of up to 32 m (and a 64th of the world), and casts no shadow and holds no plants; the scene's fog or aerial perspective
   * hazes it. `'auto'`: drawn when every edge of the world stands over the sea (a coast keeps its sea horizon).
   * Default `'auto'`.
   */
  readonly horizon?: boolean | 'auto';
  /**
   * A `Sky` from `@margoengine/sky`: the sea reflects its sky (`reflectionTexture`) and its sun and moon glint on the
   * waves (`lights`). Without one the sea reflects a plain sky gradient under the engine light. `water` settings with
   * their own `reflection` or `lights` win. Default none.
   */
  readonly sky?: BiomeSky;
  /**
   * Seasons from `@margoengine/biomes/seasons` over this world. The plant cover ground materials of biomes with
   * `tint.seasonal` (grass, meadow, moss and the like; not rock, scree, gravel, sand, mud or snow) are drawn through a
   * tint texture of `seasons.tintAt` over the world (the terrain's `tint`, a texel every `world.regionResolution` metres
   * or every `textureResolution` when that is coarser, coarser by halves only past the device's largest texture): each
   * place shows its own green-up, senescence, snow and wetness, and ground where no seasonal biome grows keeps its look.
   * The objects get the same `seasons` (`BiomeObjects`). Each `seasons.set` repaints the texture, and each world change
   * repaints its rectangle. Default none: the view draws exactly what it draws without seasons.
   */
  readonly seasons?: BiomeSeasons;
  /**
   * Roads, rails, creeks, yards and building lots where no object is placed (`PlacementOptions.exclusions`, such as
   * `layoutSettlements(...).exclusions` and `pathExclusions(paths)`). Default none.
   */
  readonly exclusions?: readonly import('./placement.js').Exclusion[];
  /** Density rules for the view's placed species. Default none. Load the graph entry or use a graph builder. */
  readonly graph?: PlacementGraph;
  /**
   * Meshes by key drawn in place of the procedural ones (`BiomeObjectsOptions.meshes`): library plants and rocks drawn
   * by the key their species name. Default none.
   */
  readonly meshes?: import('./objects.js').BiomeObjectsOptions['meshes'];
  /** Burnt and flooded plant states of each part (`BiomeObjectsOptions.states`). Default none. */
  readonly states?: import('./objects.js').BiomeObjectsOptions['states'];
  /**
   * Stored objects meet the ground: darker and (on damp ground) mossy stone feet, soil on trunk feet, less sky light low
   * in tree crowns (`BiomeObjectsOptions.contact`), and on the terrain a soil and litter apron with contact shade around
   * every trunk and stone (`TerrainGroundContact` of `@margoengine/terrain/ground-contact`, `view.groundContact`),
   * with the grass and ferns opened around those feet (`groundCover`). Default true.
   */
  readonly contact?: boolean;
  /**
   * How grass and ferns open around those feet (`BiomeObjectsOptions.groundCover`; live as
   * `view.objects?.groundCover?.set(...)`). `false` leaves them as they are. Default on with `contact`.
   */
  readonly groundCover?: import('./objects.js').BiomeObjectsOptions['groundCover'];
  /**
   * The ground's own relief shades it at every distance (`TerrainReliefLighting` of
   * `@margoengine/terrain/relief-lighting`, `view.relief`): ridges cast on the ground behind them and gullies keep less
   * of the sky, past the reach of `shadows` too. Rebaked when the engine's sun turns or the world's heights change.
   * `false` leaves it out; settings pass through. Default true.
   */
  readonly relief?: boolean | TerrainReliefLightingOptions;
  /**
   * A fire and flood history (`disturbanceOf(world, ...)` of `@margoengine/biomes/disturbance`), or `{ history, ...settings }`
   * with the `disturbanceStates` settings: the view makes a `PlantStates` map over the world (`@margoengine/scatter/states`,
   * a cell every `cell` metres, default 8, at most 1,024 a side), marks it from the history and gives every plant part a
   * response for its mesh (bark charred, conifer and broadleaf crowns above a crown base, shrubs and grass burning
   * whole), so recently burnt and flooded ground shows burnt and mud-lined plants by itself. A `states` option given too
   * answers first for each part it returns a response for. The map is `view.plantStates`: add a live fire or flood with
   * its `setSources`. Default none.
   */
  readonly disturbance?: import('./disturbance.js').Disturbance | BiomeDisturbanceSettings;
  /**
   * Wet ground and wet plants where a flood has been: a wetting record such as `Flood.wetTexture` of
   * `@margoengine/water/flood`. The terrain draws it darker and glossier, drying back over time (`WetGround` of
   * `@margoengine/terrain/wet-ground`, `view.wetGround`), and the plants below the high-water mark are mud coated with a
   * stain line above it, flattened downstream where the current (`velocity`) was strong (`PlantStates` of
   * `@margoengine/scatter/states`, `view.plantStates`, a cell every 2 m over the record, at most 1,024 a side; with
   * `disturbance` its map takes the flood). Ground and plants dry over the same `dryTime`. Both entries are loaded with
   * import() only when this is given. Default none: the view draws exactly what it draws without it.
   */
  readonly wetness?: BiomeWetness;
}

/** `BiomeViewOptions.wetness`: a wetting record over a world rectangle and the look of wet ground. */
export interface BiomeWetness extends WetGroundLook {
  /**
   * The wetting record, asked every frame (borrowed, never destroyed): rgba32float, red the deepest depth in m, green the
   * seconds since the texel was last wet, blue 1 once it has been wet, as `() => flood.wetTexture`. Undefined draws dry.
   */
  readonly record: () => GPUTexture | undefined;
  /** The current over the same rectangle (u, v, speed m/s, depth m), as `() => flood.velocityTexture`. Default none:
   * the water marks and wetness show, no plant is flattened and no debris is caught. */
  readonly velocity?: () => GPUTexture | undefined;
  /** World [x, z] of the record's first texel's corner (a Flood's `origin`). */
  readonly origin: readonly [number, number];
  /** World [width, depth] the record covers (a Flood's `size`). */
  readonly size: readonly [number, number];
}

/** `BiomeViewOptions.disturbance` with settings: the history, the marks' settings and the map's cell size. */
export interface BiomeDisturbanceSettings extends DisturbanceStatesOptions {
  readonly history: import('./disturbance.js').Disturbance;
  /** Metres a map cell, 0.5 to 1,000. Default 8. */
  readonly cell?: number;
}

/** What `BiomeViewOptions.sky` needs: a `Sky` (`@margoengine/sky`), of which only these two are read. */
export interface BiomeSky {
  /** The sky environment the sea reflects (read every frame). */
  readonly reflectionTexture: GPUTexture | undefined;
  /** Sun and moon, for glints on the waves. */
  readonly lights: readonly WaterLight[];
  /**
   * Adds the sky's ambient to a terrain (`Sky.add`); the view adds its ground and far ground, so shaded ground takes
   * the sky's colour as the meshes on it do. Returns a remover.
   */
  add?(terrain: Terrain): () => void;
}

/** `BiomeViewOptions.rock`: the terrain's `rock` with the debris layer by material name, and the drainage settings. */
export type BiomeViewRock = Omit<NonNullable<TerrainOptions['rock']>, 'debris'> & {
  /** Ground material that benches, gully floors and talus fans take; one of the view's `materials`. Default: none. */
  readonly debris?: string;
  /** `false` for no gullies or fans, or `drainageStructure` options. Default `{}` (its defaults). */
  readonly drainage?: boolean | import('./hydrology.js').DrainageStructureOptions;
};

/** `Water` settings a view passes on (`@margoengine/water`); the view sets the size, the height and the horizon. */
export type BiomeWaterSettings = Omit<
  WaterOptions,
  'size' | 'height' | 'horizon' | 'terrain' | 'spray' | 'fill' | 'still'
> & {
  /**
   * Still water in the rivers, 1.5 m over the bed and falling with it, loaded with import() only when asked for: `'auto'`
   * the world's own lines (`BiomeWorld.rivers`, a relief's), `'hydrology'` the channels of the world's hydrology
   * (`riversOf`), or lines of your own for a world from `samples`, each an Int32Array of `[x, z, ...]` millimetres.
   * Heights are read when the view attaches. The water grid has at most 512 cells a side (16 m on an 8 km world), so a
   * river narrower than two cells can break up, and its surface coarsens past 0.375 of the world's side from the camera
   * (`Water`'s outer rows). Default none: dry valleys.
   */
  readonly rivers?: 'auto' | 'hydrology' | readonly Int32Array[];
  /** `'auto'`: still lakes at the fill level of the world's hydrology pits (`lakeLevels`). Default none. */
  readonly lakes?: 'auto' | false;
  /**
   * Rivers that flow downstream instead of standing still (`@margoengine/water/rivers`, loaded with import() only when
   * set). `true` estimates each head's annual mean discharge from its climate and catchment. An object can provide
   * explicit discharge, a live runoff query, or solver substeps (default 8). Applies to the first 16 lines.
   * Needs `rivers`. Default false: still water.
   */
  readonly flow?:
    | boolean
    | {
        /** Explicit discharge per head, in m³/s. Defaults to the catchment estimate. */
        readonly discharge?: number;
        /** A live discharge source in world metres. A RainfallRunoff solver exposes this query. */
        readonly runoff?: { dischargeAt(x: number, z: number): number };
        readonly substeps?: number;
      };
};

/** What `BiomeViewOptions.shadows` needs: a `Shadows` (`@margoengine/shadows`), of which only `add` is used. */
export interface BiomeShadows {
  /** Adds a caster (and, for the terrain, a receiver); returns its remover. */
  add(source: object): () => void;
}
