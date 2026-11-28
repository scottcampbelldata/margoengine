# Ambient Occlusion

The Chambered Spiral is an original cast-mineral sculpture inspired by the septa and cross section of a nautilus shell. Its curled body has real geometry, back surfaces, partition walls, and thickened rims. Light, camera, and surface colors stay fixed when the occlusion method changes.

Margo's SSAO uses a 28-point depth hemisphere. GTAO estimates the visible arc in three horizon slices with seven samples on each side. Both share the same world-space radius, bilateral filtering, and ambient-light composition. The Off view leaves the direct and ambient lighting in place for comparison. Both estimates are screen-space, so the result can change as previously hidden chambers come into view.

The exhibit runs one occlusion effect in a shared HDR PostStack and changes the active effect with the standard stack API. This uses the same sculpture, radius, method, and frame size rule on WebGPU and WebGL2.

## References

- Jorge Jimenez, Xian-Chun Wu, Angelo Pesce, and Adrian Jarabo, *Practical Real-Time Strategies for Accurate Indirect Occlusion*, 2016. https://www.activision.com/cdn/research/PracticalRealtimeStrategiesTRfinal.pdf
- Louis Bavoil and Miguel Sainz, *Image-Space Horizon-Based Ambient Occlusion*, 2008. https://developer.download.nvidia.com/presentations/2008/SIGGRAPH/HBAO_SIG08b.pdf
- Smithsonian National Museum of Natural History, *Chambered Nautilus*, a bisected specimen used as visual reference. https://www.si.edu/object/chambered-nautilus-emperor-nautilus%3Anmnheducation_11004283
