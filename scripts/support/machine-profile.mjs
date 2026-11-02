// Machine profiles (scripts/support/machine-profiles.json, item 57.1a): which GPU tests a machine may run, whether its
// temperature is watched, and whether heavy suites run as short steps. The profile is chosen by name
// with MARGO_MACHINE_PROFILE, never by hostname, so no machine names or paths live in public files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { margoError } from '../../packages/shared/errors.js';

/** The profiles file shipped with the repo. */
export const PROFILES_FILE = join(import.meta.dirname, 'machine-profiles.json');

/** Reads and checks a profiles file: `{ default, profiles: { name: profile } }`. Throws a coded error naming the fix. */
export function readProfiles(file = PROFILES_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data.profiles?.[data.default])
    throw margoError(
      'MACHINE_PROFILES_INVALID',
      `${file} names default profile ${JSON.stringify(data.default)}, which it does not define; set "default" to one of ${Object.keys(data.profiles ?? {}).join(', ')}`,
    );
  for (const [name, profile] of Object.entries(data.profiles)) checkProfile(name, profile, file);
  return data;
}

function checkProfile(name, profile, file) {
  const bad = (what) =>
    margoError('MACHINE_PROFILES_INVALID', `${file} profile "${name}": ${what}; fix the entry in that file`);
  const { heat } = profile;
  if (heat !== null && heat !== undefined) {
    for (const key of ['stopC', 'resumeC', 'maxWaitMin', 'maxResumesPerStep', 'pollS'])
      if (!(Number(heat[key]) >= 0) || !Number.isFinite(Number(heat[key])))
        throw bad(`heat.${key} must be a number of 0 or more, got ${JSON.stringify(heat[key])}`);
    if (!(heat.resumeC < heat.stopC))
      throw bad(`heat.resumeC (${heat.resumeC}) must be below heat.stopC (${heat.stopC})`);
    if (!(heat.maxWaitMin > 0)) throw bad('heat.maxWaitMin must be above 0, so a cooldown always ends');
  }
  for (const [key, reason] of Object.entries(profile.exclude ?? {}))
    if (typeof reason !== 'string' || !reason.trim())
      throw bad(`exclude.${key} must state the reason the package does not run there`);
}

/**
 * The profile for this run: `{ name, description, heat, split, exclude }`. MARGO_MACHINE_PROFILE picks it by
 * name (unset: the file's default). An unknown name throws MACHINE_PROFILE_UNKNOWN listing the known ones.
 */
export function machineProfile(env = process.env, file = PROFILES_FILE) {
  const data = readProfiles(file),
    name = env.MARGO_MACHINE_PROFILE || data.default,
    profile = data.profiles[name];
  if (!profile)
    throw margoError(
      'MACHINE_PROFILE_UNKNOWN',
      `MARGO_MACHINE_PROFILE=${name} is not a machine profile; set it to one of ${Object.keys(data.profiles).join(', ')} (scripts/support/machine-profiles.json)`,
    );
  return { name, split: false, exclude: {}, heat: null, ...profile };
}

/**
 * The stated reason `profile` leaves a test out, or null when it runs. `dir` is the package directory (`voxel`) or
 * `root` for the root suites; a key `<dir>/<script>` excludes one script only.
 */
export function excludedReason(profile, dir, script) {
  const reason = profile.exclude?.[`${dir}/${script}`] ?? profile.exclude?.[dir];
  return reason ? `excluded by profile ${profile.name}: ${reason}` : null;
}

/** One line naming the profile and its heat limits, for the start and end of a run. */
export function describeProfile(profile) {
  const { heat } = profile;
  return `machine profile ${profile.name} (${profile.description})${
    heat
      ? `: pause at ${heat.stopC} C, resume below ${heat.resumeC} C, wait at most ${heat.maxWaitMin} min, at most ${heat.maxResumesPerStep} resumes per step`
      : ': no heat watch'
  }${profile.split ? ', heavy suites in short steps' : ''}`;
}
