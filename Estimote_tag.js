var TAG_NAME = "WEARABLE_TAG";
var PAN_ID = 0xCA57;
var LED_BRIGHTNESS = 1.0;
var BLE_SERVICE_UUID = "FE9A";

var KNOWN_NODE_IDS = [
  "3c672ac91dc36b1a367de39a7b257c09",
  "cfe653965453ca7128b5fc6e4ed05626",
  "92f64d9faf64fec41a1a0f6190869c1a",
  "dc511fe398f7f537a918ce57351b9805",
  "636fae02e5ff550528483915213d960e",
  "d395656b93be9272e4394ee5dfd2d520"
];

var FIXED_ANCHOR_IDS = [
  "dc511fe398f7f537",
  "92f64d9faf64fec4",
  "3c672ac91dc36b1a",
  "636fae02e5ff550528483915213d960e"
];

var DISCOVER_KNOWN_ANCHORS = true;
var ACCEPT_UNKNOWN_ANCHORS = false;
var MAX_TRACKED_ANCHORS = 4;
var SELF_ID = String(sys.getPublicId()).toLowerCase();

var paused = false;
var stoppingApp = false;
var uwbStarted = false;
var bleAdvertiser = null;
var lastMeasurementTime = 0;
var lastPrintTime = 0;
var bleSeq = 0;
var syncSeq = 0;

var PRINT_INTERVAL_SEC = 1;
var NO_DATA_WARN_SEC = 5;
var ID_RECEIVE_TIMEOUT_SEC = 1.5;
var BLE_ADVERTISE_INTERVAL_MS = 150;
var SYNC_FRAME_MAX_SPAN_SEC = 1.5;
var SYNC_FRAME_EXPIRE_SEC = 2.0;

var trackedDevices = [];
var syncedFrame = null;

print("=== EverCare UWB Tag Started ===");
print("Tag name: " + TAG_NAME);
print("Tag ID: " + SELF_ID);
print("Battery: " + sensors.battery.getPerc() + "%");
print("PAN ID: " + PAN_ID);
print("BLE Service Data UUID: " + BLE_SERVICE_UUID);
print("Discover known anchors: " + DISCOVER_KNOWN_ANCHORS);
print("Accept unknown anchors: " + ACCEPT_UNKNOWN_ANCHORS);

initTrackedDevices();

function setSolid(color) {
  io.setLedColor(color);
  io.setLedBrightness(LED_BRIGHTNESS);
  io.led(true);
}

function buildUwbOptions() {
  var options = {
    timeout: 0,
    mode: uwb.Mode.LONG_RANGE,
    panId: PAN_ID,
    minDistance: 0.1,
    maxDistance: 20
  };

  var neighbours = getNeighbourIds();

  if (neighbours.length > 0) {
    options.neighbours = neighbours;
  }

  return options;
}

function getNeighbourIds() {
  var sourceIds = DISCOVER_KNOWN_ANCHORS ? KNOWN_NODE_IDS : FIXED_ANCHOR_IDS;
  var neighbours = [];

  for (var i = 0; i < sourceIds.length; i += 1) {
    var candidate = String(sourceIds[i]).toLowerCase();

    if (!idsMatch(candidate, SELF_ID)) {
      neighbours.push(candidate);
    }
  }

  return neighbours;
}

function showRunning() {
  if (!paused) {
    setSolid(io.Color.GREEN);
  }
}

function showPaused() {
  setSolid(io.Color.BLUE);
}

function showError() {
  setSolid(io.Color.RED);
}

function turnOffLeds() {
  io.led(false);
}

function shouldPrint() {
  var now = sys.getUptime();

  if (now - lastPrintTime >= PRINT_INTERVAL_SEC) {
    lastPrintTime = now;
    return true;
  }

  return false;
}

function clampByte(value) {
  value = Math.round(value);

  if (value < 0) {
    return 0;
  }

  if (value > 255) {
    return 255;
  }

  return value;
}

function pushUint16LE(arr, value) {
  arr.push(value & 0xFF);
  arr.push((value >> 8) & 0xFF);
}

function initTrackedDevices() {
  trackedDevices = [];

  var count = DISCOVER_KNOWN_ANCHORS || ACCEPT_UNKNOWN_ANCHORS ? MAX_TRACKED_ANCHORS : FIXED_ANCHOR_IDS.length;

  for (var i = 0; i < count; i += 1) {
    var id = "";

    if (!DISCOVER_KNOWN_ANCHORS && !ACCEPT_UNKNOWN_ANCHORS && i < FIXED_ANCHOR_IDS.length) {
      id = String(FIXED_ANCHOR_IDS[i]).toLowerCase();
    }

    trackedDevices.push({
      id: id,
      lastSeen: 0,
      dist: null,
      lqi: null,
      version: 0,
      publishedVersion: 0
    });
  }
}

function resetTrackedDevices() {
  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (DISCOVER_KNOWN_ANCHORS || ACCEPT_UNKNOWN_ANCHORS) {
      trackedDevices[i].id = "";
    }

    trackedDevices[i].lastSeen = 0;
    trackedDevices[i].dist = null;
    trackedDevices[i].lqi = null;
    trackedDevices[i].version = 0;
    trackedDevices[i].publishedVersion = 0;
  }

  syncedFrame = null;
}

function idsMatch(peerId, trackedId) {
  peerId = String(peerId).toLowerCase();
  trackedId = String(trackedId).toLowerCase();

  if (peerId.length === 0 || trackedId.length === 0) {
    return false;
  }

  return peerId === trackedId ||
    peerId.indexOf(trackedId) === 0 ||
    trackedId.indexOf(peerId) === 0 ||
    peerId.lastIndexOf(trackedId) === peerId.length - trackedId.length ||
    trackedId.lastIndexOf(peerId) === trackedId.length - peerId.length;
}

function isKnownNode(peerId) {
  for (var i = 0; i < KNOWN_NODE_IDS.length; i += 1) {
    if (idsMatch(peerId, KNOWN_NODE_IDS[i])) {
      return true;
    }
  }

  return false;
}

function updateTrackedDevice(peerId, distance, lqi) {
  peerId = String(peerId).toLowerCase();

  if (idsMatch(peerId, SELF_ID)) {
    return -1;
  }

  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (idsMatch(peerId, trackedDevices[i].id)) {
      if (distance !== null) {
        trackedDevices[i].lastSeen = sys.getUptime();
        trackedDevices[i].dist = distance;
        trackedDevices[i].lqi = lqi;
        trackedDevices[i].version += 1;
      }

      return i;
    }
  }

  if ((DISCOVER_KNOWN_ANCHORS || ACCEPT_UNKNOWN_ANCHORS) && distance !== null) {
    if (!ACCEPT_UNKNOWN_ANCHORS && !isKnownNode(peerId)) {
      return -1;
    }

    for (var j = 0; j < trackedDevices.length; j += 1) {
      if (trackedDevices[j].id === "") {
        trackedDevices[j].id = peerId;
        trackedDevices[j].lastSeen = sys.getUptime();
        trackedDevices[j].dist = distance;
        trackedDevices[j].lqi = lqi;
        trackedDevices[j].version += 1;
        print("Discovered anchor slot ID" + (j + 1) + ": " + peerId);
        return j;
      }
    }
  }

  return -1;
}

function isTrackedDeviceRecent(index) {
  var device = trackedDevices[index];

  if (!device || device.lastSeen === 0) {
    return false;
  }

  return sys.getUptime() - device.lastSeen <= ID_RECEIVE_TIMEOUT_SEC;
}

function recentTrackedCount() {
  var count = 0;

  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (isTrackedDeviceRecent(i)) {
      count += 1;
    }
  }

  return count;
}

function distanceToCmForAdv(index) {
  var device = trackedDevices[index];

  if (!isTrackedDeviceRecent(index) || device.dist === null) {
    return 65535;
  }

  var cm = Math.round(device.dist * 100);

  if (cm < 0) {
    return 0;
  }

  if (cm > 65534) {
    return 65534;
  }

  return cm;
}

function lqiToByte(index) {
  var device = trackedDevices[index];

  if (!isTrackedDeviceRecent(index) || device.lqi === null) {
    return 255;
  }

  return clampByte(device.lqi * 100);
}

function distanceToCmValue(distance) {
  var cm = Math.round(distance * 100);

  if (cm < 0) {
    return 0;
  }

  if (cm > 65534) {
    return 65534;
  }

  return cm;
}

function lqiToByteValue(lqi) {
  if (lqi === null) {
    return 255;
  }

  return clampByte(lqi * 100);
}

function ageToByte(index) {
  var device = trackedDevices[index];

  if (!device || device.lastSeen === 0) {
    return 255;
  }

  return clampByte((sys.getUptime() - device.lastSeen) * 10);
}

function appendDiagnostics(arr, frameSeq, span) {
  arr.push(frameSeq);

  for (var i = 0; i < trackedDevices.length; i += 1) {
    arr.push(ageToByte(i));
  }

  if (span === null) {
    arr.push(255);
  } else {
    arr.push(clampByte(span * 10));
  }
}

function buildFlags() {
  var flags = 0;

  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (isTrackedDeviceRecent(i)) {
      flags += Math.pow(2, i);
    }
  }

  if (paused) {
    flags += 16;
  }

  return flags;
}

function buildInvalidBlePayloadHex(flags) {
  bleSeq = (bleSeq + 1) % 256;

  var arr = [];

  arr.push(0xEC);          // magic
  arr.push(0x02);          // payload version
  arr.push(bleSeq);        // sequence
  arr.push(flags);         // bit0-3 = ID1-ID4 valid, bit4 = paused

  for (var i = 0; i < trackedDevices.length; i += 1) {
    pushUint16LE(arr, 65535);
  }

  for (var j = 0; j < trackedDevices.length; j += 1) {
    arr.push(255);
  }

  arr.push(clampByte(sensors.battery.getPerc()));
  arr.push(0);
  appendDiagnostics(arr, 0, null);

  return arr.toHexString();
}

function buildSyncedBlePayloadHex() {
  bleSeq = (bleSeq + 1) % 256;

  var arr = [];

  arr.push(0xEC);                 // magic
  arr.push(0x02);                 // payload version
  arr.push(bleSeq);               // BLE advertisement sequence
  arr.push(syncedFrame.flags);    // bit0-3 = ID1-ID4 valid, bit4 = paused

  for (var i = 0; i < syncedFrame.distancesCm.length; i += 1) {
    pushUint16LE(arr, syncedFrame.distancesCm[i]);
  }

  for (var j = 0; j < syncedFrame.lqiBytes.length; j += 1) {
    arr.push(syncedFrame.lqiBytes[j]);
  }

  arr.push(clampByte(sensors.battery.getPerc()));
  arr.push(syncedFrame.validCount);
  appendDiagnostics(arr, syncedFrame.seq, syncedFrame.span);

  return arr.toHexString();
}

function buildBlePayloadHex() {
  if (paused || stoppingApp) {
    return buildInvalidBlePayloadHex(16);
  }

  if (syncedFrame === null) {
    return buildInvalidBlePayloadHex(0);
  }

  if (sys.getUptime() - syncedFrame.publishedAt > SYNC_FRAME_EXPIRE_SEC) {
    return buildInvalidBlePayloadHex(0);
  }

  return buildSyncedBlePayloadHex();
}

function tryPublishSyncedFrame() {
  if (paused || stoppingApp || trackedDevices.length === 0) {
    return false;
  }

  var oldest = null;
  var newest = 0;
  var distancesCm = [];
  var lqiBytes = [];

  for (var i = 0; i < trackedDevices.length; i += 1) {
    var device = trackedDevices[i];

    if (device.dist === null || device.lastSeen === 0) {
      return false;
    }

    if (device.version <= device.publishedVersion) {
      return false;
    }

    if (oldest === null || device.lastSeen < oldest) {
      oldest = device.lastSeen;
    }

    if (device.lastSeen > newest) {
      newest = device.lastSeen;
    }

    distancesCm.push(distanceToCmValue(device.dist));
    lqiBytes.push(lqiToByteValue(device.lqi));
  }

  if (newest - oldest > SYNC_FRAME_MAX_SPAN_SEC) {
    return false;
  }

  syncSeq = (syncSeq + 1) % 256;

  syncedFrame = {
    seq: syncSeq,
    flags: 15,
    distancesCm: distancesCm,
    lqiBytes: lqiBytes,
    validCount: trackedDevices.length,
    publishedAt: sys.getUptime(),
    span: newest - oldest
  };

  for (var j = 0; j < trackedDevices.length; j += 1) {
    trackedDevices[j].publishedVersion = trackedDevices[j].version;
  }

  return true;
}

function startBleAdvertise() {
  if (bleAdvertiser !== null) {
    return;
  }

  print("Starting BLE distance advertising...");

  try {
    bleAdvertiser = ble.advertise(function () {
      var payload = {};
      payload[BLE_SERVICE_UUID] = buildBlePayloadHex();

      return {
        serviceData: payload
      };
    });

    bleAdvertiser.interval(BLE_ADVERTISE_INTERVAL_MS);
    bleAdvertiser.power(0);

    print("BLE advertise OK");
  } catch (e) {
    bleAdvertiser = null;
    print("BLE advertise ERROR: " + e);
  }
}

function stopBleAdvertise() {
  if (bleAdvertiser === null) {
    return;
  }

  print("Stopping BLE advertising...");

  try {
    bleAdvertiser.stop();
    print("BLE advertise stop OK");
  } catch (e) {
    print("BLE advertise stop ERROR: " + e);
  }

  bleAdvertiser = null;
}

function printTrackedStatus() {
  print("Tracked IDs received: " + recentTrackedCount() + "/" + trackedDevices.length);

  for (var i = 0; i < trackedDevices.length; i += 1) {
    var device = trackedDevices[i];
    var name = "ID" + (i + 1);

    if (isTrackedDeviceRecent(i)) {
      var age = sys.getUptime() - device.lastSeen;
      var line = name + " " + (device.id || "<empty>") + ": OK";

      if (device.dist !== null) {
        line += ", dist=" + device.dist + "m";
      }

      if (device.lqi !== null) {
        line += ", lqi=" + device.lqi;
      }

      line += ", age=" + age.toFixed(1) + "s";
      print(line);
    } else {
      print(name + " " + (device.id || "<empty>") + ": NO DATA");
    }
  }
}

function getDistance(measurement) {
  if (measurement.dist !== undefined) {
    return measurement.dist;
  }

  if (measurement.distance !== undefined) {
    return measurement.distance;
  }

  if (measurement.range !== undefined) {
    return measurement.range;
  }

  return null;
}

function handleMeasurement(measurement) {
  if (paused || stoppingApp) {
    return;
  }

  lastMeasurementTime = sys.getUptime();

  var peer = measurement.id || measurement.peer || measurement.peerId || "unknown";
  var distance = getDistance(measurement);
  var lqi = null;

  if (measurement.lqi !== undefined) {
    lqi = measurement.lqi;
  }

  var trackedIndex = updateTrackedDevice(peer, distance, lqi);

  if (trackedIndex >= 0 && distance !== null) {
    tryPublishSyncedFrame();
  }

  if (!shouldPrint()) {
    return;
  }

  print("=== TAG UWB MEASUREMENT ===");
  print("Peer: " + peer);
  print(trackedIndex >= 0 ? "Matched tracked ID: ID" + (trackedIndex + 1) : "Matched tracked ID: no");

  if (distance !== null) {
    print("Distance: " + distance + " m");
  } else {
    print("Distance field not found");
  }

  if (measurement.lqi !== undefined) {
    print("LQI: " + measurement.lqi);
  }

  printTrackedStatus();

  if (syncedFrame !== null) {
    print("Synced BLE frame: seq=" + syncedFrame.seq + ", span=" + syncedFrame.span.toFixed(2) + "s, age=" + (sys.getUptime() - syncedFrame.publishedAt).toFixed(1) + "s");
  } else {
    print("Synced BLE frame: waiting for fresh 4-anchor cycle");
  }

  try {
    print("Raw: " + JSON.stringify(measurement));
  } catch (e) {
    print("Raw print error: " + e);
  }
}

function startUwb() {
  if (uwbStarted) {
    return;
  }

  print("Starting UWB as TOF_INITIATOR...");

  try {
    uwb.start(
      uwb.Role.TOF_INITIATOR,
      buildUwbOptions(),
      function (measurement) {
        handleMeasurement(measurement);
      }
    );

    uwbStarted = true;
    print("uwb.start OK: TOF_INITIATOR");
    showRunning();
  } catch (e) {
    uwbStarted = false;
    print("uwb.start ERROR: " + e);
    showError();
  }
}

function stopUwb() {
  if (!uwbStarted) {
    return;
  }

  print("Stopping UWB...");

  try {
    uwb.stop(true);
    print("uwb.stop OK");
  } catch (e) {
    print("uwb.stop ERROR: " + e);
  }

  uwbStarted = false;
}

function togglePause() {
  if (stoppingApp) {
    return;
  }

  if (paused) {
    paused = false;
    print("=== RESUME UWB ===");
    lastMeasurementTime = 0;
    resetTrackedDevices();
    startUwb();
  } else {
    paused = true;
    print("=== PAUSE UWB ===");
    stopUwb();
    resetTrackedDevices();
    showPaused();
  }
}

function stopApplication() {
  if (stoppingApp) {
    return;
  }

  stoppingApp = true;
  paused = true;

  print("=== STOP APP ===");
  resetTrackedDevices();
  setSolid(io.Color.YELLOW);
  stopUwb();

  timers.single("500ms", function () {
    stopBleAdvertise();
    turnOffLeds();
    app.stop();
  });
}

function restartApplication() {
  if (stoppingApp) {
    return;
  }

  print("=== RESTART APP ===");
  setSolid(io.Color.MAGENTA);
  stopUwb();
  stopBleAdvertise();

  timers.single("300ms", function () {
    app.restart();
  });
}

io.press(togglePause, io.PressType.SHORT);
io.press(stopApplication, io.PressType.LONG);
io.press(restartApplication, io.PressType.VERY_LONG);

timers.repeat("5s", function () {
  if (paused || stoppingApp || !uwbStarted) {
    return;
  }

  if (lastMeasurementTime === 0) {
    print("No UWB measurement yet. Check anchors, PAN_ID, mode, and distance.");
    return;
  }

  if (sys.getUptime() - lastMeasurementTime > NO_DATA_WARN_SEC) {
    print("No recent UWB measurement. Last data was more than " + NO_DATA_WARN_SEC + "s ago.");
  }
});

showError();
startBleAdvertise();
startUwb();
