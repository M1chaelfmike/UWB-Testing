"""
HTTP receiver for the Galaxy Watch Estimote BLE gateway.

Run on the PC at 192.168.0.2 from the repository root:
  python estimote/pc/watch_http_receiver.py --host 0.0.0.0 --port 8088
  python estimote/pc/watch_http_receiver.py --host 0.0.0.0 --port 8088 --plot

The watch can post raw_hex-only frames or decoded FE9A fields to:
  http://192.168.0.2:8088/estimote
"""

from __future__ import annotations

import argparse
import csv
import json
import queue
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from estimote_ble_position_receiver import (
    ANCHOR_COUNT,
    DEFAULT_CONFIG,
    BleRangeFrame,
    LivePlot,
    ReceiverConfig,
    anchor_label_from_code,
    decode_payload,
    load_config,
    normalize_anchor_label,
    should_update_plot,
    solve_position,
)


ANCHOR_LABEL_FIELDS = ["121", "099", "085", "087", "086", "105"]

BASE_FIELDNAMES = [
    "timestamp_iso",
    "local_time",
    "client_ip",
    "source",
    "device_name",
    "rssi",
    "adv_seq",
    "adv_delta",
    "sync_seq",
    "sync_delta",
    "paused",
    "valid_count",
    "battery",
    "sync_span_s",
    "x",
    "y",
    "z",
    "residual",
    "used",
    "raw_hex",
]

SLOT_FIELDNAMES = (
    [f"anchor_{index}" for index in range(1, ANCHOR_COUNT + 1)]
    + [f"d_{index}_m" for index in range(1, ANCHOR_COUNT + 1)]
    + [f"age_{index}_s" for index in range(1, ANCHOR_COUNT + 1)]
    + [f"lqi_{index}" for index in range(1, ANCHOR_COUNT + 1)]
)

NAMED_ANCHOR_FIELDNAMES = (
    [f"d_{label}_m" for label in ANCHOR_LABEL_FIELDS]
    + [f"age_{label}_s" for label in ANCHOR_LABEL_FIELDS]
    + [f"lqi_{label}" for label in ANCHOR_LABEL_FIELDS]
)

FIELDNAMES = BASE_FIELDNAMES + SLOT_FIELDNAMES + NAMED_ANCHOR_FIELDNAMES + [
    "watch_time_iso",
    "watch_time_ms",
]


def delta_u8(current: Optional[int], previous: Optional[int]) -> str:
    if current is None or previous is None:
        return ""
    return str((current - previous) % 256)


def default_csv_path() -> Path:
    output_dir = Path(__file__).resolve().parent / "logs"
    output_dir.mkdir(exist_ok=True)
    return output_dir / f"watch_ble_http_{time.strftime('%Y%m%d_%H%M%S')}.csv"


def local_timestamp() -> datetime:
    return datetime.now().astimezone()


def fmt_iso(timestamp: datetime) -> str:
    return timestamp.isoformat(timespec="milliseconds")


def fmt_local(timestamp: datetime) -> str:
    return timestamp.strftime("%H:%M:%S.%f")[:-3]


def as_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def array_value(values: Any, index: int) -> str:
    if not isinstance(values, list) or index >= len(values):
        return ""
    value = values[index]
    if value is None:
        return ""
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def optional_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def optional_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "paused"}
    return bool(value)


def optional_float_array(values: Any, count: int) -> List[Optional[float]]:
    result: List[Optional[float]] = []
    for index in range(count):
        if isinstance(values, list) and index < len(values):
            result.append(optional_float(values[index]))
        else:
            result.append(None)
    return result


def frame_from_raw_hex(body: Dict[str, Any]) -> Optional[BleRangeFrame]:
    raw_hex = str(body.get("raw_hex") or "").strip()
    if not raw_hex:
        return None

    try:
        return decode_payload(bytes.fromhex(raw_hex))
    except ValueError:
        return None


def optional_int_array(values: Any, count: int) -> List[Optional[int]]:
    result: List[Optional[int]] = []
    for index in range(count):
        value = values[index] if isinstance(values, list) and index < len(values) else None
        result.append(as_int(value))
    return result


def label_for_slot(anchor_codes: List[Optional[int]], anchor_labels: Any, index: int) -> str:
    if isinstance(anchor_labels, list) and index < len(anchor_labels):
        label = anchor_labels[index]
        if label is not None and str(label).strip():
            return str(label).strip()

    code = anchor_codes[index] if index < len(anchor_codes) else None
    return anchor_label_from_code(code)


def label_field_key(label: str) -> str:
    key = normalize_anchor_label(label)
    for known in ANCHOR_LABEL_FIELDS:
        if normalize_anchor_label(known) == key:
            return known
    return ""


def bump_counter(counter: Dict[str, int], key: str, amount: int = 1) -> None:
    counter[key] = counter.get(key, 0) + amount


def build_frame_from_watch_body(body: Dict[str, Any]) -> BleRangeFrame:
    raw_frame = frame_from_raw_hex(body)
    if raw_frame is not None:
        return raw_frame

    distances = optional_float_array(body.get("distances_m"), ANCHOR_COUNT)
    lqi = optional_float_array(body.get("lqi"), ANCHOR_COUNT)
    ages = optional_float_array(body.get("ages_s"), ANCHOR_COUNT)
    anchor_codes = optional_int_array(body.get("anchor_codes"), ANCHOR_COUNT)
    paused = optional_bool(body.get("paused"))
    valid_count = as_int(body.get("valid_count")) or 0
    flags = as_int(body.get("flags"))

    if flags is None:
        flags = 16 if paused else 0
        for index, distance in enumerate(distances):
            if distance is not None:
                flags |= 1 << index

    return BleRangeFrame(
        seq=as_int(body.get("adv_seq")) or 0,
        flags=flags,
        anchor_codes=anchor_codes,
        distances_m=distances,
        lqi=lqi,
        battery=as_int(body.get("battery")) or 0,
        valid_count=valid_count,
        raw_hex=str(body.get("raw_hex") or ""),
        paused=paused,
        sync_seq=as_int(body.get("sync_seq")),
        ages_s=ages,
        sync_span_s=optional_float(body.get("sync_span_s")),
    )


class WatchFrameStore:
    def __init__(
        self,
        csv_path: Path,
        quiet: bool,
        config: Optional[ReceiverConfig],
        plot: Optional[LivePlot],
        min_valid_anchors: int,
        plot_interval: float,
        max_age_ms: int,
        stats_interval: float,
    ) -> None:
        self.csv_path = csv_path
        self.quiet = quiet
        self.config = config
        self.plot = plot
        self.min_valid_anchors = min_valid_anchors
        self.plot_interval = plot_interval
        self.max_age_ms = max_age_ms
        self.stats_interval = stats_interval
        self.csv_file = csv_path.open("w", newline="", encoding="utf-8")
        self.writer = csv.DictWriter(self.csv_file, fieldnames=FIELDNAMES)
        self.writer.writeheader()
        self.rows = 0
        self.stale_drops = 0
        self.solved_rows = 0
        self.unsolved_rows = 0
        self.anchor_seen: Dict[str, int] = {}
        self.anchor_missing: Dict[str, int] = {}
        self.anchor_used: Dict[str, int] = {}
        self.failure_reasons: Dict[str, int] = {}
        self.last_stats_at = time.monotonic()
        self.last_adv_by_source: Dict[str, int] = {}
        self.last_sync_by_source: Dict[str, int] = {}
        self.last_plot_at_by_source: Dict[str, float] = {}
        self.last_plot_sync_seq_by_source: Dict[str, int] = {}
        self.plot_queue: Optional[queue.SimpleQueue[Tuple[float, float]]] = (
            queue.SimpleQueue() if plot is not None else None
        )

    def close(self) -> None:
        self.csv_file.flush()
        self.csv_file.close()

    def write_frame(self, client_ip: str, body: Dict[str, Any]) -> Dict[str, str]:
        now = local_timestamp()
        source = str(body.get("source") or client_ip)
        watch_time_ms = as_int(body.get("watch_time_ms"))
        if self.max_age_ms > 0 and watch_time_ms is not None:
            age_ms = int(time.time() * 1000) - watch_time_ms
            if age_ms > self.max_age_ms:
                self.stale_drops += 1
                if not self.quiet:
                    print(
                        f"[{fmt_local(now)}] drop stale src={source} "
                        f"age_ms={age_ms} max_age_ms={self.max_age_ms}"
                    )
                return {}

        frame = build_frame_from_watch_body(body)
        adv_seq = frame.seq
        sync_seq = frame.sync_seq

        previous_adv = self.last_adv_by_source.get(source)
        previous_sync = self.last_sync_by_source.get(source)
        self.last_adv_by_source[source] = adv_seq
        if sync_seq is not None:
            self.last_sync_by_source[source] = sync_seq

        anchor_labels = body.get("anchor_labels")
        solved = solve_position(frame, self.config, self.min_valid_anchors) if self.config is not None else None
        used_names: List[str] = []

        row = {
            "timestamp_iso": fmt_iso(now),
            "local_time": fmt_local(now),
            "client_ip": client_ip,
            "source": source,
            "device_name": str(body.get("device_name") or ""),
            "rssi": str(body.get("rssi") or ""),
            "adv_seq": str(adv_seq),
            "adv_delta": delta_u8(adv_seq, previous_adv),
            "sync_seq": "" if sync_seq is None else str(sync_seq),
            "sync_delta": delta_u8(sync_seq, previous_sync),
            "paused": str(frame.paused),
            "valid_count": str(frame.valid_count),
            "battery": str(frame.battery),
            "sync_span_s": "" if frame.sync_span_s is None else str(frame.sync_span_s),
            "x": "",
            "y": "",
            "z": "",
            "residual": "",
            "used": "",
            "raw_hex": frame.raw_hex,
            "watch_time_iso": str(body.get("watch_time_iso") or ""),
            "watch_time_ms": str(body.get("watch_time_ms") or ""),
        }

        for label in ANCHOR_LABEL_FIELDS:
            row[f"d_{label}_m"] = ""
            row[f"age_{label}_s"] = ""
            row[f"lqi_{label}"] = ""

        if solved is not None:
            x, y, z, residual, used_ranges = solved
            used_names = [anchor.name for anchor, _ in used_ranges]
            row["x"] = f"{x:.3f}"
            row["y"] = f"{y:.3f}"
            row["z"] = f"{z:.3f}"
            row["residual"] = f"{residual:.3f}"
            row["used"] = ",".join(used_names)
            self.update_plot(source, frame, x, y)

        slot_labels: List[str] = []
        valid_labels: List[str] = []
        for index in range(ANCHOR_COUNT):
            label = label_for_slot(frame.anchor_codes, anchor_labels, index)
            slot_labels.append(label)
            row[f"anchor_{index + 1}"] = label
            row[f"d_{index + 1}_m"] = array_value(frame.distances_m, index)
            row[f"age_{index + 1}_s"] = array_value(frame.ages_s, index)
            row[f"lqi_{index + 1}"] = array_value(frame.lqi, index)

            if frame.distances_m[index] is not None and bool(frame.flags & (1 << index)):
                valid_labels.append(label)

            label_key = label_field_key(label)
            if label_key:
                row[f"d_{label_key}_m"] = array_value(frame.distances_m, index)
                row[f"age_{label_key}_s"] = array_value(frame.ages_s, index)
                row[f"lqi_{label_key}"] = array_value(frame.lqi, index)

        failure_reason = ""
        if solved is None:
            failure_reason = self.failure_reason(frame, valid_labels)

        self.record_health(slot_labels, valid_labels, used_names, failure_reason)
        self.writer.writerow(row)
        self.csv_file.flush()
        self.rows += 1

        if not self.quiet:
            status = "ok" if solved is not None else failure_reason
            print(
                f"[{row['local_time']}] src={source} adv={row['adv_seq'] or '--'} "
                f"d={row['adv_delta'] or '--'} sync={row['sync_seq'] or '--'} "
                f"sd={row['sync_delta'] or '--'} valid={row['valid_count'] or '--'}/4 "
                f"anchors={row['anchor_1'] or '--'},{row['anchor_2'] or '--'},{row['anchor_3'] or '--'},{row['anchor_4'] or '--'} "
                f"rssi={row['rssi'] or '--'} "
                f"pos={row['x'] or '--'},{row['y'] or '--'} res={row['residual'] or '--'} "
                f"status={status}"
            )

        self.maybe_print_health()
        return row

    def failure_reason(self, frame: BleRangeFrame, valid_labels: List[str]) -> str:
        if self.config is None:
            return "position_disabled"
        if frame.paused:
            return "tag_paused"
        if len(valid_labels) < self.min_valid_anchors:
            missing = [label for label in self.known_anchor_labels() if label not in valid_labels]
            missing_text = ",".join(missing) if missing else "unknown"
            return f"need_{self.min_valid_anchors}_anchors_valid_{len(valid_labels)}_missing_{missing_text}"
        return "solver_failed"

    def known_anchor_labels(self) -> List[str]:
        if self.config is None:
            return []
        return [anchor.name for anchor in self.config.anchors]

    def record_health(
        self,
        slot_labels: List[str],
        valid_labels: List[str],
        used_names: List[str],
        failure_reason: str,
    ) -> None:
        valid_set = set(valid_labels)
        known_labels = set(self.known_anchor_labels())

        for label in known_labels:
            if label in valid_set:
                bump_counter(self.anchor_seen, label)
            else:
                bump_counter(self.anchor_missing, label)

        for label in slot_labels:
            if not label:
                continue
            if label in known_labels:
                continue
            if label in valid_set:
                bump_counter(self.anchor_seen, label)
            else:
                bump_counter(self.anchor_missing, label)

        for label in used_names:
            bump_counter(self.anchor_used, label)

        if failure_reason:
            self.unsolved_rows += 1
            bump_counter(self.failure_reasons, failure_reason)
        else:
            self.solved_rows += 1

    def maybe_print_health(self, force: bool = False) -> None:
        if self.stats_interval <= 0:
            return

        now = time.monotonic()
        if not force and now - self.last_stats_at < self.stats_interval:
            return
        self.last_stats_at = now

        total = self.solved_rows + self.unsolved_rows
        if total <= 0:
            print(f"[health] frames=0 solved=0 fail=0 solve_rate=0.0% stale_drops={self.stale_drops}")
            return

        solve_rate = self.solved_rows * 100.0 / total
        print(
            f"[health] frames={total} solved={self.solved_rows} "
            f"fail={self.unsolved_rows} solve_rate={solve_rate:.1f}% "
            f"stale_drops={self.stale_drops}"
        )

        labels = sorted(
            set(self.known_anchor_labels())
            | set(self.anchor_seen)
            | set(self.anchor_missing)
            | set(self.anchor_used),
            key=normalize_anchor_label,
        )
        if labels:
            parts = []
            for label in labels:
                seen = self.anchor_seen.get(label, 0)
                missing = self.anchor_missing.get(label, 0)
                denom = max(1, seen + missing)
                seen_rate = seen * 100.0 / denom
                used = self.anchor_used.get(label, 0)
                parts.append(f"{label}:valid={seen_rate:.1f}% used={used}")
            print("[health] anchors " + " | ".join(parts))

        if self.failure_reasons:
            reasons = sorted(self.failure_reasons.items(), key=lambda item: item[1], reverse=True)[:4]
            print("[health] failure " + " | ".join(f"{reason}={count}" for reason, count in reasons))

    def update_plot(self, source: str, frame: BleRangeFrame, x: float, y: float) -> None:
        if self.plot is None:
            return

        now = time.monotonic()
        if not should_update_plot(
            source,
            frame.sync_seq,
            now,
            self.plot_interval,
            self.last_plot_at_by_source,
            self.last_plot_sync_seq_by_source,
        ):
            return

        if self.plot_queue is not None:
            self.plot_queue.put((x, y))

    def pump_plot(self) -> None:
        if self.plot is None or self.plot_queue is None:
            return

        updated = False
        while True:
            try:
                x, y = self.plot_queue.get_nowait()
            except queue.Empty:
                break
            self.plot.update(x, y)
            updated = True

        if not updated:
            self.plot.plt.pause(0.03)


class WatchRequestHandler(BaseHTTPRequestHandler):
    store: WatchFrameStore

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok\n")
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/estimote":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)

        try:
            body = json.loads(raw_body.decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError("JSON body must be an object")
        except Exception as exc:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"bad json: {exc}\n".encode("utf-8"))
            return

        self.store.write_frame(self.client_address[0], body)
        self.send_response(204)
        self.end_headers()

    def log_message(self, format: str, *args: Iterable[Any]) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Receive Estimote frames posted by the Wear OS BLE gateway.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8088)
    parser.add_argument("--csv", default="", help="Output CSV path. Default: timestamped file.")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help=f"Anchor config for position solving. Default: {DEFAULT_CONFIG}")
    parser.add_argument("--plot", action="store_true", help="Show live XY plot using HTTP frames from the watch.")
    parser.add_argument("--plot-interval", type=float, default=0.0, help="Minimum seconds between plotted points. Default: every new solved sync frame.")
    parser.add_argument("--min-valid-anchors", type=int, default=3, choices=[3, 4], help="Minimum valid anchors required for position output. Default: 3.")
    parser.add_argument("--max-age-ms", type=int, default=1000, help="Drop watch frames older than this many milliseconds. Use 0 to disable. Default: 1000.")
    parser.add_argument("--stats-interval", type=float, default=10.0, help="Seconds between anchor health summaries. Use 0 to disable. Default: 10.")
    parser.add_argument("--no-position", action="store_true", help="Only log watch frames; do not solve x/y.")
    parser.add_argument("--quiet", action="store_true", help="Do not print every received frame.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    csv_path = Path(args.csv) if args.csv else default_csv_path()
    config = None if args.no_position else load_config(Path(args.config))
    plot = LivePlot(config.anchors) if args.plot and config is not None else None
    store = WatchFrameStore(csv_path, args.quiet, config, plot, args.min_valid_anchors, args.plot_interval, args.max_age_ms, args.stats_interval)
    WatchRequestHandler.store = store
    server = ThreadingHTTPServer((args.host, args.port), WatchRequestHandler)

    print(f"Listening on http://{args.host}:{args.port}/estimote")
    print(f"Writing CSV to {csv_path}")
    if config is not None:
        print(f"Solving position with {args.config}")
    if args.plot:
        print("Live plot enabled")
    if args.max_age_ms > 0:
        print(f"Dropping watch frames older than {args.max_age_ms} ms")
    print("Press Ctrl+C to stop.")

    try:
        if args.plot:
            server_thread = threading.Thread(target=server.serve_forever, daemon=True)
            server_thread.start()
            while True:
                store.pump_plot()
                time.sleep(0.03)
        else:
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        store.maybe_print_health(force=True)
        store.close()
        print(f"Saved {store.rows} rows to {csv_path}; stale drops={store.stale_drops}")


if __name__ == "__main__":
    main()
