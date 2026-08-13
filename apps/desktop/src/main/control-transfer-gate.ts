export class ControlTransferGate {
  private pending: Promise<unknown> | undefined;

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending as Promise<T>;
    const pending = operation();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }
}
