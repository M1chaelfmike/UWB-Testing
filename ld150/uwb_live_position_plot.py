"""
Live LD150 UWB position plotter.

What it does:
  1. Ask for A0-A3 anchor coordinates as X Y Z.
  2. Read LD150 "mc" serial frames.
  3. Decode A0-A3 ranges.
  4. Estimate the tag XY position with a fixed tag Z.
  5. Print raw/decoded data and update a live 2D plot.

Usage:
  python uwb_live_position_plot.py --list-ports
  python uwb_live_position_plot.py --port COM7
  python uwb_live_position_plot.py --port COM7 --min-anchors 4

Install dependencies if needed:
  python -m pip install pyserial matplotlib
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import math
import re
from typing import Dict, Iterable, List, Optional, Tuple

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


ANCHOR_TAG_PATTERN = re.compile(r"^a([0-9a-fA-F]+):([0-9a-fA-F]+)$")
RANGE_TOKEN_COUNT = 4
MIN_2D_ANCHORS = 3


@dataclass(frozen=True)
class Anchor:
    index: int
    x: float
    y: float
    z: float


@dataclass(frozen=True)
class McFrame:
    reporting_anchor: int
    tag_id: int
    distances_m: Dict[int, float]
    raw: str


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
    raw = line.strip()
    parts = raw.split()
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
        raw=raw,
    )


def parse_xyz(value: str) -> Tuple[float, float, float]:
    normalized = value.replace(",", " ").strip()
    parts = [part for part in normalized.split() if part]
    if len(parts) != 3:
        raise ValueError("please enter exactly 3 numbers: x y z")
    return float(parts[0]), float(parts[1]), float(parts[2])


def parse_min_anchors(value: str) -> Optional[int]:
    normalized = value.strip().lower()
    if normalized in {"auto", "dynamic"}:
        return None

    try:
        parsed = int(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "min anchors must be auto, 3, or 4"
        ) from exc

    if parsed < MIN_2D_ANCHORS or parsed > RANGE_TOKEN_COUNT:
        raise argparse.ArgumentTypeError("min anchors must be auto, 3, or 4")
    return parsed


def required_anchor_count(min_anchors: Optional[int]) -> int:
    return MIN_2D_ANCHORS if min_anchors is None else min_anchors


def min_anchor_mode_label(min_anchors: Optional[int]) -> str:
    if min_anchors is None:
        return "auto (use every valid range; solve when at least 3 anchors are valid)"
    return f"strict {min_anchors}"


def prompt_anchors() -> Dict[int, Anchor]:
    print("Enter anchor coordinates in meters. Format: x y z")
    print("Example: 0 0 0.9")

    anchors: Dict[int, Anchor] = {}
    for index in range(RANGE_TOKEN_COUNT):
        while True:
            try:
                value = input(f"A{index} XYZ > ")
                x, y, z = parse_xyz(value)
                anchors[index] = Anchor(index=index, x=x, y=y, z=z)
                break
            except ValueError as exc:
                print(f"Invalid A{index} coordinate: {exc}")

    return anchors


def prompt_tag_z(anchors: Dict[int, Anchor]) -> float:
    default_z = sum(anchor.z for anchor in anchors.values()) / len(anchors)
    while True:
        value = input(f"Tag Z in meters [default {default_z:.3f}] > ").strip()
        if not value:
            return default_z
        try:
            parsed = float(value)
            if math.isfinite(parsed):
                return parsed
        except ValueError:
            pass
        print("Invalid tag Z. Please enter one number, for example: 0.9")


def horizontal_distance(range_m: float, anchor_z: float, tag_z: float) -> Optional[float]:
    dz = anchor_z - tag_z
    horizontal_sq = range_m * range_m - dz * dz
    if horizontal_sq < -0.05:
        return None
    return math.sqrt(max(0.0, horizontal_sq))


def weighted_centroid(anchor_ranges: List[Tuple[Anchor, float]]) -> Tuple[float, float]:
    weighted_x = 0.0
    weighted_y = 0.0
    total_weight = 0.0

    for anchor, distance in anchor_ranges:
        weight = 1.0 / max(0.2, distance)
        weighted_x += anchor.x * weight
        weighted_y += anchor.y * weight
        total_weight += weight

    if total_weight <= 0.0:
        return 0.0, 0.0
    return weighted_x / total_weight, weighted_y / total_weight


def solve_2x2(
    a: float,
    b: float,
    c: float,
    d: float,
    e: float,
    f: float,
) -> Optional[Tuple[float, float]]:
    det = a * d - b * c
    if abs(det) < 1e-9:
        return None
    return (e * d - b * f) / det, (a * f - e * c) / det


def residual_rms(x: float, y: float, anchor_ranges: List[Tuple[Anchor, float]]) -> float:
    if not anchor_ranges:
        return float("inf")

    total = 0.0
    for anchor, distance in anchor_ranges:
        predicted = math.hypot(x - anchor.x, y - anchor.y)
        total += (predicted - distance) ** 2
    return math.sqrt(total / len(anchor_ranges))


def trilaterate_xy(anchor_ranges: List[Tuple[Anchor, float]]) -> Optional[Tuple[float, float, float]]:
    if len(anchor_ranges) < 3:
        return None

    x, y = weighted_centroid(anchor_ranges)

    for _ in range(24):
        h00 = 0.0
        h01 = 0.0
        h11 = 0.0
        g0 = 0.0
        g1 = 0.0

        for anchor, distance in anchor_ranges:
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

        step = solve_2x2(h00 + 1e-6, h01, h01, h11 + 1e-6, g0, g1)
        if step is None:
            return None

        dx, dy = step
        x -= dx
        y -= dy
        if math.hypot(dx, dy) < 1e-4:
            break

    return x, y, residual_rms(x, y, anchor_ranges)


def estimate_position(
    frame: McFrame,
    anchors: Dict[int, Anchor],
    tag_z: float,
    min_anchors: Optional[int],
) -> Optional[Tuple[float, float, float, List[Tuple[Anchor, float]]]]:
    anchor_ranges: List[Tuple[Anchor, float]] = []

    for index, range_m in frame.distances_m.items():
        anchor = anchors.get(index)
        if anchor is None:
            continue

        horizontal_m = horizontal_distance(range_m, anchor.z, tag_z)
        if horizontal_m is None:
            continue

        anchor_ranges.append((anchor, horizontal_m))

    anchor_ranges.sort(key=lambda item: item[0].index)
    if len(anchor_ranges) < required_anchor_count(min_anchors):
        return None

    solved = trilaterate_xy(anchor_ranges)
    if solved is None:
        return None

    x, y, residual = solved
    return x, y, residual, anchor_ranges


class LivePlot:
    def __init__(self, anchors: Dict[int, Anchor]) -> None:
        try:
            import matplotlib.pyplot as plt
        except ImportError as exc:
            raise SystemExit(
                "matplotlib is not installed. Run: python -m pip install matplotlib"
            ) from exc

        self.plt = plt
        self.history_x: List[float] = []
        self.history_y: List[float] = []

        plt.ion()
        self.fig, self.ax = plt.subplots()
        self.ax.set_title("LD150 UWB Live Position")
        self.ax.set_xlabel("X (m)")
        self.ax.set_ylabel("Y (m)")
        self.ax.grid(True, linestyle="--", alpha=0.35)
        self.ax.set_aspect("equal", adjustable="box")

        anchor_x = [anchor.x for anchor in anchors.values()]
        anchor_y = [anchor.y for anchor in anchors.values()]
        self.ax.scatter(anchor_x, anchor_y, marker="^", s=90, label="Anchors")

        for anchor in anchors.values():
            self.ax.annotate(
                f"A{anchor.index}",
                (anchor.x, anchor.y),
                xytext=(5, 5),
                textcoords="offset points",
            )

        self.path_plot, = self.ax.plot([], [], "-", linewidth=1.0, alpha=0.45, label="Path")
        self.tag_plot = self.ax.scatter([], [], marker="o", s=90, label="Tag")
        self.info_text = self.ax.text(
            0.02,
            0.98,
            "",
            transform=self.ax.transAxes,
            va="top",
            ha="left",
        )
        self.ax.legend(loc="best")
        self.reset_limits(anchors.values())
        plt.show(block=False)

    def reset_limits(self, anchors: Iterable[Anchor]) -> None:
        xs = [anchor.x for anchor in anchors]
        ys = [anchor.y for anchor in anchors]
        if not xs or not ys:
            return
        margin = 1.0
        self.ax.set_xlim(min(xs) - margin, max(xs) + margin)
        self.ax.set_ylim(min(ys) - margin, max(ys) + margin)

    def update(self, x: float, y: float, tag_z: float, residual: float, tag_id: int) -> None:
        self.history_x.append(x)
        self.history_y.append(y)
        if len(self.history_x) > 200:
            self.history_x = self.history_x[-200:]
            self.history_y = self.history_y[-200:]

        self.path_plot.set_data(self.history_x, self.history_y)
        self.tag_plot.set_offsets([[x, y]])
        self.info_text.set_text(
            f"T{tag_id}: x={x:.3f}, y={y:.3f}, z={tag_z:.3f}\n"
            f"residual={residual:.3f} m"
        )

        self.ax.relim()
        self.ax.autoscale_view()
        self.plt.pause(0.001)


def print_frame_result(
    frame: McFrame,
    tag_z: float,
    x: float,
    y: float,
    residual: float,
    used_ranges: List[Tuple[Anchor, float]],
) -> None:
    raw_distances = ", ".join(
        f"A{index}={distance:.3f}m"
        for index, distance in sorted(frame.distances_m.items())
    )
    horizontal_distances = ", ".join(
        f"A{anchor.index}={distance:.3f}m"
        for anchor, distance in used_ranges
    )
    print(f"[raw] {frame.raw}")
    print(f"[range] {raw_distances}")
    print(f"[horizontal] {horizontal_distances}")
    print(
        f"[position] T{frame.tag_id}: "
        f"x={x:.3f}, y={y:.3f}, z={tag_z:.3f}, residual={residual:.3f}m"
    )


def list_serial_devices() -> None:
    if list_ports is None:
        raise SystemExit("pyserial is not installed. Run: python -m pip install pyserial")

    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports found.")
        return

    for port in ports:
        print(f"{port.device}\t{port.description}")


def smooth_position(
    previous: Optional[Tuple[float, float]],
    current: Tuple[float, float],
    alpha: float,
) -> Tuple[float, float]:
    alpha = min(1.0, max(0.0, alpha))
    if previous is None or alpha >= 1.0:
        return current

    return (
        alpha * current[0] + (1.0 - alpha) * previous[0],
        alpha * current[1] + (1.0 - alpha) * previous[1],
    )


def run(args: argparse.Namespace) -> None:
    if serial is None:
        raise SystemExit("pyserial is not installed. Run: python -m pip install pyserial")

    anchors = prompt_anchors()
    tag_z = args.tag_z if args.tag_z is not None else prompt_tag_z(anchors)
    plot = LivePlot(anchors)

    last_position: Optional[Tuple[float, float]] = None
    print(f"Opening {args.port} @ {args.baud} baud. Press Ctrl+C to stop.")
    print(f"Anchor mode: {min_anchor_mode_label(args.min_anchors)}")

    with serial.Serial(port=args.port, baudrate=args.baud, timeout=args.timeout) as ser:
        while True:
            raw_bytes = ser.readline()
            if not raw_bytes:
                continue

            line = raw_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            frame = parse_mc_frame(line)
            if frame is None:
                if args.print_all:
                    print(f"[raw] {line}")
                continue

            result = estimate_position(
                frame=frame,
                anchors=anchors,
                tag_z=tag_z,
                min_anchors=args.min_anchors,
            )
            if result is None:
                print(f"[raw] {frame.raw}")
                print(
                    f"[wait] valid ranges {len(frame.distances_m)}/"
                    f"{required_anchor_count(args.min_anchors)}; "
                    "cannot solve position yet"
                )
                continue

            x, y, residual, used_ranges = result
            x, y = smooth_position(last_position, (x, y), args.smooth_alpha)
            last_position = (x, y)

            print_frame_result(frame, tag_z, x, y, residual, used_ranges)
            plot.update(x, y, tag_z, residual, frame.tag_id)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Live 2D plot for LD150 UWB serial data.")
    parser.add_argument("--port", default="", help="Serial port, for example COM7.")
    parser.add_argument("--baud", type=int, default=115200, help="Default: 115200.")
    parser.add_argument("--timeout", type=float, default=1.0, help="Serial timeout seconds.")
    parser.add_argument("--tag-z", type=float, default=None, help="Known tag height in meters.")
    parser.add_argument(
        "--min-anchors",
        type=parse_min_anchors,
        default=None,
        help="Default: auto. Use 4 for strict four-anchor mode, or 3 to allow fallback.",
    )
    parser.add_argument("--smooth-alpha", type=float, default=0.35, help="0-1, higher is faster.")
    parser.add_argument("--print-all", action="store_true", help="Print non-mc serial lines too.")
    parser.add_argument("--list-ports", action="store_true", help="List available serial ports.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.list_ports:
        list_serial_devices()
        return

    if not args.port:
        raise SystemExit("Missing --port. Example: python uwb_live_position_plot.py --port COM7")

    try:
        run(args)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
