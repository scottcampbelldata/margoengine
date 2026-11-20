# buildingSMART BCF-XML test cases

Standard BCF test data, used unmodified by `packages/ifc/tests/bcf.test.js` and the `/bcf` README example; never
shipped (the package `files` list holds `dist` and the notices only). No code from the source repository is included or
was read: the reader and writer are written from the BCF-XML schemas and documentation.

Source: https://github.com/buildingSMART/BCF-XML, branch release_3_0, folder `Test Cases`.
Licence: (c) buildingSMART International Ltd., Creative Commons Attribution-NoDerivatives 4.0 International
(https://creativecommons.org/licenses/by-nd/4.0/). The files are redistributed verbatim, only renamed. Tests read them
and never write them; `packages/ifc/tests/fixtures-verbatim.test.js` fails when a file's SHA-256 no longer matches its
row below or a file has no row.

| File here | Source path under `Test Cases` | SHA-256 |
| --- | --- | --- |
| Architectural.ifc | IFCs/Architectural.ifc | `cc3b824e915b826dcdc9f7d97f6baad7bbf211252e19b5b0e94b548768f7f72e` |
| v30-single-visible-space.bcf | v3.0/Visualization/Single visible space/single visible space.bcf | `fffb9bb617ca316960c07b796b63b3f8f4702b02cb372a6dc8d427b327e38b3c` |
| v30-one-part-visible.bcf | v3.0/Visualization/One part of decomposed object visible/one part of decomposed object visible.bcf | `361eb1b2949918a325fbdd3a2b28c706019ad9e32095738ce483381d23c017fb` |
| v30-orthogonal-camera.bcf | v3.0/Visualization/Orthogonal camera/orthogonal camera.bcf | `4819d8310b64c024a8ae09f9bbe30598bc567bcf04ee9d091c8cce1bcb1ecac8` |
| v30-related-topics.bcf | v3.0/Markup/Related topics with both topics in the same file/Related topics with both topics in the same file.bcf | `56e61c65520bcfc60e5ac22452ee73b98286ea4c9199dbd7beecf686a93cbe85` |
| v30-due-date.bcf | v3.0/Markup/Due Date/DueDate.bcf | `4fd20571501fc6bcf39ff8d8d9c3c0f22d542c919c645ef3391bf566760a05cf` |
| v30-document-reference-external.bcf | v3.0/Markup/Document Reference External/document reference external.bcf | `0390c4b3ad14c0f268d5c496514bf8239644c0cfc54b1bc300f18c83f3152403` |
| v21-single-visible-space.bcf | v2.1/Visualization/Single visible space/case.bcf | `4c9c5be4b56191644c5c4de0465e45c13c26cfbfe8c0c2d851dd2b29f802c6ae` |
| v21-one-part-visible.bcf | v2.1/Visualization/One part of decomposed object visible/One part visible.bcf | `79ef1d5b4e440e0ef68335291f273d760bc0f3e0ad6c1478156539e7541bc381` |
| v21-internal-bim-snippet.bcf | v2.1/Markup/InternalBIMSnippet/InternalBIMSnippet.bcf | `cb2644518303ae8486eb127fd69b4b9a074a349efaf8dc63ec6afbe89f7ecdfe` |
| v21-related-topics.bcf | v2.1/Markup/related topics with both topics in the same file/case.bcf | `2fe49e8c7ea723458b0329757bf9b47849bbd9e61e0ce774a75dbc61343dc454` |
