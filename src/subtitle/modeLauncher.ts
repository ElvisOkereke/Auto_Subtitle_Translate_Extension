// modeLauncher.ts - keeps at most one subtitle mode alive when starts and stops
// overlap (starting awaits model loading; the user, navigation or a second
// start can intervene meanwhile).

export class ModeLauncher<M extends { stop(): void }> {
  private generation = 0;
  current: M | null = null;

  /** Stops the running mode, then creates a new one; resolves null if a later start/stop superseded it. */
  async start(create: () => Promise<M>): Promise<M | null> {
    const generation = ++this.generation;
    this.current?.stop();
    this.current = null;
    const mode = await create();
    if (generation !== this.generation) {
      mode.stop();
      return null;
    }
    this.current = mode;
    return mode;
  }

  stop(): void {
    this.generation++;
    this.current?.stop();
    this.current = null;
  }
}
