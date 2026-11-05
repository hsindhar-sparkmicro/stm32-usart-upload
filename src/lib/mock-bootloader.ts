import { ACK, NACK, SYNC } from "./usart-protocol.ts";
import type { BytePort } from "./usart-protocol.ts";

export interface MockState {
  mem: Uint8Array;
  base: number;
  goAddress: number | null;
  version: number;
  chipId: number;
}

const COMMANDS = [0x00, 0x01, 0x02, 0x11, 0x21, 0x31, 0x44];

export function createMockState(size = 64 * 1024): MockState {
  return {
    mem: new Uint8Array(size).fill(0xff),
    base: 0x08000000,
    goAddress: null,
    version: 0x31,
    chipId: 0x460,
  };
}

/** Speaks just enough AN3155 for a host upload to succeed. Resolves on Go. */
export async function runMockBootloader(port: BytePort, state: MockState): Promise<void> {
  for (;;) {
    const [first] = await port.read(1, 5000);
    if (first === SYNC) {
      await port.write(new Uint8Array([ACK]));
      continue;
    }
    const [comp] = await port.read(1, 1000);
    if ((first ^ 0xff) !== comp) {
      await port.write(new Uint8Array([NACK]));
      continue;
    }
    if (first === 0x00) {
      const body = new Uint8Array(2 + COMMANDS.length);
      body[0] = COMMANDS.length;
      body[1] = state.version;
      body.set(COMMANDS, 2);
      await port.write(new Uint8Array([ACK]));
      await port.write(body);
      await port.write(new Uint8Array([ACK]));
      continue;
    }
    if (first === 0x02) {
      await port.write(new Uint8Array([ACK, 0x01, (state.chipId >> 8) & 0xff, state.chipId & 0xff, ACK]));
      continue;
    }
    if (first === 0x44 || first === 0x43) {
      await port.write(new Uint8Array([ACK]));
      if (first === 0x44) await port.read(3, 1000);
      else await port.read(2, 1000);
      state.mem.fill(0xff);
      await port.write(new Uint8Array([ACK]));
      continue;
    }
    if (first === 0x31) {
      await port.write(new Uint8Array([ACK]));
      const addrFrame = await port.read(5, 1000);
      let x = 0;
      for (let i = 0; i < 4; i++) x ^= addrFrame[i];
      if (x !== addrFrame[4]) {
        await port.write(new Uint8Array([NACK]));
        continue;
      }
      const addr = (addrFrame[0] << 24) | (addrFrame[1] << 16) | (addrFrame[2] << 8) | addrFrame[3];
      await port.write(new Uint8Array([ACK]));
      const [n] = await port.read(1, 1000);
      const data = await port.read(n + 1, 1000);
      const [cs] = await port.read(1, 1000);
      let expect = n;
      for (const b of data) expect ^= b;
      if ((expect & 0xff) !== cs) {
        await port.write(new Uint8Array([NACK]));
        continue;
      }
      const off = addr - state.base;
      if (off < 0 || off + data.length > state.mem.length) {
        await port.write(new Uint8Array([NACK]));
        continue;
      }
      state.mem.set(data, off);
      await port.write(new Uint8Array([ACK]));
      continue;
    }
    if (first === 0x11) {
      await port.write(new Uint8Array([ACK]));
      const addrFrame = await port.read(5, 1000);
      const addr = (addrFrame[0] << 24) | (addrFrame[1] << 16) | (addrFrame[2] << 8) | addrFrame[3];
      await port.write(new Uint8Array([ACK]));
      const lenFrame = await port.read(2, 1000);
      const length = lenFrame[0] + 1;
      const off = addr - state.base;
      await port.write(state.mem.subarray(off, off + length));
      continue;
    }
    if (first === 0x21) {
      await port.write(new Uint8Array([ACK]));
      const addrFrame = await port.read(5, 1000);
      const addr = (addrFrame[0] << 24) | (addrFrame[1] << 16) | (addrFrame[2] << 8) | addrFrame[3];
      state.goAddress = addr >>> 0;
      await port.write(new Uint8Array([ACK]));
      return;
    }
    await port.write(new Uint8Array([NACK]));
  }
}
