/** Coalesces pending snapshots; the active write always completes before the next. */
export class SaveQueue<T> {
  private latest?: T;
  private revision = 0;
  private saved = 0;
  private running?: Promise<void>;
  private write: (value: T) => Promise<void>;
  constructor(write: (value: T) => Promise<void>) {
    this.write = write;
  }
  get dirty(): boolean {
    return this.revision !== this.saved;
  }
  update(value: T): void {
    this.latest = value;
    this.revision++;
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async drain(): Promise<void> {
    while (this.dirty) {
      const revision = this.revision;
      await this.write(this.latest!);
      this.saved = revision;
    }
  }
}
