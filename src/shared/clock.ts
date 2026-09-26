import type { Clock, SimClock } from "./types.ts";

/**
 * Wall-clock time. Rules must take an injected Clock — never call Date.now()
 * directly inside the brain so the simulator can control time.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Controllable clock for GPS/route simulator tests. */
export class SimClockImpl implements SimClock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(t: Date): void {
    this.current = new Date(t.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export { SimClockImpl as SimClock };
