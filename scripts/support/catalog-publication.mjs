// The catalog's published flag. package.json in this repo is 1.0.0. npm has 0.1.0.
// A package counts as on npm when the registry has it, and npmVersion is the
// dist-tag latest when that is not the version in package.json.

export function publicationFromRegistry(manifestVersion, body) {
  const versions = body?.versions;
  if (!versions || typeof versions !== 'object') return { published: false };
  if (versions[manifestVersion]) return { published: true };
  const latest = body['dist-tags']?.latest;
  if (typeof latest === 'string' && versions[latest]) return { published: true, npmVersion: latest };
  return { published: false };
}
