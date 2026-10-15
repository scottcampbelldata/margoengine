export function afterPresented(queue: Pick<GPUQueue, 'onSubmittedWorkDone'>, signal: AbortSignal): Promise<void>;
export interface PrincipalSceneReadiness {
  principalSceneSubmitted: number | null;
  principalSceneGpuComplete: number | null;
  principalScenePresentedOpportunity: number | null;
  correlation: 'identified-webgpu-submit' | 'webgl-render-return';
}
export function submitPrincipalScene(
  render: () => void,
  queue?: Pick<GPUQueue, 'submit' | 'onSubmittedWorkDone'>,
  options?: {
    signal?: AbortSignal;
    now?: () => number;
    request?: typeof requestAnimationFrame;
    cancel?: typeof cancelAnimationFrame;
  },
): Promise<PrincipalSceneReadiness>;
