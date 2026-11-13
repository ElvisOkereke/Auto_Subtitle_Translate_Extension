// How long a translated subtitle stays on screen (spec 2026-11-13): at least its
// reading time, even when the source subtitle flashed by; a newer line always
// replaces it at once. All times are video seconds, so pausing freezes the line
// and nothing advances while the video doesn't.

/** max(1.5 s, characters / 15 per s) of the translated text, capped at 6 s. */
export function minDisplaySeconds(text: string): number {
  return Math.min(6, Math.max(1.5, [...text].length / 15));
}

export class LineDisplay {
  private current: { text: string; shownAt: number; sourceEnd: number | null } | null = null;

  get text(): string | null {
    return this.current?.text ?? null;
  }

  /** A line appears (its source subtitle appeared at `at`, or its translation arrived then). */
  show(text: string, at: number): void {
    this.current = { text, shownAt: at, sourceEnd: null };
  }

  /** A newer line takes the screen immediately; its timing starts now. */
  replace(text: string, at: number): void {
    this.show(text, at);
  }

  /** The source subtitle disappeared at `at`. */
  sourceEnded(at: number): void {
    if (this.current && this.current.sourceEnd === null) this.current.sourceEnd = at;
  }

  /** Whether the line should still be on screen at video time `at`. */
  tick(at: number): 'keep' | 'clear' {
    const c = this.current;
    if (!c) return 'clear';
    if (c.sourceEnd === null) return 'keep';
    const until = Math.max(c.sourceEnd, c.shownAt + minDisplaySeconds(c.text));
    // Rounded to the millisecond so video times like 10 + 1.5 compare exactly.
    return Math.round(at * 1000) >= Math.round(until * 1000) ? 'clear' : 'keep';
  }

  reset(): void {
    this.current = null;
  }
}
