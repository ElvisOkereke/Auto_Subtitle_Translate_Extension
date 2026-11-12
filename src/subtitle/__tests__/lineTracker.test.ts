import { LineTracker } from '../lineTracker';

// Signatures are compared by mean absolute difference; constant arrays make
// "same image" (distance 0) and "different image" (distance ~0.4) explicit.
const A = new Uint8Array(1024).fill(20);
const B = new Uint8Array(1024).fill(120);
const noise = new Uint8Array(1024).fill(200);

function run(frames: Uint8Array[]) {
  const tracker = new LineTracker();
  return frames.map((sig, i) => tracker.push(sig, i)).map((e, i) => (e ? i : null)).filter(i => i !== null);
}

describe('LineTracker', () => {
  it('emits once per distinct image after it is stable for 2 frames', () => {
    expect(run([A, A, B, B, B, A, A])).toEqual([1, 3, 6]);
  });

  it('emits nothing while frames stay identical (paused video)', () => {
    expect(run([A, A, A, A, A, A])).toEqual([1]);
  });

  it('ignores a single noisy frame', () => {
    expect(run([A, A, noise, A, A])).toEqual([1]);
  });

  it('reports the video time of the frame that confirmed the change', () => {
    const tracker = new LineTracker();
    tracker.push(A, 10.0);
    expect(tracker.push(A, 10.1)).toEqual({ type: 'changed', at: 10.1 });
  });

  it('re-emits the current image after reset (e.g. after a seek)', () => {
    const tracker = new LineTracker();
    tracker.push(A, 0);
    tracker.push(A, 1);
    tracker.reset();
    expect(tracker.push(A, 2)).toBeNull();
    expect(tracker.push(A, 3)).toEqual({ type: 'changed', at: 3 });
  });
});
