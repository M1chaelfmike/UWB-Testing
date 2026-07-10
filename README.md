# UWB Testing Workspace

This repository collects UWB experiments, Estimote micro apps, receiver tools,
and hardware reference files.

## Layout

- `estimote/`
  - `micro_apps/`: Estimote LTE Beacon Micro App JavaScript files.
  - `pc/`: PC-side BLE receivers, diagnostic loggers, anchor config, and logs.
  - `wear_os_ble_gateway/`: Wear OS gateway app that forwards Estimote BLE frames over HTTP.
- `ld150/`
  - LD150 serial reader, live plotter, and LD150 manual.
- `docs/`
  - Other hardware manuals and reference material.
- `drivers/`
  - Local driver installers. These are ignored by git unless already tracked.
- `tools/`
  - Local Windows serial tools and vendor utilities.

## Common Commands

Run the Estimote BLE receiver:

```powershell
python estimote/pc/estimote_ble_position_receiver.py --plot
```

Run the Wear OS HTTP receiver:

```powershell
python estimote/pc/watch_http_receiver.py --host 0.0.0.0 --port 8088 --plot
```

Run the LD150 live plotter:

```powershell
python ld150/uwb_live_position_plot.py --list-ports
python ld150/uwb_live_position_plot.py --port COM7
```

Install Estimote PC dependencies:

```powershell
python -m pip install -r estimote/pc/requirements_estimote_pc.txt
```
