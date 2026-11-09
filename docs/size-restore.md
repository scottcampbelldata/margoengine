# Optional package quality restoration

Scott's 2026-11-10 optional-package rule permits sensible ceiling growth instead
of reducing quality or complicating an API. Core and stage root are out of scope.
Measurements use `scripts/measure-size.js` bundleBytes, default gzip, bare imports
external, and `measureCoreStage` for the unchanged combined root.

## Labels duplicate attachment (audit finding 1)

Verified on c0e7053ee: the state failure was a TypeError saying `reuse/rename`.
Restore `shared/errors.js` fault, check the name before constructing the renderer,
and give the user both reuse and a complete alternate-name call. Root 5450 to
5550 B gzip; ceiling 5546 to 5806 B. Keeping this synchronous diagnostic in its
owner avoids a needless diagnostic entry or asynchronous attach contract.
Core plus stage remains 23924 B. No speed claim.

Research: Ecma International / TC39, *ECMAScript 2026 Language Specification*,
2026, [Error Objects](https://tc39.es/ecma262/2026/multipage/fundamental-objects.html#sec-error-objects),
permits user-defined Error classes. The existing Margo convention uses TypeError
for arguments and coded MargoError for state failures. W3C / WHATWG, *Web IDL*,
living standard, [Exceptions](https://webidl.spec.whatwg.org/#idl-exceptions),
also separates failure identity from its human-readable message. Use the existing
Margo error identity and retain actionable message detail; no foreign source read
or copied and no new error framework.

Regression: `packages/labels/tests/testpage-attach.test.js` fails on the shortened
TypeError, checks MargoError identity, code, link, name and full repair guidance,
and preserves the renderer and DOM for default and custom-name collisions.
