# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x (latest minor) | Yes: security fixes ship as patch releases of every affected package |
| < 1.0 | No |

All 75 published packages (`margoengine`, the `@margoengine/*` packages, `create-margo` and `margo-convert`) share one
version, so a fix is always "upgrade to 1.x.y or later" for every package.

## Reporting a vulnerability

Please report privately, not in a public issue, pull request or discussion.

1. **Preferred:** GitHub private vulnerability reporting: the **Security** tab of
   https://github.com/scottcampbelldata/margoengine, then **Report a vulnerability**.
2. **Email:** security@margoengine.com

Include the affected package(s) and version, what an attacker controls (a model file, a URL, a network message, page
content), what happens (crash, hang, memory blowup, script execution, file or cross-origin access), and a minimal file
or snippet that reproduces it. Please do not include real user data.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledge your report | within 3 business days |
| Confirm or reject it, with a severity | within 10 business days |
| Fix released, or a written plan with a date | within 30 days of confirmation |
| Coordinated public disclosure | when the fix ships, and at most 90 days after the report unless we agree otherwise |

We credit reporters in the release notes and the GitHub advisory unless you ask us not to. We will not pursue anyone
who reports in good faith, stays within this policy and does not access other people's data.

## Scope

In scope: the code in the published npm packages and the release process (tarball contents, provenance, dependencies).
That includes every parser of untrusted input (glTF/GLB, OBJ, STL, PLY, 3MF, FBX, USD/USDZ, IFC, STEP/IGES, KTX2/Basis,
Draco, meshopt, EXR, HDR, .margo and the rest), HTML overlays fed with file or user strings, worker messages, and URIs
read from model files. What the engine defends against, and what it leaves to the application, is in
[docs/security.md](docs/security.md).

Out of scope: vulnerabilities in third-party packages that should go to their maintainers (see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); tell us too if Margo Engine makes one exploitable), browser or GPU
driver bugs, denial of service by an application deliberately loading a model larger than its own budget options allow,
and the margoengine.com demo site's hosting configuration (report those to the same address; they are handled, but not
as package advisories).

How releases are built and published (2FA, provenance, lockfile checks): [docs/releasing.md](docs/releasing.md).
