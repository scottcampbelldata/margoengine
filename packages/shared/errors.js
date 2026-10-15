// The error convention (docs/conventions.md) for code in packages/shared, which is bundled into packages that may not depend
// on @margoengine/math (importing it here would make every such package build after math without declaring it).
// The result has MargoError's name and `code`, so `error instanceof MargoError` (it matches by name) and
// `error.code` behave exactly as for the class.
export const margoError = (code, message) => Object.assign(new Error(message), { name: 'MargoError', code });
