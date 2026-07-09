"""
Estimote UWB-over-BLE receiver and live position estimator.

The Estimote tag micro-app broadcasts Service Data FE9A with this payload:
  byte 0      magic = 0xEC
  byte 1      version = 0x02
  byte 2      sequence
  byte 3      flags, bit0-bit3 = anchor A-D valid, bit4 = paused
  byte 4-11   four uint16 little-endian ranges in centimeters
  byte 12-15  four LQI bytes, value 255 means unknown
  byte 16     battery percent
  byte 17     valid anchor count

Usage:
  python estimote_ble_position_receiver.py --config estimote_anchor_config.json
  python estimote_ble_position_receiver.py --config estimote_anchor_config.json --plot
  python estimote_ble_position_receiver.py --sample ec02010f7b00f5002c01c801505a463c5f04

Install dependency for live BLE scanning:
  python -m pip install bleak
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


PAYLOAD_MAGIC = 0xEC
PAYLOAD_VERSION = 0x02
ANCHOR_COUNT = 4
INVALID_DISTANCE_CM = 65535
INVALID_LQI = 255
DEFAULT_CONFIG = "estimote_anchor_config.json"


@dataclass(frozen=True)
class Anchor:
    index: int
    name: str
    identifier: str
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class ReceiverConfig:
    service_uuid: str
    mode: str
    tag_z: float
    anchors: List[Anchor]


@dataclass(frozen=True)
class BleRangeFrame:
    seq: int
    flags: int
    distances_m: List[Optional[float]]
    lqi: List[Optional[float]]
    battery: int
    valid_count: int
    raw_hex: str
    paused: bool
    sync_seq: Optional[int]
    ages_s: List[Optional[float]]
    sync_span_s: Optional[float]


def normalize_uuid(value: str) -> str:
    return value.replace("-", "").lower()


def service_uuid_matches(actual: str, expected: str) -> bool:
    actual_norm = normalize_uuid(actual)
    expected_norm = normalize_uuid(expected)
    if actual_norm == expected_norm:
        return True

    if len(expected_norm) == 4:
        return actual_norm == "0000" + expected_norm + "00001000800000805f9b34fb"

    if len(actual_norm) == 4:
        return expected_norm == "0000" + actual_norm + "00001000800000805f9b34fb"

    return False


def prepare_windows_ble_thread(allow_gui_sta: bool) -> None:
    if sys.platform != "win32":
        return

    try:
        from bleak.backends.winrt.util import allow_sta, uninitialize_sta
    except ImportError:
        return

    try:
        uninitialize_sta()
    except Exception as exc:
        print(f"[warn] could not reset Windows COM apartment for Bleak: {exc}")

    if allow_gui_sta:
        try:
            allow_sta()
        except Exception as exc:
            print(f"[warn] could not allow Windows STA mode for Bleak: {exc}")


def parse_anchor(raw: Dict[str, object], index: int) -> Anchor:
    try:
        name = str(raw.get("name", "A" + str(index)))
        identifier = str(raw["id"]).lower()
        x = float(raw["x"])
        y = float(raw["y"])
        z = float(raw["z"])
    except KeyError as exc:
        raise ValueError(f"anchor {index} missing field: {exc}") from exc
    except (TypeError, ValueError) as exc:
        raise ValueError(f"anchor {index} has invalid coordinate or id") from exc

    if len(identifier) not in {16, 32} or any(ch not in "0123456789abcdef" for ch in identifier):
        raise ValueError(f"anchor {index} id must be 16 or 32 lowercase hex chars: {identifier}")

    return Anchor(index=index, name=name, identifier=identifier, x=x, y=y, z=z)


def load_config(path: Path) -> ReceiverConfig:
    raw = json.loads(path.read_text(encoding="utf-8"))
    anchors_raw = raw.get("anchors", [])
    if len(anchors_raw) != ANCHOR_COUNT:
        raise ValueError(f"config must contain exactly {ANCHOR_COUNT} anchors")

    anchors = [parse_anchor(anchor, index) for index, anchor in enumerate(anchors_raw)]
    mode = str(raw.get("mode", "2d")).lower()
    if mode not in {"2d", "3d"}:
        raise ValueError("mode must be '2d' or '3d'")

    return ReceiverConfig(
        service_uuid=str(raw.get("service_uuid", "FE9A")),
        mode=mode,
        tag_z=float(raw.get("tag_z", 0.9)),
        anchors=anchors,
    )


def read_uint16_le(data: bytes, offset: int) -> int:
    return data[offset] | (data[offset + 1] << 8)


def decode_payload(data: bytes) -> Optional[BleRangeFrame]:
    if len(data) < 18:
        return None
    if data[0] != PAYLOAD_MAGIC or data[1] != PAYLOAD_VERSION:
        return None

    seq = data[2]
    flags = data[3]
    distances_m: List[Optional[float]] = []
    lqi: List[Optional[float]] = []

    for index in range(ANCHOR_COUNT):
        cm = read_uint16_le(data, 4 + index * 2)
        if cm == INVALID_DISTANCE_CM:
            distances_m.append(None)
        else:
            distances_m.append(cm / 100.0)

    for index in range(ANCHOR_COUNT):
        value = data[12 + index]
        if value == INVALID_LQI:
            lqi.append(None)
        else:
            lqi.append(value / 100.0)

    sync_seq: Optional[int] = None
    ages_s: List[Optional[float]] = [None] * ANCHOR_COUNT
    sync_span_s: Optional[float] = None
    if len(data) >= 24:
        sync_seq = data[18]
        ages_s = []
        for index in range(ANCHOR_COUNT):
            age_value = data[19 + index]
            if age_value == 255:
                ages_s.append(None)
            else:
                ages_s.append(age_value / 10.0)

        span_value = data[23]
        if span_value != 255:
            sync_span_s = span_value / 10.0

    return BleRangeFrame(
        seq=seq,
        flags=flags,
        distances_m=distances_m,
        lqi=lqi,
        battery=data[16],
        valid_count=data[17],
        raw_hex=data.hex(),
        paused=bool(flags & 0x10),
        sync_seq=sync_seq,
        ages_s=ages_s,
        sync_span_s=sync_span_s,
    )


def valid_anchor_ranges(
    frame: BleRangeFrame,
    anchors: Sequence[Anchor],
) -> List[Tuple[Anchor, float]]:
    ranges: List[Tuple[Anchor, float]] = []

    for index, distance in enumerate(frame.distances_m):
        if index >= len(anchors) or distance is None:
            continue
        if not (frame.flags & (1 << index)):
            continue
        ranges.append((anchors[index], distance))

    return ranges


def horizontal_distance(range_m: float, anchor_z: float, tag_z: float) -> Optional[float]:
    dz = anchor_z - tag_z
    horizontal_sq = range_m * range_m - dz * dz
    if horizontal_sq < -0.05:
        return None
    return math.sqrt(max(0.0, horizontal_sq))


def solve_linear_system(matrix: List[List[float]], vector: List[float]) -> Optional[List[float]]:
    size = len(vector)
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]

    for col in range(size):
        pivot_row = max(range(col, size), key=lambda row: abs(augmented[row][col]))
        if abs(augmented[pivot_row][col]) < 1e-9:
            return None

        if pivot_row != col:
            augmented[col], augmented[pivot_row] = augmented[pivot_row], augmented[col]

        pivot = augmented[col][col]
        for item in range(col, size + 1):
            augmented[col][item] /= pivot

        for row in range(size):
            if row == col:
                continue
            factor = augmented[row][col]
            if abs(factor) < 1e-12:
                continue
            for item in range(col, size + 1):
                augmented[row][item] -= factor * augmented[col][item]

    return [augmented[row][size] for row in range(size)]


def weighted_centroid_2d(anchor_ranges: Sequence[Tuple[Anchor, float]]) -> Tuple[float, float]:
    total_weight = 0.0
    x = 0.0
    y = 0.0

    for anchor, distance in anchor_ranges:
        weight = 1.0 / max(0.2, distance)
        total_weight += weight
        x += anchor.x * weight
        y += anchor.y * weight

    if total_weight <= 0.0:
        return 0.0, 0.0
    return x / total_weight, y / total_weight


def weighted_centroid_3d(anchor_ranges: Sequence[Tuple[Anchor, float]]) -> Tuple[float, float, float]:
    total_weight = 0.0
    x = 0.0
    y = 0.0
    z = 0.0

    for anchor, distance in anchor_ranges:
        weight = 1.0 / max(0.2, distance)
        total_weight += weight
        x += anchor.x * weight
        y += anchor.y * weight
        z += anchor.z * weight

    if total_weight <= 0.0:
        return 0.0, 0.0, 0.0
    return x / total_weight, y / total_weight, z / total_weight


def residual_rms_2d(x: float, y: float, anchor_ranges: Sequence[Tuple[Anchor, float]]) -> float:
    if not anchor_ranges:
        return float("inf")

    total = 0.0
    for anchor, distance in anchor_ranges:
        predicted = math.hypot(x - anchor.x, y - anchor.y)
        total += (predicted - distance) ** 2
    return math.sqrt(total / len(anchor_ranges))


def residual_rms_3d(
    x: float,
    y: float,
    z: float,
    anchor_ranges: Sequence[Tuple[Anchor, float]],
) -> float:
    if not anchor_ranges:
        return float("inf")

    total = 0.0
    for anchor, distance in anchor_ranges:
        predicted = math.sqrt((x - anchor.x) ** 2 + (y - anchor.y) ** 2 + (z - anchor.z) ** 2)
        total += (predicted - distance) ** 2
    return math.sqrt(total / len(anchor_ranges))


def solve_position_2d(
    anchor_ranges: Sequence[Tuple[Anchor, float]],
    tag_z: float,
) -> Optional[Tuple[float, float, float, float]]:
    horizontal_ranges: List[Tuple[Anchor, float]] = []

    for anchor, distance in anchor_ranges:
        horizontal = horizontal_distance(distance, anchor.z, tag_z)
        if horizontal is not None:
            horizontal_ranges.append((anchor, horizontal))

    if len(horizontal_ranges) < 3:
        return None

    x, y = weighted_centroid_2d(horizontal_ranges)
    for _ in range(24):
        h00 = 0.0
        h01 = 0.0
        h11 = 0.0
        g0 = 0.0
        g1 = 0.0

        for anchor, distance in horizontal_ranges:
            dx = x - anchor.x
            dy = y - anchor.y
            predicted = max(1e-6, math.hypot(dx, dy))
            residual = predicted - distance
            j0 = dx / predicted
            j1 = dy / predicted
            weight = 1.0 / max(0.2, distance)

            h00 += weight * j0 * j0
            h01 += weight * j0 * j1
            h11 += weight * j1 * j1
            g0 += weight * j0 * residual
            g1 += weight * j1 * residual

        step = solve_linear_system(
            [[h00 + 1e-6, h01], [h01, h11 + 1e-6]],
            [g0, g1],
        )
        if step is None:
            return None

        x -= step[0]
        y -= step[1]
        if math.hypot(step[0], step[1]) < 1e-4:
            break

    return x, y, tag_z, residual_rms_2d(x, y, horizontal_ranges)


def solve_position_3d(
    anchor_ranges: Sequence[Tuple[Anchor, float]],
) -> Optional[Tuple[float, float, float, float]]:
    if len(anchor_ranges) < 4:
        return None

    x, y, z = weighted_centroid_3d(anchor_ranges)
    for _ in range(32):
        h = [[0.0, 0.0, 0.0] for _ in range(3)]
        g = [0.0, 0.0, 0.0]

        for anchor, distance in anchor_ranges:
            dx = x - anchor.x
            dy = y - anchor.y
            dz = z - anchor.z
            predicted = max(1e-6, math.sqrt(dx * dx + dy * dy + dz * dz))
            residual = predicted - distance
            jacobian = [dx / predicted, dy / predicted, dz / predicted]
            weight = 1.0 / max(0.2, distance)

            for row in range(3):
                g[row] += weight * jacobian[row] * residual
                for col in range(3):
                    h[row][col] += weight * jacobian[row] * jacobian[col]

        for row in range(3):
            h[row][row] += 1e-6

        step = solve_linear_system(h, g)
        if step is None:
            return None

        x -= step[0]
        y -= step[1]
        z -= step[2]
        if math.sqrt(step[0] ** 2 + step[1] ** 2 + step[2] ** 2) < 1e-4:
            break

    return x, y, z, residual_rms_3d(x, y, z, anchor_ranges)


def solve_position(
    frame: BleRangeFrame,
    config: ReceiverConfig,
    min_valid_anchors: int = 3,
) -> Optional[Tuple[float, float, float, float, List[Tuple[Anchor, float]]]]:
    ranges = valid_anchor_ranges(frame, config.anchors)
    if len(ranges) < min_valid_anchors:
        return None

    if config.mode == "3d":
        solved = solve_position_3d(ranges)
    else:
        solved = solve_position_2d(ranges, config.tag_z)

    if solved is None:
        return None

    x, y, z, residual = solved
    return x, y, z, residual, ranges


def format_ranges(frame: BleRangeFrame, config: ReceiverConfig) -> str:
    parts: List[str] = []
    for index, anchor in enumerate(config.anchors):
        distance = frame.distances_m[index]
        flag_ok = bool(frame.flags & (1 << index))
        if distance is None or not flag_ok:
            parts.append(f"{anchor.name}=--")
        else:
            parts.append(f"{anchor.name}={distance:.2f}m")
    return ", ".join(parts)


def format_diagnostics(frame: BleRangeFrame, config: ReceiverConfig) -> str:
    if frame.sync_seq is None:
        return ""

    age_parts: List[str] = []
    for index, anchor in enumerate(config.anchors):
        age = frame.ages_s[index] if index < len(frame.ages_s) else None
        if age is None:
            age_parts.append(f"{anchor.name}=--")
        else:
            age_parts.append(f"{anchor.name}={age:.1f}s")

    sync_label = "--" if frame.sync_seq == 0 else f"{frame.sync_seq:03d}"
    span_label = "--" if frame.sync_span_s is None else f"{frame.sync_span_s:.1f}s"
    return f"sync={sync_label} span={span_label} ages=" + ",".join(age_parts)


def print_frame(
    frame: BleRangeFrame,
    config: ReceiverConfig,
    source: str,
    print_raw: bool,
    min_valid_anchors: int = 3,
) -> Optional[Tuple[float, float]]:
    solved = solve_position(frame, config, min_valid_anchors)
    status = "paused" if frame.paused else "running"
    print(
        f"[ble] {source} adv={frame.seq:03d} {status} "
        f"valid={frame.valid_count}/{ANCHOR_COUNT} battery={frame.battery}% "
        f"{format_ranges(frame, config)} {format_diagnostics(frame, config)}"
    )

    if solved is None:
        print(f"[position] waiting for enough valid anchors ({frame.valid_count}/{min_valid_anchors})")
        if print_raw:
            print(f"[raw] {frame.raw_hex}")
        return None

    x, y, z, residual, used_ranges = solved
    used_names = ",".join(anchor.name for anchor, _ in used_ranges)
    print(
        f"[position] x={x:.3f}, y={y:.3f}, z={z:.3f}, "
        f"residual={residual:.3f}m, used={used_names}"
    )

    if print_raw:
        print(f"[raw] {frame.raw_hex}")

    return x, y


class LivePlot:
    def __init__(self, anchors: Sequence[Anchor]) -> None:
        try:
            import matplotlib.pyplot as plt
        except ImportError as exc:
            raise SystemExit("matplotlib is not installed. Run: python -m pip install matplotlib") from exc

        self.plt = plt
        self.history_x: List[float] = []
        self.history_y: List[float] = []

        plt.ion()
        self.fig, self.ax = plt.subplots()
        self.ax.set_title("Estimote UWB BLE Live Position")
        self.ax.set_xlabel("X (m)")
        self.ax.set_ylabel("Y (m)")
        self.ax.grid(True, linestyle="--", alpha=0.35)
        self.ax.set_aspect("equal", adjustable="box")

        self.ax.scatter([anchor.x for anchor in anchors], [anchor.y for anchor in anchors], marker="^", s=90)
        for anchor in anchors:
            self.ax.annotate(anchor.name, (anchor.x, anchor.y), xytext=(5, 5), textcoords="offset points")

        self.path_plot, = self.ax.plot([], [], "-", linewidth=1.0, alpha=0.45)
        self.tag_plot = self.ax.scatter([], [], marker="o", s=90)
        self.reset_limits(anchors)
        plt.show(block=False)

    def reset_limits(self, anchors: Iterable[Anchor]) -> None:
        xs = [anchor.x for anchor in anchors]
        ys = [anchor.y for anchor in anchors]
        margin = 1.0
        self.ax.set_xlim(min(xs) - margin, max(xs) + margin)
        self.ax.set_ylim(min(ys) - margin, max(ys) + margin)

    def update(self, x: float, y: float) -> None:
        self.history_x.append(x)
        self.history_y.append(y)
        self.history_x = self.history_x[-200:]
        self.history_y = self.history_y[-200:]
        self.path_plot.set_data(self.history_x, self.history_y)
        self.tag_plot.set_offsets([[x, y]])
        self.plt.pause(0.001)


async def scan_ble(args: argparse.Namespace, config: ReceiverConfig) -> None:
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise SystemExit("bleak is not installed. Run: python -m pip install bleak") from exc

    prepare_windows_ble_thread(allow_gui_sta=args.plot)
    plot = LivePlot(config.anchors) if args.plot else None
    prepare_windows_ble_thread(allow_gui_sta=args.plot)
    last_print_at_by_source: Dict[str, float] = {}
    last_plot_at_by_source: Dict[str, float] = {}
    last_seq_by_source: Dict[str, int] = {}
    last_plot_sync_seq_by_source: Dict[str, int] = {}

    def callback(device: object, advertisement_data: object) -> None:
        service_data = getattr(advertisement_data, "service_data", {}) or {}
        source = getattr(device, "address", "unknown")
        name = getattr(device, "name", "") or ""

        for uuid, data in service_data.items():
            if not service_uuid_matches(str(uuid), config.service_uuid):
                continue

            frame = decode_payload(bytes(data))
            if frame is None:
                continue

            source_key = str(source)
            if last_seq_by_source.get(source_key) == frame.seq:
                return
            last_seq_by_source[source_key] = frame.seq

            now = time.monotonic()
            if plot is not None:
                solved = solve_position(frame, config, args.min_valid_anchors)
                if solved is not None:
                    sync_seq = frame.sync_seq
                    already_plotted = (
                        sync_seq is not None
                        and sync_seq != 0
                        and last_plot_sync_seq_by_source.get(source_key) == sync_seq
                    )
                    if not already_plotted and (
                        args.plot_interval <= 0
                        or now - last_plot_at_by_source.get(source_key, 0.0) >= args.plot_interval
                    ):
                        x, y, _z, _residual, _used_ranges = solved
                        plot.update(x, y)
                        last_plot_at_by_source[source_key] = now
                        if sync_seq is not None and sync_seq != 0:
                            last_plot_sync_seq_by_source[source_key] = sync_seq

            if now - last_print_at_by_source.get(source_key, 0.0) < args.print_interval:
                return
            last_print_at_by_source[source_key] = now

            source_label = str(source)
            if name:
                source_label += " " + name

            print_frame(frame, config, source_label, args.print_raw, args.min_valid_anchors)

    print(f"Scanning BLE Service Data UUID {config.service_uuid}. Press Ctrl+C to stop.")
    async with BleakScanner(callback):
        while True:
            await asyncio.sleep(1.0)


def run_sample(args: argparse.Namespace, config: ReceiverConfig) -> None:
    try:
        data = bytes.fromhex(args.sample)
    except ValueError as exc:
        raise SystemExit("sample must be a hex string") from exc

    frame = decode_payload(data)
    if frame is None:
        raise SystemExit("sample payload is not a valid Estimote FE9A payload")

    print_frame(frame, config, "sample", True, args.min_valid_anchors)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Receive Estimote UWB ranges from BLE and estimate position.")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help=f"Default: {DEFAULT_CONFIG}")
    parser.add_argument("--mode", choices=["2d", "3d"], default="", help="Override config mode.")
    parser.add_argument("--tag-z", type=float, default=None, help="Override config tag_z for 2D mode.")
    parser.add_argument("--plot", action="store_true", help="Show live XY plot.")
    parser.add_argument("--print-raw", action="store_true", help="Print raw FE9A payload hex.")
    parser.add_argument("--print-interval", type=float, default=0.1, help="Minimum seconds between printed frames per tag.")
    parser.add_argument("--plot-interval", type=float, default=0.0, help="Minimum seconds between plotted frames per tag. Default: every solved BLE frame.")
    parser.add_argument("--min-valid-anchors", type=int, default=4, choices=[3, 4], help="Minimum valid anchors required for position output. Default: 4.")
    parser.add_argument("--sample", default="", help="Decode one payload hex string and exit.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = load_config(Path(args.config))

    if args.mode:
        config = ReceiverConfig(
            service_uuid=config.service_uuid,
            mode=args.mode,
            tag_z=config.tag_z,
            anchors=config.anchors,
        )

    if args.tag_z is not None:
        config = ReceiverConfig(
            service_uuid=config.service_uuid,
            mode=config.mode,
            tag_z=args.tag_z,
            anchors=config.anchors,
        )

    if args.sample:
        run_sample(args, config)
        return

    try:
        asyncio.run(scan_ble(args, config))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
