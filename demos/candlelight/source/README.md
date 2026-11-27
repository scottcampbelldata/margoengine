# Candlelight

An original meter-scale night archive. Five procedural wax candles with brass holders illuminate a walnut reading desk, open astrolabe folio, and brass armillary sphere. Drag or use the arrow keys to inspect the room. The flicker control freezes both the visible flames and the light they cast.

The live calculation in `@margoengine/clustered/flicker` sets the flame colors and intensity variation. The candles contribute roughly 12–16 nominal lumens apiece. Each selected point light uses six shadow faces. The one-flame setting assigns 192×192 texels per face. The three-flame setting assigns 192×192 to the highest-priority light and 96×96 to the next two. The allocation changes with the view, while the five candles continue contributing light. `@margoengine/post/bloom` resolves the bright flames with a fixed exposure. A faint cool fill brings out the window and floor.

This exhibit uses the same model, lights, and shadow budgets on WebGPU and WebGL2. The flicker is a procedural approximation of a candle's varying light output. The shadow budget is active from the opening render. The full bloom pipeline follows in the background on both renderers. The room runs with live animation by default and opens stationary when reduced motion is requested.

## References

- Tomoya Mano and Hiroyuki Kitahata et al., *Flickering candle flames and their collective behavior*, Scientific Reports, 2021. https://www.nature.com/articles/s41598-020-78229-x
- Ting Chen et al., *Frequency and Phase Characteristics of Candle Flame Oscillation*, Scientific Reports, 2018. https://www.nature.com/articles/s41598-018-36754-w
- NASA, *Examples of Blackbody Radiation*, for the relationship between color and temperature. https://acd-ext.gsfc.nasa.gov/anonftp/acd/daac_ozone/Lecture4/Text/Lecture_4/blkbdyexamples.html
