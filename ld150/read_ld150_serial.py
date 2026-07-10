"""
Simple LD150 / HR-RTLS1 serial reader.

Usage:
  python ld150/read_ld150_serial.py --list-ports
  python ld150/read_ld150_serial.py --port COM7

The script prints every raw serial line. When it sees an LD150 "mc" ranging
frame, it also decodes the A0-A3 distances from hex millimeters to meters.
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from typing import Dict, Optional

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


ANCHOR_TAG_PATTERN = re.compile(r"^a([0-9a-fA-F]+):([0-9a-fA-F]+)$")
RANGE_TOKEN_COUNT = 4


@dataclass(frozen=True)
class McFrame:
    reporting_anchor: int
    tag_id: int
    distances_m: Dict[int, float]
    range_count: Optional[int]
    sequence: Optional[int]
    range_time: Optional[int]
    diag: Optional[str]


def parse_hex_int(token: str) -> Optional[int]:
    try:
        return int(token, 16)
    except (TypeError, ValueError):
        return None


def parse_distance_m(token: str) -> Optional[float]:
    normalized = token.strip().lower()
    if normalized in {"00000000", "ffffffff"}:
        return None

    raw_value = parse_hex_int(normalized)
    if raw_value is None or raw_value <= 0 or raw_value >= 0x80000000:
        return None

    return raw_value / 1000.0


def parse_mc_frame(line: str) -> Optional[McFrame]:
    parts = line.strip().split()
    if len(parts) < 10 or parts[0].lower() != "mc":
        return None

    address_token = next(
        (part for part in parts if ANCHOR_TAG_PATTERN.match(part)),
        None,
    )
    if address_token is None:
        return None

    match = ANCHOR_TAG_PATTERN.match(address_token)
    if match is None:
        return None

    reporting_anchor = parse_hex_int(match.group(1))
    tag_id = parse_hex_int(match.group(2))
    if reporting_anchor is None or tag_id is None:
        return None

    distances_m: Dict[int, float] = {}
    for anchor_index, token in enumerate(parts[2 : 2 + RANGE_TOKEN_COUNT]):
        distance_m = parse_distance_m(token)
        if distance_m is not None:
            distances_m[anchor_index] = distance_m

    return McFrame(
        reporting_anchor=reporting_anchor,
        tag_id=tag_id,
        distances_m=distances_m,
        range_count=parse_hex_int(parts[6]) if len(parts) > 6 else None,
        sequence=parse_hex_int(parts[7]) if len(parts) > 7 else None,
        range_time=parse_hex_int(parts[8]) if len(parts) > 8 else None,
        diag=parts[-1] if parts else None,
    )


def print_decoded_mc(frame: McFrame) -> None:
    print("  [decoded mc]")
    print(f"    reporting anchor : A{frame.reporting_anchor}")
    print(f"    tag              : T{frame.tag_id}")

    if frame.distances_m:
        print("    distances        :")
        for anchor_index in range(RANGE_TOKEN_COUNT):
            distance_m = frame.distances_m.get(anchor_index)
            if distance_m is None:
                print(f"      A{anchor_index} -> T{frame.tag_id}: invalid/no data")
            else:
                print(
                    f"      A{anchor_index} -> T{frame.tag_id}: "
                    f"{distance_m:.3f} m ({distance_m * 1000:.0f} mm)"
                )
    else:
        print("    distances        : no valid range values")

    if frame.range_count is not None:
        print(f"    range count      : {frame.range_count}")
    if frame.sequence is not None:
        print(f"    sequence         : {frame.sequence}")
    if frame.range_time is not None:
        print(f"    range time       : {frame.range_time}")
    if frame.diag:
        print(f"    diag             : {frame.diag}")


def print_range_error(line: str) -> None:
    fields = {}
    for item in line.split(",", 1)[1].split(",") if "," in line else []:
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        fields[key.strip()] = value.strip()

    print("  [range error]")
    for key in ("ID", "rb", "rangetime", "battery", "sos"):
        if key in fields:
            print(f"    {key:16}: {fields[key]}")


def print_possible_position(line: str) -> None:
    # Some firmware configurations may output coordinates, for example LO=[x,y,z].
    match = re.search(
        r"\bLO\s*=\s*\[\s*([-+]?\d+(?:\.\d+)?)\s*,\s*"
        r"([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*\]",
        line,
        flags=re.IGNORECASE,
    )
    if not match:
        return

    x, y, z = (float(match.group(index)) for index in (1, 2, 3))
    print("  [decoded position]")
    print(f"    x={x:.3f}, y={y:.3f}, z={z:.3f}")


def list_serial_devices() -> None:
    if list_ports is None:
        raise SystemExit("pyserial is not installed. Run: python -m pip install pyserial")

    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports found.")
        return

    for port in ports:
        print(f"{port.device}\t{port.description}")


def read_serial(port: str, baud: int, timeout: float) -> None:
    if serial is None:
        raise SystemExit("pyserial is not installed. Run: python -m pip install pyserial")

    print(f"Opening {port} @ {baud} baud. Press Ctrl+C to stop.")
    with serial.Serial(port=port, baudrate=baud, timeout=timeout) as ser:
        while True:
            raw_bytes = ser.readline()
            if not raw_bytes:
                continue

            line = raw_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            print(f"[raw] {line}")

            mc_frame = parse_mc_frame(line)
            if mc_frame is not None:
                print_decoded_mc(mc_frame)
                continue

            if line.startswith("$RANGE_ERROR"):
                print_range_error(line)
                continue

            print_possible_position(line)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read and decode LD150 serial output.")
    parser.add_argument("--port", default="", help="Serial port, for example COM7.")
    parser.add_argument("--baud", type=int, default=115200, help="Default: 115200.")
    parser.add_argument("--timeout", type=float, default=1.0, help="Serial timeout seconds.")
    parser.add_argument("--list-ports", action="store_true", help="List available serial ports.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list_ports:
        list_serial_devices()
        return

    if not args.port:
        raise SystemExit("Missing --port. Example: python ld150/read_ld150_serial.py --port COM7")

    try:
        read_serial(args.port, args.baud, args.timeout)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
