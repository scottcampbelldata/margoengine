// Figure's lazy door to the export module. figure.ts loads this module with import() for toPNG and toSVG, while the
// ./export-media entry imports export.ts statically (and tree-shaken) for its overlay painter; a separate door keeps
// any module from importing export.js both ways, so the import() still splits (tests/dist-dynamic-imports.test.js).
export * from './export.js';
