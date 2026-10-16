# Chromium presentation source investigation

Read-only investigation at Chrome revision `cfaadc5a132d78e1828635aa8405a499f3e14864`, corresponding to recorded Chrome155.0.8059.40. No browser, GPU test, production edit, OS density change, or display refresh change was performed for this investigation.

The trace establishes expensive CPU wall time inside a presentation wrapper; it does not identify the driver/kernel/DWM suboperation that consumed that time. Root's offline analysis reports 400 `DXGISwapChainImageBacking::Present` calls with a 7342ms interval union, no recorded child scopes, and a largest call about28ms. Main renderer scripting median1.3ms, submit return about0.1ms, GC26ms/10s are separate CPU observations. Nested durations must not be added as independent time.

## Exact call tree and waits

```text
WebGPU canvas texture / SharedImage (application size)
  -> cc TextureLayer / CSS presentation geometry
  -> Viz compositor resource reads and root/render-pass drawing
  -> SkiaOutputDeviceDComp::ScheduleOverlays
       -> BeginOverlayAccess(mailbox)
       -> overlay representation BeginScopedReadAccess
       -> DXGISwapChainOverlayImageRepresentation::BeginReadAccess
       -> DXGISwapChainImageBacking::Present
            -> IDXGISwapChain1::Present1(syncInterval=0, flags, dirtyRect)
            -> first_swap_ only: EnqueueSetEvent + CPU event.Wait
  -> SkiaOutputDeviceDComp::Present
       -> DCompPresenter::Present
       -> EnqueuePendingFrame
       -> DCLayerTree::CommitAndClearPendingOverlays
       -> swap ack; later VSync/presentation feedback
```

The [exact backing implementation](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/command_buffer/service/shared_image/dxgi_swap_chain_image_backing.cc) calls native `Present1` with interval0. Tearing is conditional. The traced scope also contains HRESULT handling and the first-swap-only event wait; it contains no explicit steady-frame copy or CPU completion-fence wait. Consequently the steady wrapper's dominant time is consistent with time in native `Present1`, but source plus this uninstrumented trace cannot distinguish driver queue throttling, compositor dependencies, copies internal to DXGI, or DWM scheduling. Nor does syncInterval0 guarantee a nonblocking native Present call. See Microsoft's [Present1 contract](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgiswapchain1-present1).

The backing is a D3D11 composition swapchain, flip-sequential, single sample. Creation conditionally enables a frame-latency waitable object and calls SetMaximumFrameLatency with a feature parameter. That feature's actual installed state and queued-frame value are unmeasured. Default non-Graphite root buffering is2 in [gpu_util.cc](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/config/gpu_util.cc); the recorded Graphite-disabled condition is compatible with this path, but no runtime swapchain descriptor was captured.

The direct caller is [overlay BeginReadAccess](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/command_buffer/service/shared_image/dxgi_swap_chain_image_representation.cc). [SkiaOutputDeviceDComp](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/components/viz/service/display_embedder/skia_output_device_dcomp.cc) resolves overlay mailboxes through shared-image representations. Its own Present invokes the DComp presenter after scheduling those overlays. This is not the JS `GPUQueue.submit` call.

[DCompPresenter::CheckPendingFrames](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/gl/dcomp_presenter.cc) currently has a TODO to restore D3D11 query-based GPU-work tracking. Current feedback based on pending frames and VSync must not be treated as per-frame GPU-completion proof or proof that each app submit reached the screen.

## Shared resources between Dawn and composition

[D3DImageBacking](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/gpu/command_buffer/service/shared_image/d3d_image_backing.cc) has distinct imports/access paths for native D3D11 textures, supported D3D11on12-unwrapped D3D12 resources, and DXGI shared handles. Dawn BeginAccess imports pending fences; EndAccess exports fence state. Other accesses may acquire keyed mutexes. These paths are outside the exact observed Present implementation and cannot be assumed active solely from its name.

[D3DSharedFence](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/gfx/win/d3d_shared_fence.cc) waits through D3D11 context4 Wait or D3D12 queue Wait, with same-device/queue and completed-value fast paths. Microsoft's [D3D12 Wait documentation](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12commandqueue-wait) explicitly distinguishes that queued GPU-side wait, which returns immediately, from a CPU event wait. The backing also defines a different `D3DImageBacking::PresentSwapChain` trace; do not conflate that path with the captured `DXGISwapChainImageBacking::Present`.

## Canvas size versus compositor size

[GPUCanvasContext](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/third_party/blink/renderer/modules/webgpu/gpu_canvas_context.cc) sets texture dimensions from canvas Reshape(width,height), and initializes its compositor layer with host CSS properties. [WebGPUSwapBufferProvider](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/third_party/blink/renderer/platform/graphics/gpu/webgpu_swap_buffer_provider.cc) uses those descriptor dimensions for its SharedImage, exports a transferable resource, and uses cc::TextureLayer. On Windows its display usage is DISPLAY_READ, without the SCANOUT bit used on Mac and optionally ChromeOS. Thus a native Windows canvas resource is not automatically the final scanout swapchain.

[SkiaOutputSurfaceImpl::Reshape](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/components/viz/service/display_embedder/skia_output_surface_impl.cc) separately takes output `params.size` and device scale factor, creates its output image information, and schedules GPU-side Reshape. GPU-side Reshape forwards to the output device. DComp output Reshape resizes its presenter/child window to this output size. These independent size inputs explain why the engine target and compositor presentation surface can differ.

Recorded app viewport, CSS canvas and backing texture are1432×768; engineDPR1, browserDPR2. Native display2880×1800,120Hz, AC online; browser window bounds1448×902 at(10,10). The observed dirtyRect(0,286,2864,1505) has exactly twice the canvas CSS width, consistent with compositor scaling. Its height is not exactly twice768. A dirty rectangle is not a full swapchain descriptor: exact clipping/origin cause, full swapchain dimensions, client physical dimensions and native child HWND dimensions remain unverified.

## Smallest supported next diagnostic

First compare fresh owned Chrome contexts in ABBA order, keeping full scene,1×AA, engineDPR1, actual canvas texture1432×768, CSS1432×768, fixed camera and original features identical. A uses native/browserDPR2. B uses [--force-device-scale-factor=1](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/display/display_switches.cc) AND Playwright deviceScaleFactor1, because the explicit2 emulation must not override the intended condition. This flag changes browser UI and contents density; it is a presentation diagnostic, not a quality-equivalence or package-performance acceptance test. OS density and refresh remain untouched.

Before each window record accepted browser flags, page DPR/screen/visualViewport, CSS and GPU texture dimensions, Browser.getWindowForTarget bounds, and owned native HWND GetWindowRect/GetClientRect/GetDpiForWindow where available. Trace BeginOverlayAccess debug_label/image_size/mailbox, output reshape, dirtyRects, cc/Viz scheduling and real render/submit timing. Treat missing full swapchain descriptors explicitly as missing. Compare app GPU timestamp pass costs separately from Present CPU wall time; preserve distinct clocks and exact sample submit origins.

A separate source-backed [--disable-gpu-vsync](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/gl/gl_switches.cc) comparison can follow if needed. [UseGpuVsync](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/gl/gl_features.cc) honors that flag. It affects DComp feedback pacing and permits tearing when supported via [DirectCompositionSwapChainTearingEnabled](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/gl/direct_composition_support.cc); it is not isolated to a single GPU fence. The broader [--disable-frame-rate-limit](https://raw.githubusercontent.com/chromium/chromium/cfaadc5a132d78e1828635aa8405a499f3e14864/components/viz/common/switches.cc) is documented to remove cc and display begin-frame limiting AND imply disable-gpu-vsync. Do not stack these changes with the density comparison or call additional renders additional physical presentations. No fake VSync, shader-debug symbols, blanket DirectComposition disable or display change is proposed.

## Preserved source evidence

Original ten-file source archive and manifest: `test-results/chromium-present-cfaadc5a132d78e1828635aa8405a499f3e14864-2026-10-13T183450892Z`. It preserves one404 for an initially wrong fence path.

Supplemental eleven-file archive and manifest: `test-results/chromium-present-scaling-cfaadc5a132d78e1828635aa8405a499f3e14864-2026-10-13T184416823Z`. All eleven downloads succeeded. Every file has its exact official URL, byte length and SHA256. The corrected fence path is `ui/gfx/win/d3d_shared_fence.cc`. Only private source archives/scripts and this report were added.
