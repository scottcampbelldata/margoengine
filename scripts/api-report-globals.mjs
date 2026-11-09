// A Program belongs to one immutable snapshot. Global augmentations belong to a
// package, so neither its file list nor its declaration walk depends on the entry.
export function createGlobalReports(program, { key, compare, render }) {
  let files;
  const reports = new Map();
  return (home) => {
    if (!reports.has(home))
      reports.set(
        home,
        (async () => {
          const names = await (files ??= program.getSourceFileNames());
          const declarations = [];
          for (const file of names.filter((name) => key(name).startsWith(home)).sort((a, b) => compare(key(a), key(b))))
            for (const statement of (await program.getSourceFile(file))?.statements ?? []) {
              const text = render(statement);
              if (text !== undefined) declarations.push(text);
            }
          return [...new Set(declarations)].join('\n\n');
        })(),
      );
    return reports.get(home);
  };
}
