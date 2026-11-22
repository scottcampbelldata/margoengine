// Per-shot control of a scene's settings (docs/shots.md, "Scene settings per shot"): a shot header may name a catalogue
// `scene` and a `settings` block, `{target: {row: value | {keys: [{time, value, ease}]}}}`. A target is a name from the
// scene's `info.targets`, bound to the settings entry of one package; the rows are that package's own. This module loads
// those tables, checks the block with the package's rules before a render starts, and evaluates it for each sub-frame;
// the page's `settings` hook (shot.page.settings) writes the values through the package's own apply function.
import { sceneInfo } from '@margoengine/scenes';
import { checkShotSettings, shotSettingsAt } from '@margoengine/scenes/shot-settings';

/**
 * The settings tables of a shot's targets, by target name: each target's package entry (from the scene's
 * `info.targets`) is imported and its `*_SETTINGS` table taken (the one named after `#`, else the entry's one table, else
 * the table named after the package, `WEATHER_SETTINGS` for `@margoengine/weather/settings`).
 * `info` defaults to the catalogue entry named by `shot.scene` (a test passes its own).
 * @throws RangeError for an unknown scene, TypeError for a target the scene does not list or an entry with no table.
 */
export async function loadShotTables(shot, info = sceneInfo(shot.scene)) {
  const tables = {};
  for (const target of Object.keys(shot.settings)) {
    const entry = info.targets?.[target];
    if (!entry)
      throw new TypeError(
        `shot.settings.${target}: scene ${shot.scene} has no target ${target}; use one of ${Object.keys(info.targets ?? {}).join(', ') || 'none (the scene lists no targets)'}`,
      );
    // `entry` is a package entry, or `entry#NAME` to name the table when the entry exports more than one.
    const [path, wanted] = entry.split('#');
    const module = await import(path);
    const found = Object.keys(module).filter(
      (key) => key.endsWith('_SETTINGS') && !key.endsWith('_LIVE_SETTINGS') && Array.isArray(module[key]),
    );
    // With several tables, the one named after the package is the entry's own: `@margoengine/weather/settings` gives
    // WEATHER_SETTINGS beside the AVALANCHE_ and SNOW_ tables an entry adds later, so a catalogue line keeps working.
    const own = `${path
      .replace(/^@[^/]+\//, '')
      .split('/')[0]
      .replace(/-/g, '_')
      .toUpperCase()}_SETTINGS`;
    const name = wanted ?? (found.length === 1 ? found[0] : found.includes(own) ? own : undefined);
    if (!name || !Array.isArray(module[name]))
      throw new TypeError(
        `shot.settings.${target}: ${path} exports ${found.length ? `${found.join(', ')}; name one as ${path}#NAME` : 'no *_SETTINGS table'}`,
      );
    tables[target] = module[name];
  }
  return tables;
}

/**
 * Checks a parsed shot's settings before anything renders: every target, row, value, key time and ease, by the packages' own
 * rules, against the shot's own length (its authored `fullSeconds` when `--seconds` cut it short, so a key past the cut
 * is kept, KB-SHOT-SECONDS-KEYS1). Returns the tables for {@link shotValuesAt}; null for a shot with no settings.
 * @throws TypeError or RangeError naming the target and row.
 */
export async function checkShotFileSettings(shot, info) {
  if (!shot.settings) return null;
  const tables = await loadShotTables(shot, info);
  checkShotSettings(shot.settings, tables, shot.fullSeconds ?? shot.seconds);
  return tables;
}

/** The values to write at cutscene time `seconds` of a shot (its own clock starts at `shot.from`), or null with no settings. */
export const shotValuesAt = (shot, tables, seconds) =>
  tables ? shotSettingsAt(shot.settings, tables, Math.max(0, seconds - shot.from)) : null;

/**
 * The shot files of a scene, written from `info.shots` so a shot is authored once: for each `SceneShot`, a header with its
 * `seconds`, `scene`, `settings` and probes' names, around the cutscene `tracks` the caller gives for that shot name (the
 * camera moves come from the scene's views and anchors, which the catalogue does not hold).
 * @param {object} info A catalogue entry (`sceneInfo(name)`).
 * @param {{page: object, tracks: Record<string, object[]>, kind?: string}} options
 */
export function shotFilesFromScene(info, { page, tracks, kind = 'long' }) {
  return (info.shots ?? []).map((s) => {
    if (!tracks[s.name])
      throw new RangeError(
        `No tracks for shot ${s.name} of scene ${info.name}; pass tracks[${JSON.stringify(s.name)}].`,
      );
    return {
      format: 'margo-cutscene',
      version: 1,
      duration: s.seconds,
      tracks: tracks[s.name],
      shot: {
        format: 'margo-shot',
        version: 1,
        id: `${info.name}-${s.name}`,
        kind,
        seconds: s.seconds,
        scene: info.name,
        ...(s.settings ? { settings: s.settings } : {}),
        page,
      },
    };
  });
}
