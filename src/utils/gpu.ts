// gpu.ts - can this browser run models on the graphics card (WebGPU), and in half precision?

export interface GpuSupport {
  ok: boolean;
  /** shader-f16: the best-accuracy speech model needs it. */
  f16: boolean;
}

/** Only a device that really gets created counts (an adapter can exist and still fail: driver, blocklist, acceleration off). */
export async function detectGpu(): Promise<GpuSupport> {
  const gpu = (globalThis.navigator as any)?.gpu;
  if (!gpu) return { ok: false, f16: false };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, f16: false };
    const device = await adapter.requestDevice();
    device.destroy();
    return { ok: true, f16: !!adapter.features?.has?.('shader-f16') };
  } catch {
    return { ok: false, f16: false };
  }
}
