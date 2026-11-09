import configuration from '../../../scripts/speed-phase.json' with { type: 'json' };

/** The browser inherits the runner's phase; a directly opened page uses the repository default. */
export function browserSpeedPhase(search = globalThis.location?.search ?? '') {
  const phase = new URLSearchParams(search).get('speedPhase') ?? configuration.phase;
  if (phase !== 'deferred' && phase !== 'active') throw new Error(`Invalid compute speed phase: ${phase}`);
  return phase;
}
export const speedEnabled = () => browserSpeedPhase() === 'active';
