# Source Sans 3 outline test fonts

Adobe Source Sans 3 Regular, release 3.052R, downloaded unchanged on 2026-11-08.
Copyright 2010-2022 Adobe, Reserved Font Name "Source". SIL Open Font License 1.1;
the complete licence is in [OFL.txt](OFL.txt), downloaded unchanged from
https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/LICENSE.md.

These are standard font/test assets under the repository's clean-room asset exception.
No font-library or other engine code was read or copied. They are not shipped in package tarballs.

`readme/source-sans.json` and `readme/source-sans.png` are the Margo README Sans SDF atlas,
generated from the pinned TTF by `packages/text/scripts/make-readme-atlas.mjs` using Margo's own
distance transform and Chromium's font rasterizer. They cover printable ASCII (U+0020 through U+007E)
at 48 pixels per em with a 16-pixel distance range. The atlas uses the same SIL OFL 1.1;
redistribute [OFL.txt](OFL.txt) with it. The derivative face name avoids Adobe's Reserved Font Name.
No external generator code or prebuilt atlas was copied. These samples are repository assets, not tarball payload.

- TTF: https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/TTF/SourceSans3-Regular.ttf
- OTF (name-keyed CFF1): https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/OTF/SourceSans3-Regular.otf

The independent `outline-reference.json` is our own generated data. The Windows outline API extraction script is
`packages/text/tests/generate-outline-reference.py`; it checks the selected face's head table, records the input
SHA-256 and freezes unhinted absolute cubic controls. Tests verify font SHA-256 against those frozen values.

Pinned unchanged font bytes:

- `SourceSans3-Regular.ttf`: 431,196 bytes, SHA-256 `4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f`.
- `SourceSans3-Regular.otf`: 334,924 bytes, SHA-256 `08df266400933d3178d081a45f94a08814c3e55b4b7dd2e0ff69cb1329f13ab6`.
