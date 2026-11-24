// The scene catalogue: ready places built from the engine's packages, one entry per scene. This root holds only the
// catalogue (plain data, no imports), so listing the scenes costs nothing; each scene is its own entry, imported when
// used: `import {attach} from '@margoengine/scenes/dune-coast'`.
import { duneCoastInfo } from './dune-coast-info.js';
import { timberValleyInfo } from './timber-valley-info.js';
import { fauldTunnelsInfo } from './fauld-tunnels-info.js';
import { fauldBlastInfo, fauldCountrysideInfo, fauldCraterInfo } from './fauld-world-info.js';

/** One setting of a scene: its default, and its range, unit or allowed values. */
export interface SceneSetting {
  readonly default: unknown;
  /** Lowest and highest allowed value of a number setting. */
  readonly range?: readonly [number, number];
  /** Unit of a number setting, such as `m`, `m/s`, `deg` or `h`. */
  readonly unit?: string;
  /** Allowed values of a choice setting. */
  readonly options?: readonly string[];
  readonly about: string;
}

/** One shot of a scene: how long, which camera keys it uses, the settings it holds or keys per target, what to check. */
export interface SceneShot {
  readonly name: string;
  /** Length in seconds. */
  readonly seconds: number;
  /** The scene's camera keys (view or anchor names) the shot moves between. */
  readonly camera: readonly string[];
  /** Per-target rows held or keyed over the shot, as `@margoengine/scenes/shot-settings` checks and evaluates them. */
  readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Named look probes the shot is judged on (three per shot). */
  readonly probes?: readonly string[];
  readonly about: string;
}

/** A catalogue entry: what the scene is, its settings, presets, anchors and views, and the entry that builds it. */
export interface SceneInfo {
  /** Short name, also the entry's last path part. */
  readonly name: string;
  readonly title: string;
  readonly about: string;
  /** The module to import; it exports `attach(engine, settings)` and `info`. */
  readonly entry: string;
  readonly settings: Readonly<Record<string, SceneSetting>>;
  /** Named setting sets, merged over the defaults. */
  readonly presets: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Named places the scene's handle gives (`scene.anchors`). */
  readonly anchors: readonly string[];
  /** Named camera views (`scene.view(name)`). */
  readonly views: readonly string[];
  /** Names of the looks (picture styles) the scene takes: the families a film or shot may name, such as `natural`. */
  readonly looks?: readonly string[];
  /** The shots the scene is filmed in; `tools/shot` writes each shot file from these, so a shot is authored once. */
  readonly shots?: readonly SceneShot[];
  /** Target name to the package settings entry whose table it uses (`weather` to `@margoengine/weather/settings`); the names a shot's `settings` use. */
  readonly targets?: Readonly<Record<string, string>>;
}

/** Every scene in the catalogue. Import an entry's `attach` to build it. */
export const scenes: readonly SceneInfo[] = Object.freeze([
  duneCoastInfo,
  timberValleyInfo,
  fauldTunnelsInfo,
  fauldCountrysideInfo,
  fauldCraterInfo,
  fauldBlastInfo,
]);

/**
 * The catalogue entry named `name`.
 * @throws RangeError for a name not in the catalogue.
 */
export function sceneInfo(name: string): SceneInfo {
  const found = scenes.find((s) => s.name === name);
  if (!found) throw new RangeError(`Unknown scene ${name}; pass one of ${scenes.map((s) => s.name).join(', ')}.`);
  return found;
}
