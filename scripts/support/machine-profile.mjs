// Machine profiles (scripts/support/machine-profiles.json, item 57.1a): which GPU tests a machine may run, whether its
// temperature is watched, and whether heavy suites run as short steps. MARGO_MACHINE_PROFILE names the profile. Unset,
// the machine must be identified by its hardware, never by hostname, so no machine names or paths live in public files:
// exactly one profile's `match` must fit this platform, CPU architecture and (when the match names GPUs) the hardware
// display adapters (on Windows read through DXGI by scripts/lib/gpu-adapter.mjs, before any GPU work). No match, or
// more than one, throws a coded error listing the profiles and how to name one. There is no fallback profile: a
// fallback once ran a mini PC as the RTX A6000 workstation, without its heat watch and with the path tracer its
// profile excludes, and the mini PC crashed twice.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { margoError } from '../../packages/shared/errors.js';
import { listAdapters } from '../lib/gpu-adapter.mjs';

/** The profiles file shipped with the repo. */
export const PROFILES_FILE = join(import.meta.dirname, 'machine-profiles.json');

/** Reads and checks a profiles file: `{ profiles: { name: profile } }`. Throws a coded error naming the fix. */
export function readProfiles(file = PROFILES_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data.profiles || typeof data.profiles !== 'object' || !Object.keys(data.profiles).length)
    throw margoError('MACHINE_PROFILES_INVALID', `${file} defines no profiles; add them under "profiles"`);
  if ('default' in data)
    throw margoError(
      'MACHINE_PROFILES_INVALID',
      `${file} names a default profile (${JSON.stringify(data.default)}); remove "default": a run that names no profile must match one by its hardware (a profile's "match"), never fall back to one`,
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
  if (profile.match !== undefined) {
    for (const key of ['platform', 'arch'])
      if (typeof profile.match?.[key] !== 'string' || !profile.match[key])
        throw bad(`match.${key} must name a Node process.${key} value, got ${JSON.stringify(profile.match?.[key])}`);
    for (const key of ['gpu', 'withoutGpu']) {
      const list = profile.match[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.length || list.some((p) => typeof p !== 'string' || !p))
        throw bad(`match.${key} must be a list of display adapter name patterns, got ${JSON.stringify(list)}`);
      for (const pattern of list)
        try {
          new RegExp(pattern);
        } catch (error) {
          throw bad(`match.${key} pattern ${JSON.stringify(pattern)} is not a regular expression (${error.message})`);
        }
    }
  }
  for (const [key, reason] of Object.entries(profile.exclude ?? {}))
    if (typeof reason !== 'string' || !reason.trim())
      throw bad(`exclude.${key} must state the reason the package does not run there`);
}

/**
 * The names of this PC's hardware display adapters, for profile matching: on Windows the DXGI adapter list (software
 * adapters left out), elsewhere an empty list (no profile there matches by GPU). Throws if the Windows lookup fails.
 */
export function displayAdapters(platform = process.platform, list = listAdapters) {
  return platform === 'win32'
    ? [
        ...new Set(
          list()
            .filter((a) => !a.software)
            .map((a) => a.name),
        ),
      ]
    : [];
}

/** This machine's facts: platform, CPU architecture and `gpus`, a function giving the adapter names, asked only when a profile needs them. */
export function thisHost() {
  return { platform: process.platform, arch: process.arch, gpus: () => displayAdapters() };
}

function profileMatches(match, host, gpus) {
  if (!match || match.platform !== host.platform || match.arch !== host.arch) return false;
  if (!match.gpu && !match.withoutGpu) return true;
  const names = gpus(),
    any = (patterns) => names.some((n) => patterns.some((p) => new RegExp(p).test(n)));
  return (!match.gpu || any(match.gpu)) && !(match.withoutGpu && any(match.withoutGpu));
}

function profileList(data) {
  return Object.entries(data.profiles)
    .map(([name, p]) => `  ${name}: ${p.description ?? ''}`)
    .join('\n');
}

/**
 * The profile for this run: `{ name, description, heat, split, exclude, chosenBy }`. MARGO_MACHINE_PROFILE picks it by
 * name. Unset, exactly one profile's `match` must fit `host` (`{ platform, arch, gpus }`, `gpus` the hardware display
 * adapter names or a function giving them); none or several throw MACHINE_PROFILE_UNRESOLVED listing the profiles,
 * before any GPU work. An unknown name throws MACHINE_PROFILE_UNKNOWN listing the known ones.
 */
export function machineProfile(env = process.env, file = PROFILES_FILE, host = thisHost()) {
  const data = readProfiles(file);
  let name = env.MARGO_MACHINE_PROFILE,
    chosenBy = 'MARGO_MACHINE_PROFILE';
  if (!name) {
    let names, lookupError;
    const gpus = () => {
      if (names) return names;
      try {
        names = typeof host.gpus === 'function' ? host.gpus() : (host.gpus ?? []);
      } catch (error) {
        lookupError = String(error?.message ?? error).split('\n')[0];
        names = [];
      }
      return names;
    };
    const matched = Object.entries(data.profiles)
      .filter(([, p]) => profileMatches(p.match, host, gpus))
      .map(([n]) => n);
    if (matched.length !== 1) {
      const seen = `${host.platform} ${host.arch}, display adapters: ${
        lookupError
          ? `lookup failed (${lookupError})`
          : names?.length
            ? names.join(', ')
            : names
              ? 'none found'
              : 'not read'
      }`;
      throw margoError(
        'MACHINE_PROFILE_UNRESOLVED',
        `MARGO_MACHINE_PROFILE is not set and ${
          matched.length
            ? `several profiles match this machine (${matched.join(', ')})`
            : 'no profile matches this machine'
        } (${seen}). Stopped before any GPU work. Name this machine's profile, for example \`export MARGO_MACHINE_PROFILE=mini-pc\` (PowerShell: \`$env:MARGO_MACHINE_PROFILE = 'mini-pc'\`), one of:\n${profileList(data)}\n(scripts/support/machine-profiles.json)`,
      );
    }
    name = matched[0];
    chosenBy = `hardware match (${facts(host, names)})`;
  }
  const profile = data.profiles[name];
  if (!profile)
    throw margoError(
      'MACHINE_PROFILE_UNKNOWN',
      `MARGO_MACHINE_PROFILE=${name} is not a machine profile; set it to one of ${Object.keys(data.profiles).join(', ')} (scripts/support/machine-profiles.json)`,
    );
  return { name, split: false, exclude: {}, heat: null, ...profile, chosenBy };
}

function facts(host, names) {
  return `${host.platform} ${host.arch}${names?.length ? `, ${names.join(', ')}` : ''}`;
}

/**
 * The stated reason `profile` leaves a test out, or null when it runs. `dir` is the package directory (`voxel`) or
 * `root` for the root suites; a key `<dir>/<script>` excludes one script only.
 */
export function excludedReason(profile, dir, script) {
  const reason = profile.exclude?.[`${dir}/${script}`] ?? profile.exclude?.[dir];
  return reason ? `excluded by profile ${profile.name}: ${reason}` : null;
}

/** One line naming the profile, how it was chosen and its heat limits, for the start and end of a run. */
export function describeProfile(profile) {
  const { heat } = profile;
  return `machine profile ${profile.name} (${profile.description})${
    heat
      ? `: pause at ${heat.stopC} C, resume below ${heat.resumeC} C, wait at most ${heat.maxWaitMin} min, at most ${heat.maxResumesPerStep} resumes per step`
      : ': no heat watch'
  }${profile.split ? ', heavy suites in short steps' : ''}${profile.chosenBy ? `; chosen by ${profile.chosenBy}` : ''}`;
}
