# Exact live pooled GPU pass attribution

Completed raw profile: `test-results/afterlight-live-scene-gpu-profile-chrome-10s-live-scenes-gpu-v1.json`, SHA `eda5abbb65221ee48eed463c9f96c8dadd52d514959dbd8a1a86617c83321560`. Four windows were desktop/phone/phone/desktop on the same laptop with 1M particles, 1× samples, engine DPR 1 and fixed island clock. Native timestamp samples number 24/26/26/23; every sample contains 23 pass groups. `.metadata` retains actual shader source and pipeline IDs. Attribution uses reviewed WGSL signatures/recorded vertex ABI; no simulated feature timing is substituted.

Values below are median milliseconds (average central pair for even sample counts). A zero is timestamp quantization, not proof of no work. A pass containing multiple pipelines cannot divide its time between them.

| Pass | Pipeline IDs | Package / actual role | Desktop 0 | Phone 1 | Phone 2 | Desktop 3 |
|---:|---|---|---:|---:|---:|---:|
|0|14|Scatter placement/LOD cull|.065536|.065536|.065536|.065536|
|1|15|Scatter placement/LOD cull|0|0|0|0|
|2|16|VFX particle simulation|4.784128|4.784128|4.751360|5.308416|
|3|12,17|Shadows caster geometry|.262144|.262144|.262144|.262144|
|4|12,17|Shadows caster geometry|.131072|.131072|.131072|.131072|
|5|12,17|Shadows caster geometry|.131072|.065536|.098304|.131072|
|6|12,17|Shadows caster geometry|.098304|.065536|.065536|.065536|
|7|13|Clustered light assignment|0|0|0|0|
|8|18|Core PBR carrier with injected package contributions|4.259840|3.342336|3.342336|4.259840|
|9|19|Scatter settlement PBR composite|3.145728|3.145728|3.145728|3.145728|
|10|20|Scatter LOD PBR draw|.786432|.196608|.262144|.786432|
|11|21|Scatter LOD PBR draw|.458752|.458752|.458752|.458752|
|12|7|Sky reflection|0|.065536|.065536|.065536|
|13|10|Sky visible background|.327680|.262144|.262144|.262144|
|14|25,26|Water coastal flow/integration|.393216|.196608|.196608|.393216|
|15|29|Water spray simulation|0|0|0|0|
|16|22|Water scene-depth copy|.196608|.131072|.131072|.196608|
|17|23|Water surface|.786432|.458752|.458752|.786432|
|18|30|Water spray draw|0|0|0|0|
|19|11|Sky depth fog|.196608|.196608|.196608|.196608|
|20|31|VFX particle billboard draw|4.849664|4.685824|4.489216|4.915200|
|21|1|Post bloom blur|.262144|.294912|.262144|.262144|
|22|8|Post Bloom/AgX output|.262144|.262144|.262144|.262144|

Main PBR is an ABI carrier; terrain/cluster/shadow/sky shader injections cannot be assigned separate milliseconds from this pass. Settlement has injected lighting too. Scatter draw 20/21 cannot be definitively assigned to grass versus fieldstones from shader source alone; bound geometry identity is required. Shadow groups may contain Scatter caster callbacks. Pipeline 29 includes coastal helpers but its `droplets` storage writes identify spray simulation; the earlier v2 JSON role classification placed the broader coastal signature first. The subsequent classifier orders spray first; the table uses the actual role. Package-owner Water and measured durations were unchanged.

| Native GPU accounting, median ms | Desktop 0 | Phone 1 | Phone 2 | Desktop 3 |
|---|---:|---:|---:|---:|
|Pass sum|22.839296|19.857408|20.480000|22.282240|
|First-start to last-end span|27.656192|23.429120|24.051712|27.918336|
|Unaccounted intra-span union gap|4.980736|3.506176|3.637248|5.373952|
|VFX combined simulation + billboard|9.732096|9.535488|10.158080|10.027008|

The largest total unexplained native span is phone-window 1 sample 7: span 31.260672 ms, pass sum 21.954560 ms, gap 9.306112 ms. Its largest consecutive-pass gap is 4.259840 ms between Water scene-depth copy (pass 16) and Water surface (17). That interval could contain other commands, synchronization, driver work or idle; timestamps alone do not establish memory bandwidth or the source of a stall.

Asynchronous read/map callback wall medians are 171.95/160.8/177.9/173.7 ms, maximum 231 ms. The largest application Engine.render CPU-return gap is 61.3 ms in phone-window 1 (page 15,387.5→15,448.8 ms). Read-start render/submit counters are bounds only: this run has no proven sample→originating command/submit identity. Native GPU ns are uncalibrated to page/CDP clocks. Thus neither callback delay nor that CPU-return gap is assigned to an individual GPU sample.

Instrumented render rates are 34.8404/39.1912/38.6427/33.5724 Hz, distinct from earlier unprofiled desktop/phone/phone/desktop 22.62/27.20/27.89/23.38 Hz. Timestamp feature negotiation and resolve/map instrumentation can change scheduling. They are diagnostic evidence, not speed acceptance. Runtime counts/occupancies remained 1M and timed resource allocations zero; normal resource retirement passed. The original raw browser-close deadline failed, then the exact owned browser was closed and the sibling explicitly released the native slot. Raw failure evidence is retained.

The live VFX pipeline already ping-pongs two state buffers: compute reads state[i], writes state[1-i], then front flips. Alive, indirect and respawn buffers are shared rather than swapped. Billboard vertex code reads state and alive through STORAGE bindings, with no VERTEX input buffer. The private blend probe checks these exact roles; a missing ping-pong path is not the live explanation. Any D3D12 resource-dependency or blending hypothesis still needs a controlled same-device measurement.
