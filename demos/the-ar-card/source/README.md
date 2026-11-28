# The AR Card

Vela 17 is an original tabletop radio with a fired red enamel case, dark Bakelite wheel, brass knurl, frequency scale, and rear sockets. The preview rotates the 3D model through 360 degrees. The product measures 22.4 × 16.0 × 12.0 cm and sits at the AR ground plane.

The page uses Margo's lightweight glTF loader for the same authored geometry used in the USDZ file. Soft studio shadows finish after the first working angle change. On a browser that reports Quick Look support, the native `rel="ar"` link opens the USDZ at its authored scale. Hosts that serve `model/vnd.usdz+zip` provide a direct model URL. Other hosts use a typed local copy of the same USDZ. A download of the original file is available on every browser.

## Reproduction

From the showcase root, run `node src/the-ar-card/tools/build-product.mjs` with `MARGO_ENGINE_CHECKOUT` pointing to the pinned public Margo Engine checkout. The tool builds the original meshes in metres and exports a GLB, its compressed browser transport, and a static USDZ using Margo's USDZ exporter. The compact AR transport expands to the exact exported ZIP bytes. The thumbnail comes from the final Margo preview frame.

## References

- Apple, *Previewing a Model with AR Quick Look*. [Documentation](https://developer.apple.com/documentation/arkit/previewing-a-model-with-ar-quick-look).
- Apple, *Advances in AR Quick Look*, WWDC 2019. [Web hosting requirements](https://developer.apple.com/videos/play/wwdc2019/612/).
- Alliance for OpenUSD, *USDZ File Format Specification*. [Archive layout and root layer](https://openusd.org/release/spec_usdz.html).
- Cooper Hewitt, Smithsonian Design Museum, *T 52 Portable Radio* (1961), and Smithsonian National Museum of American History, *Globe Trotter 8 Transistor Radio*. [Design reference](https://collections.si.edu/search/detail/edanmdm%3Achndm_1986-99-23), [Portable radio context](https://americanhistory.si.edu/collections/object/nmah_1153317).
