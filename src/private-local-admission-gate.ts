/**
 * Admissions of work to one Agent share it as short leases; an archive takes the
 * Agent exclusively. So an archive sees every command admitted before it, and
 * work offered after it finds the Agent archived: nothing runs in between.
 */
export class AdmissionGate {
  #leases = 0;
  #exclusive = false;
  #waiters: (() => void)[] = [];

  #changed() {
    for (const wake of this.#waiters.splice(0)) wake();
  }

  #change(): Promise<void> {
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Nothing holds or waits for this gate, so it can be forgotten. */
  get idle(): boolean {
    return this.#leases === 0 && !this.#exclusive && this.#waiters.length === 0;
  }

  /** Hold a shared lease; the returned release may be called more than once. */
  async lease(): Promise<() => void> {
    while (this.#exclusive) await this.#change();
    this.#leases += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#leases -= 1;
      this.#changed();
    };
  }

  /** Run alone: after every held lease is released and before any new one. */
  async exclusive<Value>(run: () => Promise<Value>): Promise<Value> {
    while (this.#exclusive) await this.#change();
    this.#exclusive = true;
    try {
      while (this.#leases > 0) await this.#change();
      return await run();
    } finally {
      this.#exclusive = false;
      this.#changed();
    }
  }
}
