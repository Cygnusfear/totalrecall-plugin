/**
 * Simple counting semaphore for controlling concurrency
 */

export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxPermits: number = 5) {
    if (maxPermits <= 0) {
      throw new Error('maxPermits must be greater than 0');
    }
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  /**
   * Acquire a permit. Waits if none available.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    // Wait for a permit to become available
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  /**
   * Release a permit, allowing waiting tasks to proceed.
   */
  release(): void {
    if (this.permits >= this.maxPermits) {
      throw new Error('Cannot release more permits than max');
    }

    this.permits++;

    // Wake up next waiting task
    const resolve = this.queue.shift();
    if (resolve) {
      this.permits--;
      resolve();
    }
  }

  /**
   * Execute a function with automatic acquire/release
   */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get current status
   */
  getStatus(): { available: number; waiting: number; max: number } {
    return {
      available: this.permits,
      waiting: this.queue.length,
      max: this.maxPermits,
    };
  }
}
