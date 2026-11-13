import { MseReadAhead } from '../readAheadSource';

// jsdom has no ImageBitmap/OffscreenCanvas; minimal stand-ins.
class FakeBitmap {
  width = 4;
  height = 2;
  closed = false;
  close() {
    this.closed = true;
  }
}

beforeAll(() => {
  (globalThis as any).ImageBitmap = FakeBitmap;
  (globalThis as any).OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
    }
  };
});

function fakeVideo(currentTime: number, bufferedEnd: number): HTMLVideoElement {
  return {
    currentTime,
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
  } as unknown as HTMLVideoElement;
}

function frame(t: number) {
  const bitmap = new FakeBitmap();
  window.dispatchEvent(new MessageEvent('message', { data: { astTapFrame: true, t, bitmap }, source: window }));
  return bitmap;
}

describe('MseReadAhead (untrusted main-world messages)', () => {
  let delivered: number[];
  let source: MseReadAhead;

  beforeEach(() => {
    delivered = [];
    source = new MseReadAhead(fakeVideo(10, 40), { x: 0, y: 0, w: 1, h: 1 });
    source.start((_crop, _sig, t) => delivered.push(t), () => undefined);
  });

  afterEach(() => source.stop());

  it('counts accepted frames and not rejected ones', () => {
    frame(12);
    frame(13);
    frame(14);
    frame(55); // beyond the buffered range
    frame(3); // far behind the playhead
    expect(source.framesAccepted).toBe(3);
  });

  it('accepts frames inside the buffered range ahead of the playhead', () => {
    frame(12);
    frame(30.5);
    expect(delivered).toEqual([12, 30.5]);
  });

  it('drops frames beyond what the player has buffered or far behind the playhead', () => {
    const late = frame(55); // buffered only to 40
    const old = frame(3); // playhead at 10
    expect(delivered).toEqual([]);
    expect(late.closed && old.closed).toBe(true);
  });

  it('accepts at most one frame per 1/8 s slot of video', () => {
    frame(12.0);
    const dup = frame(12.05); // same slot
    frame(12.13);
    expect(delivered).toEqual([12.0, 12.13]);
    expect(dup.closed).toBe(true);
  });

  it('rate-limits resets so slots cannot be re-opened repeatedly', () => {
    frame(12);
    const reset = () => window.dispatchEvent(new MessageEvent('message', { data: { astTapReset: true, t: 12 }, source: window }));
    reset();
    frame(12); // accepted again after the first reset
    reset(); // too soon: ignored
    const again = frame(12);
    expect(delivered).toEqual([12, 12]);
    expect(again.closed).toBe(true);
  });
});
