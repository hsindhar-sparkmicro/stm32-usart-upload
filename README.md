# STM32 USART upload

Upload a `.bin` or Intel HEX image to any STM32 system bootloader over USART at 115200, then send Go so the chip runs it. The protocol is AN3155. Chip id is reported and never used as a gate, so STM32G0, G4, F1, F4, L4, WB, WL, and the rest all use the same path.

USART2 on STM32G0 and on most other series:

| Signal | Pin |
| --- | --- |
| MCU TX | PA2, to the adapter RX |
| MCU RX | PA3, to the adapter TX |
| GND | common ground |
| Baud | 115200. 8N1 is tried first, then ROM 8E1 |

Hold BOOT0 and reset before the tool syncs. On STM32G0 the pin is ignored while option bit `nBOOT_SEL` is 1. Clear that bit once over SWD, or set `nBOOT0` to 0. Flash base defaults to `0x08000000`.

## CLI

No packages. Linux and macOS use the system serial driver. Windows uses pyserial if it is already installed.

```bash
python3 public/usart2-upload.py -p /dev/ttyUSB0 firmware.bin
python3 public/usart2-upload.py -p COM5 -a 0x08000000 app.hex
python3 public/usart2-upload.py --self-test
```

`--verify` reads the image back before Go. `--no-erase` skips the mass erase.

## Web page

Chrome or Edge, because it uses Web Serial. Dry run works in any browser against a simulated STM32G0 bootloader.

```bash
npm install
npm run dev
```

Open the printed local URL, choose the firmware, and use Upload and reset.
