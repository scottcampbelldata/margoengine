import { fault } from '../../shared/errors.js';

/** Exact core version. The build checks this against the package manifest. */
export const CORE_VERSION = '1.0.0';

/** A package's build requirement and the core module it actually resolved. */
export interface CoreRequirement {
  readonly version: string;
  readonly source: string;
  readonly runtime: { readonly version: string; readonly source: string };
}

const runtime = { version: CORE_VERSION, source: import.meta.url };

/** Declare a build requirement; defaults to this core's version and module URL, with no global state. */
export function coreRequirement(version = CORE_VERSION, source = import.meta.url): CoreRequirement {
  return { version, source, runtime };
}

/** Check the engine-local core registry before a package attaches or reads runtime internals. */
export function assertCore<T extends { readonly coreRequirement?: CoreRequirement }>(
  engine: T,
  required: CoreRequirement = coreRequirement(),
): T {
  const actual = engine?.coreRequirement?.runtime;
  // EngineKernel is structural: stand-in implementations have no Margo runtime registry to conflict with.
  if (
    actual &&
    (actual.version !== required.version ||
      actual.version !== required.runtime.version ||
      // Identity also catches two installs that a bundler gives the same output URL.
      actual !== required.runtime)
  )
    throw fault(
      'version',
      `core ${actual.version} ${actual.source}; ${required.source} needs ${required.version}, got ${required.runtime.version} ${required.runtime.source}`,
    );
  return engine;
}
