# Recorded data in @margoengine/ifc

`src/schema-tree.ts` (shipped in `dist/query.js`) holds the IFC class inheritance of two schemas as plain data: each
entity name below IfcObjectDefinition and the parent its `SUBTYPE OF` clause names. `src/predefined-enums.ts` (shipped
with `readIFCData`) names the enumeration type of each enumerated attribute of the IfcPreDefinedPropertySet subtypes. No definitions, attributes, rules or
documentation text are included, and no code from any source.

- **IFC4 ADD2 TC1 and IFC4X3 ADD2 EXPRESS schemas**, copyright buildingSMART International Limited, 1996-2020
  (https://www.buildingsmart.org). These files allow use in software development and translation into another
  computer language with full attribution; this notice is that attribution.
  Source: https://github.com/buildingSMART/Standards-builds (IFC/RELEASE/IFC4/ADD2_TC1/EXPRESS/IFC4.exp,
  IFC/RELEASE/IFC4_3/HTML/IFC4X3_ADD2.exp).
  Changed: `scripts/schema-tree.mjs` extracts the parent links and the enumerated attributes into one string each per
  schema; the EXPRESS files are not
  shipped. Nothing is derived from the IFC2X3 TC1 EXPRESS file, which reserves all rights: IFC2X3 models use the IFC4
  tree.
