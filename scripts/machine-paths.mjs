// Absolute machine paths: a tracked file must not name a drive-letter or Git Bash drive-mount path into a user's home
// folder (a drive followed by Users) or the dev PC's project folder (a drive followed by Development). Such a path
// leaks a machine layout and does not exist in a clone. Name a sibling checkout as `../name`, a tool cache by its
// environment variable (`%LOCALAPPDATA%`), and a home folder as `~`. scripts/check-banned-terms.mjs runs this scan
// over every tracked text file; tests/machine-paths.test.js holds the regression.

const SEP = String.raw`(?:\\\\|\\|/)+`;
const PATTERNS = [
  // Windows drive letter, any separator style, including JSON-escaped backslashes.
  new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:${SEP}(?:Users|Development)(?=${SEP}|$|[^A-Za-z0-9])`, 'i'),
  // Git Bash and WSL drive mounts.
  new RegExp(String.raw`(?<![\w.~-])/(?:mnt/)?[a-z]/(?:Users|Development)(?=/|$|[^A-Za-z0-9])`, 'i'),
];

/**
 * Files that may hold a machine path, each with its reason. A folder entry ends with `/`. A new entry needs a reason
 * a reviewer accepts: third-party bytes we must not edit, a test whose input is such a path on purpose, or a frozen
 * record whose bytes are hashed.
 */
export const MACHINE_PATH_ALLOW = new Map([
  ['packages/fbx/test/fixtures/real/', 'third-party FBX fixtures; their authoring tool wrote the paths into the file'],
  ['packages/fbx/test/loading-materials.test.js', 'a Windows texture path is the input under test'],
  ['tests/api-report-short-path.test.js', 'an 8.3 short temp path is the input under test'],
  ['tests/vite-cache-isolation.test.js', 'an 8.3 short temp path is the input under test'],
  ['tests/wasm-blueprints.test.js', 'a cargo registry path in a home folder is the input under test'],
  ['tests/machine-paths.test.js', 'plants machine paths to prove this check fails on them'],
  [
    'docs/whitepaper/results/physics2d-step-profile-20261108/',
    'frozen physics evidence; bundle-manifest.json hashes every file and verify.mjs checks those bytes',
  ],
]);

/** True when `file` (a repository path with `/`) may hold machine paths. */
export function machinePathAllowed(file) {
  for (const key of MACHINE_PATH_ALLOW.keys()) if (key.endsWith('/') ? file.startsWith(key) : file === key) return true;
  return false;
}

/** True when one line of text names an absolute machine path. */
export function hasMachinePath(line) {
  return PATTERNS.some((pattern) => pattern.test(line));
}

/** The 1-based line numbers of a text that name a machine path; empty for a binary buffer. */
export function machinePathLines(buffer) {
  if (buffer.subarray(0, 8192).includes(0)) return [];
  const lines = [];
  buffer
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      if (hasMachinePath(line)) lines.push(i + 1);
    });
  return lines;
}
