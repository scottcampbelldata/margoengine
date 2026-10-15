# Releasing to npm

Nothing is published without Scott's go-ahead for that release. The only publish path is the manual
`.github/workflows/publish.yml` workflow; `npm run publish:dry-run` runs the same checks locally and publishes nothing.

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
  requires each package's `repository.url` to be this GitHub repository (`scripts/supply-chain.mjs` checks it).
- One-time GitHub setup (Scott): an `npm-publish` environment with Scott as required reviewer and `main` as the only
  allowed branch; the repository variable `NPM_PUBLISH_ENABLED=true` when a release is due (the workflow does nothing
  without it); private vulnerability reporting enabled (Settings, Security), which SECURITY.md points to.

## Before a release

1. `npm ci` on a clean checkout. It installs exactly `package-lock.json`, fails if the lockfile and the manifests
   disagree, and checks every tarball against its integrity hash. Never publish from a tree installed with
   `npm install`.
2. `node scripts/set-version.mjs <x.y.z>`: all 75 packages move in lockstep (`tests/versions.test.js`).
3. `CHANGELOG.md` has a `## <x.y.z>` section (the workflow fails without one): user-facing changes, breaking changes
   with the migration, security fixes with their advisory.
4. `npm audit --omit=dev` must report 0 vulnerabilities; any finding is fixed, or justified in the release notes with
   why it cannot be reached. `npm audit` (dev included) and `npm audit signatures` too. These need the registry.
5. `npm run supply-chain` (rewrites THIRD-PARTY-NOTICES.md) and review the diff: a new dependency needs a reason, an
   allowed licence and no install script. For every runtime dependency and peer, check it is still maintained
   (`npm view <name> time.modified repository.url`) and record anything worrying in the HANDOFF.
6. `npm run check:merge` passes, then `npm run publish:dry-run` and read the file lists.

## Publishing

Run the `Publish` workflow from `main` with the version and `dry_run` checked; read the log; then run it again
unchecked. Order inside the workflow:

1. All workspace packages under `packages/` (the `@margoengine/*` packages and `margoengine`).
2. `margo-convert` (depends on the `@margoengine` packages).
3. `create-margo` last: its template installs the `@margoengine` packages, so they must exist first.

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

Security reports: GitHub private vulnerability reporting or security@margoengine.com (SECURITY.md).
