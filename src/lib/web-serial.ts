import type { BytePort } from "@/lib/usart-protocol";

interface Wake {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Web Serial byte port. One read() is in flight inside the pump, so timeouts cannot strand the reader. */
export class WebSerialPort implements BytePort {
  private extra: number[] = [];
  private waiters: Wake[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;

  constructor(private port: SerialPort) {
    if (!port.readable || !port.writable) throw new Error("Serial port has no data channels");
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          for (const byte of value) this.extra.push(byte);
          this.kick();
        }
      }
    } catch {
      /* port closed under us */
    }
    this.closed = true;
    this.kick();
  }

  private kick(): void {
    const pending = this.waiters.splice(0);
    for (const waiter of pending) waiter.resolve();
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer.write(data);
  }

  async read(n: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = await this.readOne(deadline);
    return out;
  }

  private async readOne(deadline: number): Promise<number> {
    while (this.extra.length === 0) {
      if (this.closed) throw new Error("port closed");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timeout");
      await new Promise<void>((resolve, reject) => {
        const waiter: Wake = { resolve: () => undefined, reject };
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("timeout"));
        }, left);
        waiter.resolve = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(waiter);
        if (this.extra.length || this.closed) waiter.resolve();
      });
    }
    return this.extra.shift() as number;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.kick();
    try {
      await this.reader.cancel();
    } catch {
      /* already cancelled */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* released */
    }
    try {
      await this.writer.close();
    } catch {
      /* closed */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* released */
    }
    try {
      await this.port.close();
    } catch {
      /* already closed */
    }
  }
}

export async function openBootloader(
  port: SerialPort,
  parity: "none" | "even",
): Promise<WebSerialPort> {
  await port.open({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity,
    flowControl: "none",
    bufferSize: 4096,
  });
  return new WebSerialPort(port);
}
