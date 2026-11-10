# Releasing to npm

Nothing is published without the maintainer's go-ahead for that release. The only publish path is the manual
`.github/workflows/publish.yml` workflow; `npm run publish:dry-run` runs the same checks locally and publishes nothing.

## Where the names stand

`margoengine`, `create-margo` and `margo-convert` are on npm as 0.0.1 name placeholders owned by the maintainer, so
they already exist and can take a trusted publisher before the first release; `npm install margoengine` gets the
placeholder until then. No `@margoengine/*` package exists on npm yet: the `margoengine` organization must exist on
npmjs.com, with the maintainer as owner, before the first publish. Nothing here can be published under a scope nobody
owns.

## Accounts and credentials

- **2FA on every npm account with publish rights** (authorization and writes), and on the GitHub account that owns the
  repository. Prefer a security key or passkey over TOTP.
- **No long-lived token.** Preferred: npm trusted publishing (OIDC). On npmjs.com, each package's settings name
  `scottcampbelldata/margoengine`, workflow `publish.yml`, environment `npm-publish` as its trusted publisher; the
  workflow then gets a one-time credential per run (`id-token: write`) and stores nothing. After that, set each package
  to "require two-factor authentication and disallow tokens".
- **Bootstrap exception.** Trusted publishers are configured per existing package, so the first release of names that
  are not on npm yet needs a token: a granular access token, read-and-write for packages only, limited to the
  `@margoengine` scope plus `margoengine`, `create-margo` and `margo-convert`, with the shortest expiry npm offers
  (days, not months), stored only as the `NPM_BOOTSTRAP_TOKEN` secret of the `npm-publish` environment. Revoke it
  and delete the secret right after that first release, then switch every package to trusted publishing.
- **Provenance:** every publish uses `--provenance`, so npm shows which commit and workflow built each tarball. It
  requires each package's `repository.url` to be this GitHub repository (`scripts/supply-chain.mjs` checks it), and npm
  accepts provenance only from a public repository: while this repository is private, the workflow's publish step
  fails at its first package. Make the repository public first, or decide to drop `--provenance` for that release.
- One-time GitHub setup (maintainer): an `npm-publish` environment with the maintainer as required reviewer and `main` as the only
  allowed branch; the repository variable `NPM_PUBLISH_ENABLED=true` when a release is due (the workflow does nothing
  without it); private vulnerability reporting enabled (Settings, Security), which SECURITY.md points to.

## Before a release

1. `npm ci` on a clean checkout. It installs exactly `package-lock.json`, fails if the lockfile and the manifests
   disagree, and checks every tarball against its integrity hash. Never publish from a tree installed with
   `npm install`.
2. `node scripts/set-version.mjs <x.y.z>`: every package, install profile and tool moves in lockstep (`tests/versions.test.js`).
3. `CHANGELOG.md` has a `## <x.y.z>` section (the workflow fails without one): user-facing changes, breaking changes
   with the migration, security fixes with their advisory.
4. `npm audit --omit=dev` must report 0 vulnerabilities; any finding is fixed, or justified in the release notes with
   why it cannot be reached. `npm audit` (dev included) and `npm audit signatures` too. These need the registry.
5. `npm run supply-chain` (rewrites THIRD-PARTY-NOTICES.md) and review the diff: a new dependency needs a reason, an
   allowed licence and no install script. For every runtime dependency and peer, check it is still maintained
   (`npm view <name> time.modified repository.url`) and record anything worrying in the release notes.
6. `npm run check:merge` passes, then `npm run publish:dry-run` and read the file lists.
7. `npm run publish:rehearsal` (part of `publish:dry-run` and of the workflow) proves the release without making it. It
   packs all 98 packages and the two npm tools and audits each tarball: every file the manifest names is shipped, LICENSE, NOTICE and README
   are present, no test or private file, install script or local dependency spec, no maintainer path or email, every
   import declared. It then serves them from a stand-in registry on 127.0.0.1 that refuses every write, and in a clean
   temp project with an empty cache runs `npm install margoengine`, imports every entry in Node, type-checks every entry
   with `skipLibCheck` off, builds the README example with Vite, and runs `npm create margo` for every template.

## Publishing

Run the `Publish` workflow from `main` with the version and `dry_run` checked; read the log; then run it again
unchecked. Order inside the workflow:

1. Leaf workspace packages under `packages/`, in dependency order, including core and stage.
2. `@margoengine/game`, `@margoengine/web`, `@margoengine/viz` and `@margoengine/react-kit`, after their members.
3. `margoengine`, the install-everything option. scripts/publish-order.mjs derives this order from the workspace dependency graph; the workflow publishes one tarball at a time in that order. The four profiles are included automatically;
   do not expose create-margo until all names at the shared version are available. The registry may be temporarily
   incomplete during publication, so the release announcement follows the last successful publish.
4. `margo-convert` (depends on the `@margoengine` packages).
5. `create-margo` last: its templates install the profiles, so they must exist first.

Run `node scripts/kit-install-check.mjs` before a release to prove the domain dependency closures from packed
tarballs, and its separate `scripts/kit-browser-check.mjs` under a shared GPU lock for native and compatibility
first frames. See [kits](guides/kits.md) for names, contents and install measurements. No registry publication is
part of these checks. README authoring remains in the owed list until the README phase.

Afterwards: `npm create margo@latest my-app` in a clean directory, `npx margo-convert --help`, check the provenance
badge on npmjs.com, tag the commit `v<x.y.z>`, and refresh the catalog and site (`npm run build:site`).

## A bad release

- npm does not allow re-publishing a version. Fix forward: publish `<x.y.z+1>` for every package (lockstep).
- `npm deprecate <name>@<x.y.z> "<reason>; upgrade to <x.y.z+1>"` (repeat per package, or use a range) so installs
  warn. This is the normal tool for a broken or vulnerable release.
- `npm unpublish <name>@<x.y.z>` only for a release that must disappear (leaked secret, malicious content), and only
  when npm's unpublish policy allows it (https://docs.npmjs.com/policies/unpublish: time since publish, dependents,
  downloads); otherwise ask npm support. Treat anything
  secret that was in the tarball as compromised and rotate it whether or not the unpublish succeeds.
- Security fixes: publish the GitHub security advisory (with CVE) when the fix ships, as SECURITY.md promises.

## Contacts

Security reports: GitHub private vulnerability reporting or hello@margointeractive.com (SECURITY.md).
