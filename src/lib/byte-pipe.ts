import type { BytePort } from "./usart-protocol.ts";

interface Waiter {
  resolve: (byte: number) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-memory duplex used by tests and the on-screen dry run. */
export function createPipe(): { host: BytePort; device: BytePort } {
  const aToB = new Queue();
  const bToA = new Queue();
  return {
    host: queuePort(aToB, bToA),
    device: queuePort(bToA, aToB),
  };
}

function queuePort(outgoing: Queue, incoming: Queue): BytePort {
  return {
    write: (data) => {
      outgoing.push(data);
      return Promise.resolve();
    },
    read: (n, timeoutMs) => incoming.read(n, timeoutMs),
  };
}

class Queue {
  private items: number[] = [];
  private waiters: Waiter[] = [];

  push(data: Uint8Array): void {
    for (const byte of data) {
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(byte);
      } else {
        this.items.push(byte);
      }
    }
  }

  read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    const out = new Uint8Array(n);
    const one = (left: number) =>
      new Promise<number>((resolve, reject) => {
        if (this.items.length) {
          resolve(this.items.shift() as number);
          return;
        }
        const timer = setTimeout(() => {
          const idx = this.waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error("timeout"));
        }, left);
        this.waiters.push({ resolve, reject, timer });
      });
    return (async () => {
      for (let i = 0; i < n; i++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timeout");
        out[i] = await one(left);
      }
      return out;
    })();
  }
}
