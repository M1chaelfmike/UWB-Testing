# Estimote Wear OS BLE Gateway

This Wear OS app scans Estimote FE9A BLE service data and forwards decoded frames to:

```text
http://192.168.0.2:8088/estimote
```

Open this folder in Android Studio, build the `app` module, and install it on the Galaxy Watch. Keep the watch and PC on the same network. On Windows, allow inbound TCP port `8088` through the firewall.

For the first test:

1. Start `estimote/pc/watch_http_receiver.py` on the PC.
2. Open the watch app.
3. Grant Bluetooth permissions.
4. Tap `Start`.
5. Keep the app in the foreground during the test.

Realtime mode:

```powershell
python estimote/pc/watch_http_receiver.py --host 0.0.0.0 --port 8088 --plot
```

The watch app keeps only the latest unsent frame. If HTTP is slow, newer BLE frames replace older pending frames instead of building a backlog. The PC receiver also drops watch frames older than `1000ms` by default. For stricter realtime testing, use:

```powershell
python estimote/pc/watch_http_receiver.py --host 0.0.0.0 --port 8088 --plot --max-age-ms 500
```

Anchor labels:

`estimote/micro_apps/Estimote_tag.js` now sends payload version `3`, which includes one-byte anchor labels for each slot: `121`, `099`, `085`, `087`, `086`, and `105`. The watch forwards them as `anchor_codes` and `anchor_labels`. The PC receiver writes both slot columns such as `d_1_m` and named columns such as `d_087_m`, `d_121_m`, and `d_105_m`; use the named columns for analysis.

Troubleshooting:

- `scan` increases but `rx` stays `0`: the watch is seeing BLE packets, but not Estimote FE9A packets. Move the watch closer to the tag and confirm the tag is advertising with `Estimote_tag.js`.
- `rx` increases but `posted` stays `0` and `fail` increases: BLE is working, but HTTP cannot reach the PC. Check that the PC IP is `192.168.0.2`, both devices are on the same network, and Windows firewall allows TCP `8088`.
- `scan` does not increase: Bluetooth scanning is not delivering callbacks. Keep the app in the foreground, disable power saving, grant Nearby devices permission, and make sure Bluetooth is enabled.
- Keep WebIDE disconnected during the real test; use it only to upload/start the Estimote app.

If the PC address changes, update `SERVER_URL` in:

```text
app/src/main/java/com/evercare/estimoteweargateway/MainActivity.java
```
