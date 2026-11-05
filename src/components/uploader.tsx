import { useEffect, useRef, useState } from "react";
import { Cable, Check, Download, Play, SquareTerminal, TriangleAlert, Upload } from "lucide-react";
import { createPipe } from "@/lib/byte-pipe";
import { createMockState, runMockBootloader } from "@/lib/mock-bootloader";
import {
  ProtocolError,
  SyncError,
  parseIntelHex,
  uploadImage,
  type UploadPhase,
} from "@/lib/usart-protocol";
import { openBootloader } from "@/lib/web-serial";

type Phase = "idle" | UploadPhase | "done" | "error";

interface LogLine {
  id: number;
  text: string;
  tone: "info" | "ok" | "bad";
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "Idle",
  sync: "Sync",
  erase: "Erase",
  write: "Write",
  verify: "Verify",
  run: "Run",
  done: "Running",
  error: "Stopped",
};

export function Uploader() {
  const [serialOk, setSerialOk] = useState(false);
  const [fileName, setFileName] = useState("");
  const [image, setImage] = useState<Uint8Array | null>(null);
  const [baseText, setBaseText] = useState("08000000");
  const [verify, setVerify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [lines, setLines] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    setSerialOk(typeof navigator !== "undefined" && "serial" in navigator);
  }, []);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  function push(text: string, tone: LogLine["tone"] = "info") {
    seq.current += 1;
    const id = seq.current;
    setLines((prev) => [...prev.slice(-200), { id, text, tone }]);
  }

  function onProgress(next: UploadPhase, wrote: number, size: number) {
    setPhase(next);
    setDone(wrote);
    setTotal(size);
  }

  async function loadFile(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".hex")) {
      const text = new TextDecoder().decode(buf);
      const parsed = parseIntelHex(text);
      setImage(parsed.image);
      setBaseText(parsed.base.toString(16));
      setFileName(file.name);
      push(`${file.name}: ${parsed.image.length} bytes at 0x${parsed.base.toString(16)}`, "ok");
      return;
    }
    setImage(buf);
    setFileName(file.name);
    push(`${file.name}: ${buf.length} bytes`, "ok");
  }

  function baseAddress(): number {
    const n = Number.parseInt(baseText.replace(/^0x/i, ""), 16);
    if (!Number.isInteger(n)) throw new ProtocolError("Base address is not hex.");
    return n;
  }

  async function runUpload(port: Parameters<typeof uploadImage>[0], label: string, payload: Uint8Array) {
    setLines([]);
    setPhase("sync");
    setDone(0);
    setTotal(0);
    push(label);
    const result = await uploadImage(port, {
      image: payload,
      baseAddress: baseAddress(),
      verify,
      startAfter: true,
      log: (line) => push(line),
      onProgress,
    });
    setPhase("done");
    push(
      result.started
        ? `${result.chipName} is running the new image`
        : `${result.chipName} programmed, but Go was not available`,
      "ok",
    );
  }

  async function dryRun() {
    if (busy) return;
    const payload = image ?? demoImage();
    if (!image) {
      setFileName("demo-pattern.bin");
      setImage(payload);
    }
    setBusy(true);
    try {
      const { host, device } = createPipe();
      const state = createMockState(Math.max(64 * 1024, payload.length + 16));
      const mock = runMockBootloader(device, state);
      await runUpload(host, "Dry run against a simulated STM32G0 USART bootloader", payload);
      await mock;
    } catch (err) {
      setPhase("error");
      push(err instanceof Error ? err.message : "Dry run failed", "bad");
    } finally {
      setBusy(false);
    }
  }

  async function uploadLive() {
    if (busy || !image) return;
    if (!serialOk || !navigator.serial) {
      push("This browser has no serial port. Use the Python CLI on the machine that has the UART.", "bad");
      return;
    }
    setBusy(true);
    let port: SerialPort | null = null;
    try {
      baseAddress();
      port = await navigator.serial.requestPort();
      const order: Array<"none" | "even"> = ["none", "even"];
      let last: unknown;
      for (const parity of order) {
        const link = await openBootloader(port, parity);
        const framing = parity === "none" ? "8N1" : "8E1";
        try {
          await runUpload(link, `USART2 at 115200 ${framing}`, image);
          return;
        } catch (err) {
          last = err;
          if (!(err instanceof SyncError)) throw err;
          push(`No answer on ${framing}, trying the other framing`);
        } finally {
          await link.close();
        }
      }
      throw last instanceof Error ? last : new SyncError("no reply");
    } catch (err) {
      setPhase("error");
      push(err instanceof Error ? err.message : "Upload failed", "bad");
    } finally {
      setBusy(false);
      if (port?.readable) {
        try {
          await port.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 overflow-x-hidden px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-widest text-signal uppercase">STM32 · USART2 · 115200</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg">Upload, then run</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            Writes a .bin or .hex through the system bootloader on any STM32, including STM32G0, over USART2 at
            115200. Then it sends Go so the chip runs the image.
          </p>
        </div>
        <Status phase={phase} />
      </header>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5">
          <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-bg px-4 py-5 text-center">
            <Upload className="size-5 text-signal" aria-hidden />
            <span className="text-sm font-medium text-fg">{fileName || "Choose firmware"}</span>
            <span className="text-xs text-muted">{image ? `${image.length} bytes` : ".bin or Intel HEX"}</span>
            <input
              className="sr-only"
              type="file"
              accept=".bin,.hex,application/octet-stream"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadFile(file).catch((err: unknown) => push(err instanceof Error ? err.message : "Bad file", "bad"));
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted">Flash base</span>
            <span className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3">
              <span className="font-mono text-sm text-muted">0x</span>
              <input
                className="h-11 w-full bg-transparent font-mono text-sm text-fg outline-none"
                value={baseText}
                spellCheck={false}
                onChange={(event) => setBaseText(event.target.value.trim())}
                aria-label="Flash base address"
              />
            </span>
          </label>

          <label className="flex items-center gap-3 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4 accent-signal"
              checked={verify}
              onChange={(event) => setVerify(event.target.checked)}
            />
            Read back and compare before starting the core
          </label>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              disabled={busy || !image}
              onClick={() => void uploadLive()}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-signal px-4 text-sm font-semibold text-signal-ink disabled:opacity-40"
            >
              <Play className="size-4" aria-hidden />
              Upload and reset
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void dryRun()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-bg px-4 text-sm font-medium text-fg disabled:opacity-40"
            >
              <SquareTerminal className="size-4" aria-hidden />
              Dry run
            </button>
          </div>

          <div>
            <div className="mb-1 flex justify-between font-mono text-xs text-muted">
              <span>{PHASE_LABEL[phase]}</span>
              <span>{total ? `${pct}%` : "—"}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full bg-signal transition-[width] duration-200" style={{ width: `${pct}%` }} />
            </div>
          </div>

          {!serialOk && (
            <p className="flex gap-2 text-xs leading-relaxed text-muted">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-fault" aria-hidden />
              This view cannot open a UART. Dry run still exercises the protocol. The CLI on your computer does the real port.
            </p>
          )}
        </section>

        <section className="flex min-h-80 min-w-0 flex-col rounded-lg border border-line bg-bg">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Cable className="size-4 text-signal" aria-hidden />
            <h2 className="text-sm font-medium text-fg">Link log</h2>
          </div>
          <div ref={logRef} className="min-w-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed break-words" aria-live="polite">
            {lines.length === 0 ? (
              <p className="text-muted">Waiting. Sync is a single 0x7F. The loader answers 0x79, then erase, write, Go.</p>
            ) : (
              lines.map((line) => (
                <p key={line.id} className={line.tone === "bad" ? "text-fault" : line.tone === "ok" ? "text-signal" : "text-fg"}>
                  {line.text}
                </p>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="grid min-w-0 gap-4 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold text-fg">USART2 on STM32G0 and the rest</h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs text-muted">
            <dt className="text-fg">PA2 TX</dt>
            <dd>adapter RX</dd>
            <dt className="text-fg">PA3 RX</dt>
            <dd>adapter TX</dd>
            <dt className="text-fg">GND</dt>
            <dd>adapter GND</dd>
            <dt className="text-fg">115200</dt>
            <dd>8N1 first, then ROM 8E1</dd>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Same AN3155 loader on G0, G4, F4, L4, WL, and the other series. Hold BOOT0 and reset. On STM32G0 the
            pin does nothing while nBOOT_SEL is 1 — clear that bit once over SWD, or set nBOOT0 to 0. An unknown
            chip id is still programmed. Go then starts the image at the flash base.
          </p>
        </div>
        <div className="flex flex-col justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">Same tool as a CLI</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              No packages. On Linux or macOS it uses the system serial driver. It tries normal 8N1 at 115200, then even
              parity, writes the image, and sends Go.
            </p>
            <pre className="mt-3 max-w-full overflow-x-auto rounded-lg bg-bg p-3 font-mono text-xs break-all whitespace-pre-wrap text-fg">
              python3 usart2-upload.py -p /dev/ttyUSB0 firmware.bin
            </pre>
          </div>
          <a
            href="/usart2-upload.py"
            download="usart2-upload.py"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-line bg-bg px-4 text-sm font-medium text-fg"
          >
            <Download className="size-4" aria-hidden />
            Download usart2-upload.py
          </a>
        </div>
      </section>
    </div>
  );
}

function Status({ phase }: { phase: Phase }) {
  const live = phase === "done";
  const bad = phase === "error";
  return (
    <div className="inline-flex h-11 items-center gap-2 self-start rounded-lg border border-line bg-surface px-3 font-mono text-xs text-muted">
      {live ? <Check className="size-4 text-signal" aria-hidden /> : <span className={`inline-block size-2 rounded-full ${bad ? "bg-fault" : "bg-signal"}`} />}
      {PHASE_LABEL[phase]}
    </div>
  );
}

function demoImage(): Uint8Array {
  const image = new Uint8Array(512);
  image.fill(0xff);
  // Cortex-M vector stub: stack, reset, then a recognizable ramp.
  image[0] = 0x00;
  image[1] = 0x10;
  image[2] = 0x00;
  image[3] = 0x20;
  image[4] = 0x21;
  image[5] = 0x00;
  image[6] = 0x00;
  image[7] = 0x08;
  for (let i = 8; i < image.length; i++) image[i] = i & 0xff;
  return image;
}
