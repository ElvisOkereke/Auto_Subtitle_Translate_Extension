import { ModeLauncher } from '../modeLauncher';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const fakeMode = () => ({ stop: jest.fn() });

describe('ModeLauncher (one subtitle mode at a time)', () => {
  it('a newer start wins over a slower older one, which is stopped when it arrives', async () => {
    const launcher = new ModeLauncher<ReturnType<typeof fakeMode>>();
    const slow = deferred<ReturnType<typeof fakeMode>>();
    const a = fakeMode();
    const b = fakeMode();
    const first = launcher.start(() => slow.promise);
    const second = launcher.start(async () => b);
    expect(await second).toBe(b);
    slow.resolve(a);
    expect(await first).toBeNull();
    expect(a.stop).toHaveBeenCalled();
    expect(launcher.current).toBe(b);
    expect(b.stop).not.toHaveBeenCalled();
  });

  it('stop() during a start cancels it: nothing keeps running', async () => {
    const launcher = new ModeLauncher<ReturnType<typeof fakeMode>>();
    const slow = deferred<ReturnType<typeof fakeMode>>();
    const a = fakeMode();
    const started = launcher.start(() => slow.promise);
    launcher.stop();
    slow.resolve(a);
    expect(await started).toBeNull();
    expect(a.stop).toHaveBeenCalled();
    expect(launcher.current).toBeNull();
  });

  it('starting stops the running mode first', async () => {
    const launcher = new ModeLauncher<ReturnType<typeof fakeMode>>();
    const a = fakeMode();
    await launcher.start(async () => a);
    await launcher.start(async () => fakeMode());
    expect(a.stop).toHaveBeenCalled();
  });

  it('a failed start leaves nothing running and reports the error', async () => {
    const launcher = new ModeLauncher<ReturnType<typeof fakeMode>>();
    await expect(launcher.start(() => Promise.reject(new Error('no OCR')))).rejects.toThrow('no OCR');
    expect(launcher.current).toBeNull();
  });
});
