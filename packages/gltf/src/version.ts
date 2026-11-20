/**
 * glTF 2.0 section 3.2: with no `minVersion` a client checks the major version of `version`; with one, that its major
 * and minor are supported. This loader supports 2.0, so `version: '2.1'` loads, and so does `minVersion: '2.0'`.
 */
export function supportedVersion(asset: { version?: unknown; minVersion?: unknown } | undefined): boolean {
  const pattern = /^(\d+)\.(\d+)$/,
    version = typeof asset?.version === 'string' ? pattern.exec(asset.version) : null;
  if (!version || version[1] !== '2') return false;
  if (asset!.minVersion === undefined) return true;
  const min = typeof asset!.minVersion === 'string' ? pattern.exec(asset!.minVersion) : null;
  return !!min && min[1] === '2' && min[2] === '0';
}
