#!/usr/bin/env python3
"""Desktop window for the STM32 USART bootloader uploader.

Pick a firmware file, choose the serial port, watch the bar, and copy the
CLI command that does the same flash.

    pip install -r requirements.txt
    python3 flet_app.py
"""

from __future__ import annotations

import asyncio
import glob
import importlib.util
import os
import time
from pathlib import Path

import flet as ft

ROOT = Path(__file__).resolve().parent
UPLOADER = ROOT / "public" / "usart2-upload.py"

BG = "#121510"
SURFACE = "#1c2118"
FG = "#e7eedd"
MUTED = "#939e86"
LINE = "#343b2e"
SIGNAL = "#d6f25c"
INK = "#1a2208"
FAULT = "#e36b4f"

PHASE = {
    "sync": "Syncing",
    "identify": "Identifying",
    "erase": "Mass erase",
    "write": "Writing",
    "verify": "Verifying",
    "go": "Starting the application",
    "done": "Done",
}


def load_uploader():
    spec = importlib.util.spec_from_file_location("usart2_upload", UPLOADER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {UPLOADER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


up = load_uploader()


def list_serial_ports() -> list[str]:
    found: list[str] = []
    if os.name == "nt":
        try:
            from serial.tools import list_ports

            found = [p.device for p in list_ports.comports()]
        except Exception:
            found = []
        return found
    patterns = [
        "/dev/ttyUSB*",
        "/dev/ttyACM*",
        "/dev/cu.usb*",
        "/dev/tty.usb*",
        "/dev/cu.wchusbserial*",
        "/dev/tty.wchusbserial*",
        "/dev/cu.SLAB*",
        "/dev/tty.SLAB*",
    ]
    for pattern in patterns:
        found.extend(glob.glob(pattern))
    by_id = "/dev/serial/by-id"
    if os.path.isdir(by_id):
        found.extend(os.path.join(by_id, name) for name in sorted(os.listdir(by_id)))
    unique: list[str] = []
    for path in found:
        if path not in unique:
            unique.append(path)
    return unique


def main(page: ft.Page) -> None:
    page.title = "STM32 USART Upload"
    page.theme_mode = ft.ThemeMode.DARK
    page.bgcolor = BG
    page.padding = 24
    page.window.width = 760
    page.window.height = 880
    page.window.min_width = 440
    page.window.min_height = 640

    firmware: dict[str, object] = {"path": "", "name": "", "bytes": None}

    file_label = ft.Text("No firmware selected", color=MUTED, size=13)
    command = ft.Text(
        "",
        selectable=True,
        color=SIGNAL,
        size=13,
        font_family="monospace",
    )
    bar = ft.ProgressBar(value=0, color=SIGNAL, bgcolor=LINE, bar_height=8, border_radius=8)
    phase = ft.Text("Idle", color=MUTED, size=12)
    percent = ft.Text("—", color=MUTED, size=12)
    log = ft.TextField(
        value="",
        read_only=True,
        multiline=True,
        min_lines=8,
        max_lines=12,
        bgcolor=BG,
        color=FG,
        border_color=LINE,
        text_size=12,
        text_style=ft.TextStyle(font_family="monospace"),
    )
    flash_btn = ft.Button(content="Flash and reset", icon=ft.Icons.PLAY_ARROW, bgcolor=SIGNAL, color=INK)
    pick_btn = ft.Button(content="Choose firmware", icon=ft.Icons.FOLDER_OPEN, bgcolor=SURFACE, color=FG)
    refresh_btn = ft.Button(content="Ports", icon=ft.Icons.REFRESH, bgcolor=SURFACE, color=FG)
    copy_btn = ft.Button(content="Copy", icon=ft.Icons.CONTENT_COPY, bgcolor=BG, color=FG)

    port = ft.Dropdown(
        label="Serial port",
        editable=True,
        enable_search=True,
        hint_text="/dev/ttyUSB0 or COM5",
        bgcolor=BG,
        color=FG,
        border_color=LINE,
        expand=True,
    )
    address = ft.TextField(
        label="Flash base",
        value="0x08000000",
        bgcolor=BG,
        color=FG,
        border_color=LINE,
        text_size=14,
        expand=True,
    )
    baud = ft.TextField(
        label="Baud",
        value="115200",
        bgcolor=BG,
        color=FG,
        border_color=LINE,
        text_size=14,
        width=140,
    )
    parity = ft.Dropdown(
        label="Framing",
        value="auto",
        options=[
            ft.DropdownOption(key="auto", text="Auto: 8N1, then 8E1"),
            ft.DropdownOption(key="none", text="8N1 only"),
            ft.DropdownOption(key="even", text="8E1 only"),
        ],
        bgcolor=BG,
        color=FG,
        border_color=LINE,
        expand=True,
    )
    verify = ft.Checkbox(label="Read back before starting", value=True, fill_color=SIGNAL, check_color=INK)
    go = ft.Checkbox(label="Go — reset into the new image", value=True, fill_color=SIGNAL, check_color=INK)

    def port_value() -> str:
        return (port.value or getattr(port, "text", None) or "").strip()

    def append_log(text: str) -> None:
        current = log.value or ""
        lines = (current + ("\n" if current else "") + text).splitlines()
        log.value = "\n".join(lines[-200:])

    def refresh_command() -> None:
        name = str(firmware["path"] or firmware["name"] or "firmware.bin")
        try:
            baud_i = int((baud.value or "115200").strip() or "115200")
        except ValueError:
            baud_i = 115200
        command.value = up.format_cli(
            port_value(),
            name,
            address=(address.value or "").strip() or None,
            baud=baud_i,
            parity=parity.value or "auto",
            verify=bool(verify.value),
            start=bool(go.value),
        )

    def set_busy(busy: bool) -> None:
        flash_btn.disabled = busy
        pick_btn.disabled = busy
        refresh_btn.disabled = busy
        port.disabled = busy

    def fill_ports(prefer: str = "") -> None:
        ports = list_serial_ports()
        chosen = prefer or port_value()
        options = list(ports)
        if chosen and chosen not in options:
            options.insert(0, chosen)
        port.options = [ft.DropdownOption(key=item, text=item) for item in options]
        if chosen:
            port.value = chosen
        elif ports:
            port.value = ports[0]

    async def on_pick(_: ft.ControlEvent) -> None:
        files = await ft.FilePicker().pick_files(
            dialog_title="Firmware image",
            allow_multiple=False,
            with_data=False,
            file_type=ft.FilePickerFileType.CUSTOM,
            allowed_extensions=["bin", "hex"],
        )
        if not files:
            return
        picked = files[0]
        firmware["path"] = picked.path or ""
        firmware["name"] = picked.name or ""
        firmware["bytes"] = picked.bytes
        size = f"{picked.size} bytes" if picked.size else "size unknown"
        file_label.value = f"{picked.path or picked.name}  ·  {size}"
        file_label.color = FG
        refresh_command()
        page.update()

    def on_refresh_ports(_: ft.ControlEvent) -> None:
        fill_ports()
        refresh_command()
        page.update()

    async def on_copy(_: ft.ControlEvent) -> None:
        await ft.Clipboard().set(command.value or "")
        append_log("Copied the CLI command.")
        page.update()

    async def on_flash(_: ft.ControlEvent) -> None:
        path = port_value()
        if not path:
            append_log("Pick a serial port.")
            phase.value = "Need a port"
            phase.color = FAULT
            page.update()
            return
        if not firmware["path"] and firmware["bytes"] is None:
            append_log("Pick a .bin or .hex file.")
            phase.value = "Need firmware"
            phase.color = FAULT
            page.update()
            return
        try:
            baud_i = int((baud.value or "115200").strip())
        except ValueError:
            append_log("Baud must be a number.")
            page.update()
            return
        try:
            if firmware["path"]:
                hex_base, image = up.load_image(str(firmware["path"]))
            else:
                raw = firmware["bytes"]
                if not isinstance(raw, (bytes, bytearray)):
                    files = await ft.FilePicker().pick_files(
                        dialog_title="Firmware image",
                        allow_multiple=False,
                        with_data=True,
                        file_type=ft.FilePickerFileType.CUSTOM,
                        allowed_extensions=["bin", "hex"],
                    )
                    if not files or files[0].bytes is None:
                        append_log("The picker returned a name but no bytes. Pick the file again.")
                        page.update()
                        return
                    raw = files[0].bytes
                    firmware["bytes"] = raw
                    firmware["name"] = files[0].name or ""
                name = str(firmware["name"] or "firmware.bin")
                if name.lower().endswith(".hex"):
                    hex_base, image = up.parse_intel_hex(bytes(raw).decode("utf-8", "replace"))
                else:
                    hex_base, image = None, bytes(raw)
            typed = (address.value or "").strip()
            if typed:
                base = int(typed, 0)
            elif hex_base is not None:
                base = hex_base
            else:
                base = up.DEFAULT_BASE
        except (OSError, ValueError, up.ProtocolError) as exc:
            append_log(str(exc))
            phase.value = "Could not read the file"
            phase.color = FAULT
            page.update()
            return

        framing = parity.value or "auto"
        parities = ["none", "even"] if framing == "auto" else [framing]
        set_busy(True)
        bar.value = None
        phase.value = "Opening the port"
        phase.color = FG
        percent.value = "—"
        append_log(f"Flash {len(image)} bytes at 0x{base:08x}")
        page.update()

        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()

        def on_log(message: str) -> None:
            loop.call_soon_threadsafe(events.put_nowait, ("log", message))

        def on_progress(step: str, done: int, total: int) -> None:
            loop.call_soon_threadsafe(events.put_nowait, ("progress", step, done, total))

        task = asyncio.create_task(
            asyncio.to_thread(
                up.flash_port,
                path,
                baud_i,
                parities,
                image,
                base,
                bool(verify.value),
                bool(go.value),
                on_log,
                on_progress,
            )
        )
        last_paint = 0.0
        try:
            while not task.done() or not events.empty():
                try:
                    kind, *rest = await asyncio.wait_for(events.get(), 0.15)
                except asyncio.TimeoutError:
                    continue
                if kind == "log":
                    append_log(str(rest[0]))
                else:
                    step, done, total = rest
                    phase.value = PHASE.get(str(step), str(step))
                    phase.color = FG
                    if not total:
                        bar.value = None
                        percent.value = "—"
                    else:
                        frac = max(0.0, min(1.0, int(done) / int(total)))
                        bar.value = frac
                        percent.value = f"{round(frac * 100)}%"
                now = time.monotonic()
                if kind == "log" or now - last_paint > 0.05 or task.done():
                    page.update()
                    last_paint = now
            result = task.result()
            bar.value = 1
            percent.value = "100%"
            phase.color = SIGNAL
            chip = up.chip_name(result["chip_id"])
            phase.value = f"Running {chip}" if result.get("started") else f"Written, not started · {chip}"
        except Exception as exc:
            bar.value = 0
            percent.value = "—"
            phase.value = "Failed"
            phase.color = FAULT
            append_log(str(exc))
        finally:
            set_busy(False)
            page.update()

    def on_option_change(_: ft.ControlEvent | None = None) -> None:
        refresh_command()

    pick_btn.on_click = on_pick
    refresh_btn.on_click = on_refresh_ports
    flash_btn.on_click = on_flash
    copy_btn.on_click = on_copy
    port.on_select = on_option_change
    port.on_text_change = on_option_change
    address.on_change = on_option_change
    baud.on_change = on_option_change
    parity.on_select = on_option_change
    verify.on_change = on_option_change
    go.on_change = on_option_change

    fill_ports()
    refresh_command()

    page.add(
        ft.Text("STM32 · USART · 115200", size=12, color=SIGNAL, weight=ft.FontWeight.W_600),
        ft.Text("Flash, then run", size=28, weight=ft.FontWeight.W_600, color=FG),
        ft.Text(
            "Same ROM bootloader as the CLI. Hold BOOT0 and reset first. On STM32G0 the pin is ignored while nBOOT_SEL is 1.",
            color=MUTED,
            size=13,
        ),
        ft.Container(height=8),
        ft.Row([port, refresh_btn], vertical_alignment=ft.CrossAxisAlignment.END),
        ft.Row([pick_btn, ft.Column([file_label], expand=True, alignment=ft.MainAxisAlignment.CENTER)]),
        ft.Row([address, baud], vertical_alignment=ft.CrossAxisAlignment.START),
        parity,
        verify,
        go,
        ft.Container(
            content=ft.Column(
                [
                    ft.Row(
                        [
                            ft.Text("Command", color=FG, weight=ft.FontWeight.W_600),
                            copy_btn,
                        ],
                        alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
                    ),
                    command,
                ],
                spacing=8,
            ),
            bgcolor=SURFACE,
            border=ft.Border.all(1, LINE),
            border_radius=12,
            padding=16,
        ),
        ft.Row([phase, percent], alignment=ft.MainAxisAlignment.SPACE_BETWEEN),
        bar,
        flash_btn,
        ft.Text("Link log", color=FG, weight=ft.FontWeight.W_600),
        log,
    )


if __name__ == "__main__":
    ft.run(main)
