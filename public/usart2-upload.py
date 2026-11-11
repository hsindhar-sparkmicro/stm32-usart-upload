#!/usr/bin/env python3
"""USART firmware uploader for any STM32 with the ROM bootloader (AN3155).

Works for STM32G0 as well as F0, F1, F4, G4, L4, WB, WL, and the rest. The
link stays at 115200. Framing is tried as normal 8N1 first, then ROM 8E1.
Chip id is reported and never used as a gate. After the write, Go starts
the new image.

USART2 on STM32G0 (and on most other series): PA2 = TX to adapter RX,
PA3 = RX to adapter TX. On G0, BOOT0 is ignored while the nBOOT_SEL option
bit is 1.

    python3 usart2-upload.py -p /dev/ttyUSB0 firmware.bin
    python3 usart2-upload.py -p COM5 -a 0x08000000 app.hex
    python3 usart2-upload.py --self-test

No third-party packages. Linux and macOS use termios. Windows uses pyserial
if it is already installed.
"""

from __future__ import annotations

import argparse
import os
import select
import socket
import struct
import sys
import threading
import time

ACK = 0x79
NACK = 0x1F
SYNC = 0x7F
CMD_GET = 0x00
CMD_GET_ID = 0x02
CMD_READ = 0x11
CMD_GO = 0x21
CMD_WRITE = 0x31
CMD_ERASE = 0x43
CMD_EXT_ERASE = 0x44
DEFAULT_BASE = 0x08000000
CHUNK = 256

CHIP_NAMES = {
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
}


class ProtocolError(Exception):
    pass


class SyncError(ProtocolError):
    pass


class NackError(ProtocolError):
    pass


class StreamLink:
    def __init__(self, fd: int) -> None:
        self.fd = fd

    def write(self, data: bytes) -> None:
        view = memoryview(data)
        while view:
            n = os.write(self.fd, view)
            view = view[n:]

    def read_exact(self, n: int, timeout: float) -> bytes:
        deadline = time.monotonic() + timeout
        buf = bytearray()
        while len(buf) < n:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("timeout")
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                raise TimeoutError("timeout")
            chunk = os.read(self.fd, n - len(buf))
            if not chunk:
                raise TimeoutError("eof")
            buf += chunk
        return bytes(buf)


def xor_bytes(data: bytes) -> int:
    x = 0
    for b in data:
        x ^= b
    return x & 0xFF


def encode_address(addr: int) -> bytes:
    raw = struct.pack(">I", addr & 0xFFFFFFFF)
    return raw + bytes([xor_bytes(raw)])


def pad_image(image: bytes) -> bytes:
    extra = (-len(image)) % 8
    if extra == 0:
        return image
    return image + bytes([0xFF] * extra)


def chip_name(chip_id: int) -> str:
    return CHIP_NAMES.get(chip_id, f"STM32 0x{chip_id:03x}")


def read_ack(link: StreamLink, timeout: float, step: str) -> None:
    deadline = time.monotonic() + timeout
    for _ in range(4):
        left = deadline - time.monotonic()
        if left <= 0:
            raise ProtocolError(f"Timeout waiting for ACK ({step})")
        b = link.read_exact(1, left)[0]
        if b == ACK:
            return
        if b == NACK:
            raise NackError(f"Device NACKed during {step}")
    raise ProtocolError(f"No ACK during {step}")


def command(link: StreamLink, code: int, step: str, timeout: float = 1.0) -> None:
    link.write(bytes([code, code ^ 0xFF]))
    read_ack(link, timeout, step)


def drain(link: StreamLink, quiet: float = 0.03) -> None:
    while True:
        try:
            link.read_exact(1, quiet)
        except TimeoutError:
            return


def sync_bootloader(link: StreamLink) -> None:
    drain(link)
    detail = "no reply"
    for _ in range(4):
        link.write(bytes([SYNC]))
        try:
            read_ack(link, 0.35, "sync")
            return
        except NackError:
            detail = "NACK"
        except (TimeoutError, ProtocolError):
            detail = "timeout"
    raise SyncError(
        f"No bootloader at 115200 ({detail}). Reset with BOOT0 held high. On STM32G0 the pin is ignored while nBOOT_SEL is 1."
    )


def cmd_get(link: StreamLink) -> tuple[int, list[int]]:
    command(link, CMD_GET, "GET")
    n = link.read_exact(1, 1.0)[0]
    version = link.read_exact(1, 1.0)[0]
    commands = list(link.read_exact(n, 1.0))
    read_ack(link, 1.0, "GET end")
    return version, commands


def cmd_get_id(link: StreamLink) -> int:
    command(link, CMD_GET_ID, "GET_ID")
    n = link.read_exact(1, 1.0)[0]
    raw = link.read_exact(n + 1, 1.0)
    read_ack(link, 1.0, "GET_ID end")
    chip_id = 0
    for b in raw:
        chip_id = (chip_id << 8) | b
    return chip_id


def mass_erase(link: StreamLink, commands: list[int]) -> None:
    if CMD_EXT_ERASE in commands:
        command(link, CMD_EXT_ERASE, "extended erase")
        link.write(bytes([0xFF, 0xFF, 0x00]))
        read_ack(link, 60.0, "mass erase")
        return
    if CMD_ERASE in commands:
        command(link, CMD_ERASE, "erase")
        link.write(bytes([0xFF, 0x00]))
        read_ack(link, 60.0, "mass erase")
        return
    raise ProtocolError("Bootloader has neither erase command (0x43 / 0x44).")


def write_chunk(link: StreamLink, addr: int, chunk: bytes) -> None:
    command(link, CMD_WRITE, "write")
    link.write(encode_address(addr))
    read_ack(link, 1.0, "write address")
    n = len(chunk) - 1
    cs = n
    for b in chunk:
        cs ^= b
    link.write(bytes([n]) + chunk + bytes([cs & 0xFF]))
    read_ack(link, 2.0, "write data")


def read_chunk(link: StreamLink, addr: int, length: int) -> bytes:
    command(link, CMD_READ, "read")
    link.write(encode_address(addr))
    read_ack(link, 1.0, "read address")
    n = length - 1
    link.write(bytes([n, n ^ 0xFF]))
    return link.read_exact(length, 2.0)


def go(link: StreamLink, addr: int) -> None:
    command(link, CMD_GO, "go")
    link.write(encode_address(addr))
    read_ack(link, 1.0, "go address")


def upload(link: StreamLink, image: bytes, base: int, verify: bool, start: bool, log, progress=None) -> dict:
    if base % 8:
        raise ProtocolError("Base address must be 8-byte aligned.")
    if not image:
        raise ProtocolError("Image is empty.")
    if len(image) > 2 * 1024 * 1024:
        raise ProtocolError("Image is over 2 MB. Refusing to write.")

    def tick(phase: str, done: int, total: int) -> None:
        if progress:
            progress(phase, done, total)

    image = pad_image(image)
    span = len(image) * (2 if verify else 1)
    tick("sync", 0, 0)
    log("Sync 0x7F at 115200")
    sync_bootloader(link)
    log("Bootloader answered")
    tick("identify", 0, 0)
    version, commands = cmd_get(link)
    log("Bootloader version {:02x}".format(version))
    chip_id = cmd_get_id(link)
    log(f"Chip {chip_name(chip_id)} (0x{chip_id:x})")
    tick("erase", 0, 0)
    log("Mass erase")
    mass_erase(link, commands)
    log("Erase done")
    for off in range(0, len(image), CHUNK):
        chunk = image[off : off + CHUNK]
        write_chunk(link, base + off, chunk)
        written = off + len(chunk)
        tick("write", written, span)
        if off == 0 or written >= len(image) or (off // CHUNK) % 8 == 0:
            log(f"  {written}/{len(image)}")
    log(f"Wrote {len(image)} bytes at 0x{base:08x}")
    if verify:
        for off in range(0, len(image), CHUNK):
            chunk = image[off : off + CHUNK]
            got = read_chunk(link, base + off, len(chunk))
            if got != chunk:
                raise ProtocolError(f"Verify failed at 0x{base + off:08x}")
            tick("verify", len(image) + off + len(chunk), span)
        log("Verify matched")
    started = False
    if start:
        if CMD_GO not in commands:
            log("No Go command; image is written but the core was not started")
        else:
            tick("go", span, span)
            log(f"Go 0x{base:08x} — starting the application")
            go(link, base)
            started = True
            log("Device left the bootloader and is running the new image")
    tick("done", span, span or 1)
    return {"chip_id": chip_id, "bytes": len(image), "started": started}


def parse_intel_hex(text: str) -> tuple[int, bytes]:
    upper = 0
    mem: dict[int, int] = {}
    min_a = None
    max_a = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise ProtocolError(f"Bad HEX line: {line[:20]}")
        rec = bytes.fromhex(line[1:])
        count, addr, typ = rec[0], (rec[1] << 8) | rec[2], rec[3]
        if len(rec) != count + 5 or xor_bytes(rec) != 0:
            raise ProtocolError("HEX record failed length or checksum")
        if typ == 0x00:
            for i in range(count):
                a = (upper + addr + i) & 0xFFFFFFFF
                mem[a] = rec[4 + i]
                min_a = a if min_a is None else min(min_a, a)
                max_a = a if max_a is None else max(max_a, a)
        elif typ == 0x01:
            break
        elif typ == 0x04:
            upper = ((rec[4] << 8) | rec[5]) << 16
        elif typ == 0x02:
            upper = ((rec[4] << 8) | rec[5]) << 4
    if min_a is None or max_a is None:
        raise ProtocolError("HEX file has no data")
    image = bytearray([0xFF] * (max_a - min_a + 1))
    for a, b in mem.items():
        image[a - min_a] = b
    return min_a, bytes(image)


def load_image(path: str) -> tuple[int | None, bytes]:
    with open(path, "rb") as fh:
        raw = fh.read()
    if path.lower().endswith(".hex"):
        return parse_intel_hex(raw.decode("utf-8", "replace"))
    return None, raw


def open_serial(path: str, baud: int, parity: str) -> int:
    if os.name == "nt":
        raise ProtocolError("Windows needs pyserial; this process will use it from main().")
    import termios

    speeds = {
        9600: termios.B9600,
        57600: termios.B57600,
        115200: termios.B115200,
        230400: getattr(termios, "B230400", termios.B115200),
    }
    if baud not in speeds:
        raise ProtocolError(f"Unsupported baud {baud}")
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0
    attrs[1] = 0
    cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
    if parity == "even":
        cflag |= termios.PARENB
    elif parity == "odd":
        cflag |= termios.PARENB | termios.PARODD
    attrs[2] = cflag
    attrs[3] = 0
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.cfsetispeed(attrs, speeds[baud])
    termios.cfsetospeed(attrs, speeds[baud])
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)
    return fd


def open_pyserial(path: str, baud: int, parity: str):
    import serial  # type: ignore

    par = {"none": "N", "even": "E", "odd": "O"}[parity]
    ser = serial.Serial(path, baudrate=baud, bytesize=8, parity=par, stopbits=1, timeout=0)
    return ser


class PySerialLink(StreamLink):
    def __init__(self, ser) -> None:
        self.ser = ser
        super().__init__(ser.fileno())


def format_cli(
    port: str,
    image: str,
    address: str | None = None,
    baud: int = 115200,
    parity: str = "auto",
    verify: bool = True,
    start: bool = True,
) -> str:
    """The same invocation the CLI would use for these choices."""
    import shlex

    parts = ["python3", "usart2-upload.py", "-p", shlex.quote(port or "PORT")]
    if baud != 115200:
        parts += ["-b", str(int(baud))]
    if address:
        parts += ["-a", shlex.quote(address)]
    if parity != "auto":
        parts += ["--parity", parity]
    if not verify:
        parts.append("--no-verify")
    if not start:
        parts.append("--no-go")
    parts.append(shlex.quote(image or "firmware.bin"))
    return " ".join(parts)


def flash_port(
    path: str,
    baud: int,
    parities: list[str],
    image: bytes,
    base: int,
    verify: bool,
    start: bool,
    log=None,
    progress=None,
) -> dict:
    if log is None:
        log = lambda msg: print(msg, file=sys.stderr)
    last: Exception | None = None
    for parity in parities:
        framing = {"none": "8N1", "even": "8E1", "odd": "8O1"}[parity]
        log(f"Open {path} at {baud} {framing}")
        if os.name == "nt":
            ser = open_pyserial(path, baud, parity)
            link = PySerialLink(ser)
            close = ser.close
        else:
            fd = open_serial(path, baud, parity)
            link = StreamLink(fd)
            close = lambda: os.close(fd)
        result = None
        try:
            result = upload(link, image, base, verify, start, log, progress)
        except SyncError as exc:
            last = exc
            log(str(exc).split(".")[0] + f" on {framing}")
        finally:
            try:
                close()
            except OSError:
                # Go resets the MCU and some adapters drop the port as it happens.
                if result is None:
                    raise
        if result is not None:
            return result
    raise last or SyncError("no reply")


def run_mock(link: StreamLink, mem: bytearray, base: int, done: threading.Event) -> None:
    commands = [0x00, 0x01, 0x02, 0x11, 0x21, 0x31, 0x44]
    version = 0x31
    chip_id = 0x460
    try:
        while True:
            first = link.read_exact(1, 5.0)[0]
            if first == SYNC:
                link.write(bytes([ACK]))
                continue
            comp = link.read_exact(1, 1.0)[0]
            if (first ^ 0xFF) != comp:
                link.write(bytes([NACK]))
                continue
            if first == CMD_GET:
                body = bytes([len(commands), version, *commands])
                link.write(bytes([ACK]) + body + bytes([ACK]))
            elif first == CMD_GET_ID:
                link.write(bytes([ACK, 0x01, (chip_id >> 8) & 0xFF, chip_id & 0xFF, ACK]))
            elif first in (CMD_EXT_ERASE, CMD_ERASE):
                link.write(bytes([ACK]))
                link.read_exact(3 if first == CMD_EXT_ERASE else 2, 1.0)
                for i in range(len(mem)):
                    mem[i] = 0xFF
                link.write(bytes([ACK]))
            elif first == CMD_WRITE:
                link.write(bytes([ACK]))
                frame = link.read_exact(5, 1.0)
                link.write(bytes([ACK]))
                n = link.read_exact(1, 1.0)[0]
                data = link.read_exact(n + 1, 1.0)
                link.read_exact(1, 1.0)
                off = struct.unpack(">I", frame[:4])[0] - base
                mem[off : off + len(data)] = data
                link.write(bytes([ACK]))
            elif first == CMD_READ:
                link.write(bytes([ACK]))
                frame = link.read_exact(5, 1.0)
                link.write(bytes([ACK]))
                n = link.read_exact(2, 1.0)[0]
                off = struct.unpack(">I", frame[:4])[0] - base
                link.write(bytes(mem[off : off + n + 1]))
            elif first == CMD_GO:
                link.write(bytes([ACK]))
                link.read_exact(5, 1.0)
                link.write(bytes([ACK]))
                return
            else:
                link.write(bytes([NACK]))
    finally:
        done.set()


def self_test() -> None:
    host, dev = socket.socketpair()
    mem = bytearray([0xFF] * (64 * 1024))
    image = bytes(i & 0xFF for i in range(300))
    done = threading.Event()
    thread = threading.Thread(target=run_mock, args=(StreamLink(dev.fileno()), mem, DEFAULT_BASE, done), daemon=True)
    thread.start()
    result = upload(StreamLink(host.fileno()), image, DEFAULT_BASE, True, True, lambda _m: None)
    thread.join(3)
    assert result["started"] and result["chip_id"] == 0x460 and result["bytes"] == 304
    assert bytes(mem[:300]) == image
    assert mem[300:304] == bytes([0xFF] * 4)
    host.close()
    dev.close()
    plain = format_cli("/dev/ttyUSB0", "app.bin", address="0x08000000")
    assert plain == "python3 usart2-upload.py -p /dev/ttyUSB0 -a 0x08000000 app.bin"
    flagged = format_cli("COM5", "my app.hex", baud=57600, parity="even", verify=False, start=False)
    assert flagged == "python3 usart2-upload.py -p COM5 -b 57600 --parity even --no-verify --no-go 'my app.hex'"
    print("self-test ok")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload a binary to any STM32 USART bootloader at 115200 and start it.")
    parser.add_argument("image", nargs="?", help=".bin or .hex file")
    parser.add_argument("-p", "--port", help="Serial device, e.g. /dev/ttyUSB0 or COM5")
    parser.add_argument("-b", "--baud", type=int, default=115200, help="Baud rate (default 115200)")
    parser.add_argument("-a", "--address", default=None, help="Flash base, default 0x08000000 or the HEX base")
    parser.add_argument("--parity", choices=("auto", "none", "even"), default="auto")
    parser.add_argument("--no-verify", action="store_true")
    parser.add_argument("--no-go", action="store_true", help="Write the image but do not start the core")
    parser.add_argument("--self-test", action="store_true", help="Run the protocol against an in-process bootloader")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        self_test()
        return
    if not args.image or not args.port:
        raise SystemExit("Need a serial port (-p) and a firmware file. See --help.")
    hex_base, image = load_image(args.image)
    if args.address:
        base = int(args.address, 0)
    elif hex_base is not None:
        base = hex_base
    else:
        base = DEFAULT_BASE
    parities = ["none", "even"] if args.parity == "auto" else [args.parity]
    flash_port(args.port, args.baud, parities, image, base, not args.no_verify, not args.no_go)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # Go resets the line; the port may vanish under us after a successful start.
        pass
    except (ProtocolError, TimeoutError, OSError) as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
