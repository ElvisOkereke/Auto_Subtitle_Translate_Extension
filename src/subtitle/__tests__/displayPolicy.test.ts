import { LineDisplay, minDisplaySeconds } from '../displayPolicy';

describe('minimum reading time', () => {
  it('is 1.5 s for short text, 15 characters per second beyond that, at most 6 s', () => {
    expect(minDisplaySeconds('Hi')).toBe(1.5);
    expect(minDisplaySeconds('x'.repeat(45))).toBe(3);
    expect(minDisplaySeconds('x'.repeat(200))).toBe(6);
  });
});

describe('LineDisplay (video time)', () => {
  it('a line whose source lasted 0.4 s stays 1.5 s', () => {
    const d = new LineDisplay();
    d.show('Hi', 10);
    d.sourceEnded(10.4);
    expect(d.tick(11.4)).toBe('keep');
    expect(d.tick(11.5)).toBe('clear');
  });

  it('a long source keeps the line until it ends', () => {
    const d = new LineDisplay();
    d.show('Hi', 10);
    expect(d.tick(14)).toBe('keep');
    d.sourceEnded(15);
    expect(d.tick(15)).toBe('clear');
  });

  it('a newer line replaces at once and restarts the timing', () => {
    const d = new LineDisplay();
    d.show('A', 10);
    d.sourceEnded(10.2);
    d.replace('B', 10.3);
    expect(d.text).toBe('B');
    expect(d.tick(11.5)).toBe('keep'); // B's source hasn't ended
    d.sourceEnded(10.5);
    expect(d.tick(11.7)).toBe('keep');
    expect(d.tick(11.8)).toBe('clear'); // 10.3 + 1.5
  });

  it('very long text is capped at 6 s', () => {
    const d = new LineDisplay();
    d.show('x'.repeat(200), 0);
    d.sourceEnded(0.5);
    expect(d.tick(5.9)).toBe('keep');
    expect(d.tick(6)).toBe('clear');
  });

  it('nothing shown: tick says clear; reset forgets the line', () => {
    const d = new LineDisplay();
    expect(d.tick(1)).toBe('clear');
    d.show('Hi', 10);
    d.reset();
    expect(d.text).toBeNull();
    expect(d.tick(10.1)).toBe('clear');
  });
});
