/** STM32 USART bootloader (AN3155), any series, fixed 115200 baud.
 *  USART2 on STM32G0 and most other parts is PA2 (TX) / PA3 (RX), 8E1.
 *  Callers try 8N1 first, then even parity, and accept whatever chip id answers.
 */

export const ACK = 0x79;
export const NACK = 0x1f;
export const SYNC = 0x7f;

export const CMD_GET = 0x00;
export const CMD_GET_ID = 0x02;
export const CMD_READ = 0x11;
export const CMD_GO = 0x21;
export const CMD_WRITE = 0x31;
export const CMD_ERASE = 0x43;
export const CMD_EXT_ERASE = 0x44;

export const DEFAULT_BASE = 0x08000000;
export const WRITE_ALIGN = 8;
export const CHUNK = 256;

const CHIP_NAMES: Record<number, string> = {
  0x410: "STM32F1 medium-density",
  0x412: "STM32F1 low-density",
  0x414: "STM32F1 high-density",
  0x418: "STM32F1 connectivity",
  0x420: "STM32F100",
  0x430: "STM32F1 XL-density",
  0x440: "STM32F05x",
  0x444: "STM32F03x",
  0x448: "STM32F07x",
  0x413: "STM32F40x/41x",
  0x419: "STM32F42x/43x",
  0x423: "STM32F401",
  0x431: "STM32F411",
  0x433: "STM32F401",
  0x441: "STM32F412",
  0x421: "STM32F446",
  0x415: "STM32L47x/L48x",
  0x435: "STM32L43x/L44x",
  0x461: "STM32L496/4A6",
  0x462: "STM32L45x/L46x",
  0x470: "STM32L4R/L4S",
  0x456: "STM32G05x/G06x",
  0x460: "STM32G07x/G08x",
  0x466: "STM32G03x/G04x",
  0x467: "STM32G0B1/G0C1",
  0x468: "STM32G431/G441",
  0x469: "STM32G47x/G48x",
  0x495: "STM32WB5x",
  0x497: "STM32WL5x/WLE5",
};

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class SyncError extends ProtocolError {
  constructor(detail: string) {
    super(`No bootloader at 115200 (${detail}). Reset with BOOT0 held high. On STM32G0 the pin is ignored while nBOOT_SEL is 1.`);
    this.name = "SyncError";
  }
}

export class NackError extends ProtocolError {
  constructor(step: string) {
    super(`Device NACKed during ${step}. Readout protection or a bad address will do this.`);
    this.name = "NackError";
  }
}

export interface BytePort {
  write(data: Uint8Array): Promise<void>;
  /** Read exactly `n` bytes, or throw Error("timeout"). */
  read(n: number, timeoutMs: number): Promise<Uint8Array>;
}

export type UploadPhase = "sync" | "erase" | "write" | "verify" | "run";

export interface UploadOptions {
  image: Uint8Array;
  baseAddress?: number;
  verify?: boolean;
  startAfter?: boolean;
  log?: (line: string) => void;
  onProgress?: (phase: UploadPhase, done: number, total: number) => void;
}

export interface UploadResult {
  chipId: number;
  chipName: string;
  version: number;
  bytesWritten: number;
  started: boolean;
}

export function xorBytes(data: Uint8Array): number {
  let x = 0;
  for (const b of data) x ^= b;
  return x & 0xff;
}

export function encodeAddress(addr: number): Uint8Array {
  const bytes = new Uint8Array([
    (addr >>> 24) & 0xff,
    (addr >>> 16) & 0xff,
    (addr >>> 8) & 0xff,
    addr & 0xff,
  ]);
  const out = new Uint8Array(5);
  out.set(bytes);
  out[4] = xorBytes(bytes);
  return out;
}

/** Pad with 0xFF to the 8-byte flash line the ROM writer requires on G0, G4, L4, WL, and similar. */
export function padImage(image: Uint8Array): Uint8Array {
  const n = Math.ceil(image.length / WRITE_ALIGN) * WRITE_ALIGN;
  if (n === image.length) return image;
  const out = new Uint8Array(n);
  out.fill(0xff);
  out.set(image);
  return out;
}

export function chipName(id: number): string {
  return CHIP_NAMES[id] ?? `STM32 0x${id.toString(16).padStart(3, "0")}`;
}

async function readAck(port: BytePort, timeoutMs: number, step: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < 4; i++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProtocolError(`Timeout waiting for ACK (${step})`);
    const [b] = await port.read(1, left);
    if (b === ACK) return;
    if (b === NACK) throw new NackError(step);
  }
  throw new ProtocolError(`No ACK during ${step}`);
}

async function command(port: BytePort, code: number, step: string, timeoutMs = 1000): Promise<void> {
  await port.write(new Uint8Array([code, code ^ 0xff]));
  await readAck(port, timeoutMs, step);
}

/** Drop whatever is already queued. Quiet period ends the drain. */
export async function drain(port: BytePort, quietMs = 40): Promise<void> {
  for (;;) {
    try {
      await port.read(1, quietMs);
    } catch {
      return;
    }
  }
}

export async function syncBootloader(port: BytePort): Promise<void> {
  await drain(port, 30);
  let detail = "no reply";
  for (let attempt = 1; attempt <= 4; attempt++) {
    await port.write(new Uint8Array([SYNC]));
    try {
      await readAck(port, 350, "sync");
      return;
    } catch (err) {
      detail = err instanceof NackError ? "NACK" : "timeout";
    }
  }
  throw new SyncError(detail);
}

async function cmdGet(port: BytePort): Promise<{ version: number; commands: number[] }> {
  await command(port, CMD_GET, "GET");
  const [n] = await port.read(1, 1000);
  const [version] = await port.read(1, 1000);
  const commands = Array.from(await port.read(n, 1000));
  await readAck(port, 1000, "GET end");
  return { version, commands };
}

async function cmdGetId(port: BytePort): Promise<number> {
  await command(port, CMD_GET_ID, "GET_ID");
  const [n] = await port.read(1, 1000);
  const raw = await port.read(n + 1, 1000);
  await readAck(port, 1000, "GET_ID end");
  let id = 0;
  for (const b of raw) id = (id << 8) | b;
  return id;
}

async function massErase(port: BytePort, commands: number[]): Promise<void> {
  if (commands.includes(CMD_EXT_ERASE)) {
    await command(port, CMD_EXT_ERASE, "extended erase");
    // 0xFFFF = mass erase. Checksum is 0xFF ^ 0xFF.
    await port.write(new Uint8Array([0xff, 0xff, 0x00]));
    await readAck(port, 60_000, "mass erase");
    return;
  }
  if (commands.includes(CMD_ERASE)) {
    await command(port, CMD_ERASE, "erase");
    await port.write(new Uint8Array([0xff, 0x00]));
    await readAck(port, 60_000, "mass erase");
    return;
  }
  throw new ProtocolError("Bootloader has neither erase command (0x43 / 0x44).");
}

async function writeChunk(port: BytePort, addr: number, chunk: Uint8Array): Promise<void> {
  if (chunk.length < 1 || chunk.length > CHUNK) {
    throw new ProtocolError(`Chunk length ${chunk.length} is outside 1..256`);
  }
  await command(port, CMD_WRITE, "write");
  await port.write(encodeAddress(addr));
  await readAck(port, 1000, "write address");
  const n = chunk.length - 1;
  const frame = new Uint8Array(1 + chunk.length + 1);
  frame[0] = n;
  frame.set(chunk, 1);
  let cs = n;
  for (const b of chunk) cs ^= b;
  frame[frame.length - 1] = cs & 0xff;
  await port.write(frame);
  await readAck(port, 2000, "write data");
}

async function readChunk(port: BytePort, addr: number, length: number): Promise<Uint8Array> {
  await command(port, CMD_READ, "read");
  await port.write(encodeAddress(addr));
  await readAck(port, 1000, "read address");
  const n = length - 1;
  await port.write(new Uint8Array([n, n ^ 0xff]));
  return port.read(length, 2000);
}

async function go(port: BytePort, addr: number): Promise<void> {
  await command(port, CMD_GO, "go");
  await port.write(encodeAddress(addr));
  await readAck(port, 1000, "go address");
}

export async function uploadImage(port: BytePort, opts: UploadOptions): Promise<UploadResult> {
  const log = opts.log ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const base = opts.baseAddress ?? DEFAULT_BASE;
  if (!Number.isInteger(base) || base < 0 || base % WRITE_ALIGN !== 0) {
    throw new ProtocolError("Base address must be 8-byte aligned.");
  }
  if (opts.image.length === 0) throw new ProtocolError("Image is empty.");
  if (opts.image.length > 2 * 1024 * 1024) {
    throw new ProtocolError("Image is over 2 MB. Refusing to write.");
  }

  const image = padImage(opts.image);
  progress("sync", 0, image.length);
  log("Sync 0x7F at 115200");
  await syncBootloader(port);
  log("Bootloader answered");

  const { version, commands } = await cmdGet(port);
  log(`Bootloader version ${version.toString(16).padStart(2, "0")}, commands ${commands.map((c) => c.toString(16).padStart(2, "0")).join(" ")}`);

  const chipId = await cmdGetId(port);
  log(`Chip ${chipName(chipId)} (0x${chipId.toString(16)})`);

  progress("erase", 0, image.length);
  log("Mass erase");
  await massErase(port, commands);
  log("Erase done");

  for (let off = 0; off < image.length; off += CHUNK) {
    const chunk = image.subarray(off, Math.min(off + CHUNK, image.length));
    await writeChunk(port, base + off, chunk);
    progress("write", off + chunk.length, image.length);
  }
  log(`Wrote ${image.length} bytes at 0x${base.toString(16)}`);

  if (opts.verify) {
    for (let off = 0; off < image.length; off += CHUNK) {
      const chunk = image.subarray(off, Math.min(off + CHUNK, image.length));
      const got = await readChunk(port, base + off, chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        if (got[i] !== chunk[i]) {
          throw new ProtocolError(
            `Verify failed at 0x${(base + off + i).toString(16)}: wrote 0x${chunk[i].toString(16)}, read 0x${got[i].toString(16)}`,
          );
        }
      }
      progress("verify", off + chunk.length, image.length);
    }
    log("Verify matched");
  }

  let started = false;
  if (opts.startAfter !== false) {
    if (!commands.includes(CMD_GO)) {
      log("Bootloader has no Go command; image is written but the core was not started");
    } else {
      progress("run", image.length, image.length);
      log(`Go 0x${base.toString(16)} — starting the application`);
      await go(port, base);
      started = true;
      log("Device left the bootloader and is running the new image");
    }
  }

  return { chipId, chipName: chipName(chipId), version, bytesWritten: image.length, started };
}

/** Intel HEX → contiguous image. Gaps inside the span become 0xFF. */
export function parseIntelHex(text: string): { base: number; image: Uint8Array } {
  let upper = 0;
  const bytes = new Map<number, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = -1;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(":")) throw new ProtocolError(`Bad HEX line: ${line.slice(0, 20)}`);
    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2 !== 0) throw new ProtocolError("Truncated HEX record");
    const rec = new Uint8Array(hex.length / 2);
    for (let i = 0; i < rec.length; i++) rec[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const count = rec[0];
    const addr = (rec[1] << 8) | rec[2];
    const type = rec[3];
    if (rec.length !== count + 5) throw new ProtocolError("HEX length mismatch");
    if (xorBytes(rec) !== 0) throw new ProtocolError("HEX checksum mismatch");
    if (type === 0x00) {
      for (let i = 0; i < count; i++) {
        const a = (upper + addr + i) >>> 0;
        bytes.set(a, rec[4 + i]);
        if (a < min) min = a;
        if (a > max) max = a;
      }
    } else if (type === 0x01) {
      break;
    } else if (type === 0x04) {
      upper = ((rec[4] << 8) | rec[5]) << 16;
    } else if (type === 0x02) {
      upper = ((rec[4] << 8) | rec[5]) << 4;
    }
  }
  if (max < 0) throw new ProtocolError("HEX file has no data");
  const image = new Uint8Array(max - min + 1);
  image.fill(0xff);
  for (const [a, b] of bytes) image[a - min] = b;
  return { base: min, image };
}
