// Names an application gives its native engine integrations: tags, folders, log prefixes and menu labels.

/** An application's name in the three spellings native integrations use. */
export interface NativeAppNames {
  /** As given, for labels, namespaces and tags (`MyApp`). */
  readonly name: string;
  /** Upper case, for log and environment prefixes (`MYAPP`). */
  readonly upper: string;
  /** Lower case, for importer IDs and metadata keys (`myapp`). */
  readonly lower: string;
}

/**
 * Validates an application name for native integrations.
 * @throws TypeError unless `appName` is 1-48 ASCII letters and digits starting with a capital letter.
 */
export function nativeAppNames(appName: unknown): NativeAppNames {
  if (typeof appName !== 'string' || !/^[A-Z][A-Za-z0-9]{0,47}$/.test(appName))
    throw new TypeError(
      'appName must be 1-48 ASCII letters and digits starting with a capital letter; pass a name like "MyApp"',
    );
  return Object.freeze({ name: appName, upper: appName.toUpperCase(), lower: appName.toLowerCase() });
}

/**
 * Validates a manifest file extension (without the dot).
 * @throws TypeError unless `value` is 1-32 lower-case ASCII letters and digits starting with a letter.
 */
export function nativeExtension(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{0,31}$/.test(value))
    throw new TypeError(
      `${label} must be 1-32 lower-case letters and digits starting with a letter; pass an extension without the dot`,
    );
  return value;
}
