import assert from "node:assert/strict";
import test from "node:test";
import { createPipe } from "./byte-pipe.ts";
import { createMockState, runMockBootloader } from "./mock-bootloader.ts";
import {
  encodeAddress,
  padImage,
  parseIntelHex,
  uploadImage,
  xorBytes,
} from "./usart-protocol.ts";

test("address checksum is the xor of the four big-endian bytes", () => {
  const frame = encodeAddress(0x08000000);
  assert.deepEqual(Array.from(frame), [0x08, 0x00, 0x00, 0x00, 0x08]);
  assert.equal(xorBytes(frame.subarray(0, 4)), frame[4]);
});

test("padImage rounds up to 8 bytes with 0xFF", () => {
  const padded = padImage(new Uint8Array([1, 2, 3]));
  assert.equal(padded.length, 8);
  assert.deepEqual(Array.from(padded), [1, 2, 3, 0xff, 0xff, 0xff, 0xff, 0xff]);
});

test("upload writes the image, verifies, and Go starts the core", async () => {
  const { host, device } = createPipe();
  const state = createMockState();
  const image = new Uint8Array(300);
  for (let i = 0; i < image.length; i++) image[i] = i & 0xff;
  const mock = runMockBootloader(device, state);
  const result = await uploadImage(host, {
    image,
    verify: true,
    startAfter: true,
  });
  await mock;
  assert.equal(result.chipId, 0x460);
  assert.equal(result.started, true);
  assert.equal(result.bytesWritten, 304);
  assert.equal(state.goAddress, 0x08000000);
  for (let i = 0; i < 300; i++) assert.equal(state.mem[i], i & 0xff);
  for (let i = 300; i < 304; i++) assert.equal(state.mem[i], 0xff);
});

test("intel hex spans the flash base and fills gaps", () => {
  const line = (record: number[]) => {
    const cs = record.reduce((a, b) => a ^ b, 0) & 0xff;
    const body = [...record, cs].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `:${body}`;
  };
  const text = [
    line([0x02, 0x00, 0x00, 0x04, 0x08, 0x00]),
    line([0x04, 0x00, 0x00, 0x00, 0x10, 0x20, 0x30, 0x40]),
    line([0x01, 0x00, 0x10, 0x00, 0xaa]),
    line([0x00, 0x00, 0x00, 0x01]),
  ].join("\n");
  const parsed = parseIntelHex(text);
  assert.equal(parsed.base, 0x08000000);
  assert.equal(parsed.image.length, 0x11);
  assert.equal(parsed.image[0], 0x10);
  assert.equal(parsed.image[3], 0x40);
  assert.equal(parsed.image[0x0f], 0xff);
  assert.equal(parsed.image[0x10], 0xaa);
});
