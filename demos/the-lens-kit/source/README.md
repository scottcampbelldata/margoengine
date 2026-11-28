# The Lens Kit

Four camera settings share an original night ferry pier, moving camera, fixed exposure and AgX display transform. Pan by up to 11 degrees to move the main light and architectural lines through the view.

- **Clear** is the reference camera view with the optical treatments off.
- **Flare** uses Margo LensFlare with its built-in halo and ghost images. The bright pier lamp is projected from a world-space coordinate and tested against the scene depth.
- **Streak** uses Margo Anamorphic with four spreading passes on the bright HDR image. Blue is an authored coating look.
- **Vintage** uses Margo Lens for barrel distortion and dust, with lateral red/blue channel displacement from Margo Tonemap. Compare the rails and window mullions near either edge.

These treatments reproduce selected visible behaviors in a common camera view. The presets are illustrative screen-space optical models and do not reproduce a calibrated lens or trace through physical lens elements. The scene was built in metres from original procedural geometry. The ferry terminal and vessel are fictional.

Margo Engine public pin `0efd9cff8230507a32deb49907ecd499d46925f5`. WebGPU opens first, with actual Margo WebGL2 compatibility where HDR post effects are supported.

## References

- Hullin, Eisemann, Seidel and Lee. [*Physically-Based Real-Time Lens Flare Rendering*](https://pure.mpg.de/pubman/item/item_3567600_1/component/file_3591754/HullinEtAl-LensflareRendering-SIGGRAPH2011.pdf), ACM Transactions on Graphics, 2011.
- Kolb, Mitchell and Hanrahan. [*A Realistic Camera Model for Computer Graphics*](https://graphics.stanford.edu/papers/camera/), SIGGRAPH, 1995.
- Cooke Optics. [*Anamorphic lenses – always evolving*](https://cookeoptics.com/news-and-events/anamorphic-lenses-always-evolving/). Optical character and horizontal flare reference.
- Washington State Department of Transportation. [*Seattle Multimodal Terminal at Colman Dock Project*](https://wsdot.wa.gov/construction-planning/search-projects/ferries-seattle-multimodal-terminal-colman-dock-project). Waterfront staging, architecture and ferry reference.
