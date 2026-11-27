# Molten Words

Type up to fourteen letters or digits to create a bevelled 3D casting. Change the metal temperature to vary the emissive colour, or pause the pour. Drops originate at the lower edges of the actual letter geometry and fall under constant scaled acceleration. The temperature control illustrates the shift in emitted colour. This exhibit does not model heat transfer or solidification.

Margo's text extrusion builds the glyph meshes from the Foundry Sans Black subset. Its shader renders the cast iron, drops and refractory bed. A Margo bloom pass adds the optical halo. The same geometry and material run on WebGPU and its WebGL2 compatibility layer, with the latter selectable using `?backend=webgl2`.

Foundry Sans Black is an uppercase subset of Source Sans 3 at weight 900. Its source comes from the verified Margo checkout's Adobe Source Sans 3 test asset. The SIL Open Font License accompanies the source font.

- [J. C. De Vos, A New Determination of the Emissivity of Tungsten Ribbon, 1954](https://doi.org/10.1016/S0031-8914(54)80001-9).
- [National Bureau of Standards, Pyrometric Practice](https://nvlpubs.nist.gov/nistpubs/nbstechnologic/nbstechnologicpaperT170.pdf).
- [SIGGRAPH 2012, Practical Physically Based Shading in Film and Game Production](https://blog.selfshadow.com/publications/s2012-shading-course/).
