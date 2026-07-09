"""
BLE diagnostic logger for the Estimote UWB tag payload.

This records every new BLE advertisement sequence to CSV so we can separate:
  - BLE receive gaps: adv_delta is large
  - UWB anchor gaps: one anchor age grows while adv keeps moving
  - sync-frame gaps: sync_seq stops changing or sync_span is too large

Example:
  python estimote_ble_diagnostic_logger.py --config estimote_anchor_config.json --duration 60
  python estimote_ble_diagnostic_logger.py --config estimote_anchor_config.json --csv run1.csv
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from estimote_ble_position_receiver import (
    ANCHOR_COUNT,
    decode_payload,
    load_config,
    prepare_windows_ble_thread,
    service_uuid_matches,
    solve_position,
)


def delta_u8(current: int, previous: Optional[int]) -> str:
    if previous is None:
        return ""
    return str((current - previous) % 256)


def fmt_optional(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def default_csv_path() -> Path:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return Path(f"estimote_ble_diag_{stamp}.csv")


def capture_timestamp() -> datetime:
    return datetime.now().astimezone()


def format_iso_timestamp(timestamp: datetime) -> str:
    return timestamp.isoformat(timespec="milliseconds")


def format_local_time(timestamp: datetime) -> str:
    return timestamp.strftime("%H:%M:%S.%f")[:-3]


async def scan(args: argparse.Namespace) -> None:
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise SystemExit("bleak is not installed. Run: python -m pip install bleak") from exc

    config = load_config(Path(args.config))
    csv_path = Path(args.csv) if args.csv else default_csv_path()
    prepare_windows_ble_thread(allow_gui_sta=False)

    last_adv_by_source: Dict[str, int] = {}
    last_sync_by_source: Dict[str, int] = {}
    start = time.monotonic()
    rows = 0

    fieldnames = [
        "timestamp_iso",
        "local_time",
        "elapsed_s",
        "source",
        "name",
        "adv_seq",
        "adv_delta",
        "state",
        "valid_count",
        "battery",
        "sync_seq",
        "sync_delta",
        "sync_span_s",
        "x",
        "y",
        "z",
        "residual",
        "used",
        "raw_hex",
    ]

    for anchor in config.anchors:
        fieldnames.append(f"d_{anchor.name}_m")
    for anchor in config.anchors:
        fieldnames.append(f"age_{anchor.name}_s")
    for anchor in config.anchors:
        fieldnames.append(f"lqi_{anchor.name}")

    csv_file = csv_path.open("w", newline="", encoding="utf-8")
    writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
    writer.writeheader()

    def callback(device: object, advertisement_data: object) -> None:
        nonlocal rows

        service_data = getattr(advertisement_data, "service_data", {}) or {}
        source = str(getattr(device, "address", "unknown"))
        name = str(getattr(device, "name", "") or "")

        for uuid, data in service_data.items():
            if not service_uuid_matches(str(uuid), config.service_uuid):
                continue

            frame = decode_payload(bytes(data))
            if frame is None:
                continue

            previous_adv = last_adv_by_source.get(source)
            if previous_adv == frame.seq and not args.include_duplicates:
                return
            last_adv_by_source[source] = frame.seq

            timestamp = capture_timestamp()
            elapsed = time.monotonic() - start
            solved = solve_position(frame, config, args.min_valid_anchors)
            row = {
                "timestamp_iso": format_iso_timestamp(timestamp),
                "local_time": format_local_time(timestamp),
                "elapsed_s": f"{elapsed:.3f}",
                "source": source,
                "name": name,
                "adv_seq": frame.seq,
                "adv_delta": delta_u8(frame.seq, previous_adv),
                "state": "paused" if frame.paused else "running",
                "valid_count": frame.valid_count,
                "battery": frame.battery,
                "sync_seq": "" if frame.sync_seq is None or frame.sync_seq == 0 else frame.sync_seq,
                "sync_delta": "",
                "sync_span_s": fmt_optional(frame.sync_span_s),
                "raw_hex": frame.raw_hex,
            }

            if frame.sync_seq is not None and frame.sync_seq != 0:
                previous_sync = last_sync_by_source.get(source)
                row["sync_delta"] = delta_u8(frame.sync_seq, previous_sync)
                last_sync_by_source[source] = frame.sync_seq

            if solved is not None:
                x, y, z, residual, used_ranges = solved
                row["x"] = f"{x:.3f}"
                row["y"] = f"{y:.3f}"
                row["z"] = f"{z:.3f}"
                row["residual"] = f"{residual:.3f}"
                row["used"] = ",".join(anchor.name for anchor, _ in used_ranges)
            else:
                row["x"] = ""
                row["y"] = ""
                row["z"] = ""
                row["residual"] = ""
                row["used"] = ""

            for index, anchor in enumerate(config.anchors):
                row[f"d_{anchor.name}_m"] = fmt_optional(frame.distances_m[index])
                age = frame.ages_s[index] if index < len(frame.ages_s) else None
                row[f"age_{anchor.name}_s"] = fmt_optional(age)
                row[f"lqi_{anchor.name}"] = fmt_optional(frame.lqi[index])

            writer.writerow(row)
            rows += 1

            if args.print_rows:
                ages = " ".join(
                    f"{config.anchors[index].name}:{fmt_optional(frame.ages_s[index] if index < len(frame.ages_s) else None) or '--'}"
                    for index in range(ANCHOR_COUNT)
                )
                sync = "--" if frame.sync_seq is None or frame.sync_seq == 0 else f"{frame.sync_seq:03d}"
                print(
                    f"[{row['local_time']}] {elapsed:7.2f}s "
                    f"adv={frame.seq:03d} d={row['adv_delta'] or '--':>3} "
                    f"sync={sync} span={row['sync_span_s'] or '--'} valid={frame.valid_count}/4 "
                    f"ages {ages}"
                )

    print(f"Logging BLE diagnostics to {csv_path}")
    print("Press Ctrl+C to stop.")

    try:
        async with BleakScanner(callback):
            while True:
                if args.duration > 0 and time.monotonic() - start >= args.duration:
                    break
                await asyncio.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        csv_file.flush()
        csv_file.close()
        print(f"Saved {rows} rows to {csv_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Log Estimote UWB BLE diagnostic frames to CSV.")
    parser.add_argument("--config", default="estimote_anchor_config.json")
    parser.add_argument("--csv", default="", help="Output CSV path. Default: timestamped file.")
    parser.add_argument("--duration", type=float, default=60.0, help="Seconds to scan. Use 0 for until Ctrl+C.")
    parser.add_argument("--min-valid-anchors", type=int, default=4, choices=[3, 4])
    parser.add_argument("--include-duplicates", action="store_true", help="Also log repeated adv seq values.")
    parser.add_argument("--print-rows", action="store_true", help="Print compact diagnostics while logging.")
    return parser.parse_args()


def main() -> None:
    asyncio.run(scan(parse_args()))


if __name__ == "__main__":
    main()
