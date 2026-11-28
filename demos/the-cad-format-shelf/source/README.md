# The CAD Format Shelf

Open two exchange files side by side. The left pane reads native STEP products and assembly placements. The right pane opens IGES faces and solids through Margo's public B-rep reader and shows the original directory entries alongside their imported product tree. Select a row to highlight the actual placed geometry. The listed dimensions come from tessellated bounds in each file's units. Each model is fitted independently to its inspection plinth.

## Source specimens

All engine fixtures come from public Margo Engine at the verified exhibit pin `0efd9cff8230507a32deb49907ecd499d46925f5`, under Apache-2.0.

- The STEP mounting plate comes from `examples/cad-viewer/plate.step`. [CAD viewer source](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/examples/cad-viewer).
- The IGES trimmed plate, cylinder and conic trims come from `packages/brep/tests/fixtures/iges/{plate,cylinder,conics}.igs`. Margo's fixtures were written from the IGES specification. [IGES fixtures](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/brep/tests/fixtures/iges).
- The bracket test fixture is the exact AP214 payload from the product-structure test. It contains one placed triangular face so the occurrence hierarchy and transform are easy to audit. [STEP product-structure fixture](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/brep/tests/step-structure.test.js).
- The five-component upright bracket assembly is an original solid specimen made for this exhibit. Margo's B-rep writer emits its three part definitions. The preparation script assigns its five placements and validates the assembly after reading it back.

The browser runs the pinned public Margo B-rep parser and exact-surface tessellator in a worker. It reads the original exchange bytes for every sample. Both render paths then display the same resulting meshes in Margo Engine. Regenerate the fixtures and original assembly with `node tools/prepare-samples.mjs` using `MARGO_ENGINE_CHECKOUT` pointing to the verified, built checkout.

## Format references

- ISO 10303-21:2016, *Industrial automation systems and integration — Product data representation and exchange — Part 21: Implementation methods: Clear text encoding of the exchange structure*. [ISO standard](https://www.iso.org/standard/63141.html).
- Robert Lipman, *STEP File Analyzer User's Guide*, NISTIR 8122 (2016). [NIST report](https://nvlpubs.nist.gov/nistpubs/ir/2016/NIST.IR.8122.pdf).
- U.S. Product Data Association, *Initial Graphics Exchange Specification (IGES) 5.3* (1996). [Specification](https://escholarship.org/uc/item/7cq3z537).
