# Speed

An original evening rail test platform places a 280 rpm turntable in the foreground and an 83 km/h passenger train behind it. Change the shutter from a sharp 0° sample to a 360° exposure. Pause to compare identical geometry positions. Play lets the turntable rotate and the train pass at fixed simulation speeds.

The renderer uses `@margoengine/taa` in velocity-only mode to record both objects' transform motion against the scene depth. `@margoengine/post/motion-blur` gathers a depth-aware exposure in a shared linear HDR PostStack. Both renderers use the same 21 samples, 42-pixel maximum radius, and shutter settings. When paused, the most recent pose is sampled with two deterministic render transforms 1/60 second apart.

The renderer approximates rotation with a short screen-space segment along each pixel's velocity. Blur is bounded and a background surface it reveals must already be visible in the rendered view.

## References

- Morgan McGuire, Padraic Hennessy, Michael Bukowski, and Brian Osman, *A Reconstruction Filter for Plausible Motion Blur*, 2012. https://casual-effects.com/research/McGuire2012Blur/index.html
- Jorge Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare*, SIGGRAPH 2014. https://advances.realtimerendering.com/s2014/index.html
