# Batch134 viewcube engine-fixture correction

Main's controls lifecycle change uses Engine.sceneOf(plugin). Three existing
viewcube tests supplied an engine fixture without that method and failed on
disposal. The fixture now returns its owner only for the registered identity;
a same-name clone has no owner. A new OrbitControls teardown assertion verifies
that disposal removes the registration. Existing assertions remain intact.
No production API or behavior changes.

Research before correction compared Barbara H. Liskov and Jeannette M. Wing,
A Behavioral Notion of Subtyping (TOPLAS1994), abstract/introduction, not full,
https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf, with the scoped
RichWasm ownership review in docs/clean-room.md and Margo's own Engine.sceneOf
contract. Test doubles must provide both required methods and identity semantics.
No companion or foreign implementation source was used.

Original full verify:14084 tests,14081 pass,3 fixture failures,zero skipped.
After correction:all19 viewcube tests pass; real viewcube GPU and README gates
pass. Other passed verify steps are retained; no duplicate full verify.
The regression is in packages/viewcube/test/viewcube.test.js and therefore
runs in verify and check:merge. Full batch evidence records all gate receipts.
