var TAG_NAME = "WEARABLE_TAG";
var PAN_ID = 0xCA57;
var UWB_MODE_NAME = "HIGH_RESPONSIVNESS";
var UWB_MODE = uwb.Mode.HIGH_RESPONSIVNESS;
var UWB_MIN_DISTANCE = 0.1;
var UWB_MAX_DISTANCE = 10;
var LED_BRIGHTNESS = 1.0;
var BLE_SERVICE_UUID = "FE9A";
var PAYLOAD_VERSION = 0x03;
var ENABLE_BLE_ADVERTISE = true;
var TEST_ANCHOR_ID = "";
var TEST_ANCHOR_IDS = [
  "92f64d9faf64fec41a1a0f6190869c1a", // 85
  "dc511fe398f7f537a918ce57351b9805", // 87
  "3c672ac91dc36b1a367de39a7b257c09", // 121
  "d395656b93be9272e4394ee5dfd2d520"  // 105
];
var USE_KNOWN_NODES_AS_NEIGHBOURS = true;
var STATS_TIMER = "5s";
var STATS_INTERVAL_SEC = 5;
var SAMPLE_PRINT_INTERVAL_SEC = 0;
var UWB_FORCE_RESTART_TIMER = "5s";
var UWB_FORCE_RESTART_ENABLED = false;
var UWB_RECOVER_VERBOSE = false;
var APP_BURST_RESTART_TIMER = "6s";
var APP_BURST_RESTART_ENABLED = true;
var APP_BURST_RESTART_VERBOSE = false;
var UWB_WATCHDOG_TIMER = "10s";
var UWB_WATCHDOG_ENABLED = false;
var UWB_WATCHDOG_MIN_CALLBACK_RATE = 3.0;
var UWB_WATCHDOG_SLOW_WINDOWS = 2;
var UWB_RECOVER_COOLDOWN_SEC = 0;
var UWB_REFRESH_INTERVAL_SEC = 0;

var KNOWN_NODE_IDS = [
  "3c672ac91dc36b1a367de39a7b257c09",
  "cfe653965453ca7128b5fc6e4ed05626",
  "92f64d9faf64fec41a1a0f6190869c1a",
  "dc511fe398f7f537a918ce57351b9805",
  "636fae02e5ff550528483915213d960e",
  "d395656b93be9272e4394ee5dfd2d520"
];

var KNOWN_ANCHOR_CODES = [
  121,
  99,
  85,
  87,
  86,
  105
];

var FIXED_ANCHOR_IDS = [
  "92f64d9faf64fec41a1a0f6190869c1a", // ID1 = 85
  "dc511fe398f7f537a918ce57351b9805", // ID2 = 87
  "3c672ac91dc36b1a367de39a7b257c09", // ID3 = 121
  "d395656b93be9272e4394ee5dfd2d520"  // ID4 = 105
];

var DISCOVER_KNOWN_ANCHORS = false;
var ACCEPT_UNKNOWN_ANCHORS = false;
var MAX_TRACKED_ANCHORS = 4;
var MIN_SYNCED_ANCHORS = 4;
var SELF_ID = String(sys.getPublicId()).toLowerCase();

var paused = false;
var stoppingApp = false;
var uwbStarted = false;
var recoveringUwb = false;
var bleAdvertiser = null;
var lastMeasurementTime = 0;
var lastPrintTime = 0;
var lastSamplePrintTime = 0;
var uwbStartedAt = 0;
var lastWatchdogTime = 0;
var lastWatchdogCallbacks = 0;
var slowWatchdogWindows = 0;
var lastRecoverAt = 0;
var bleSeq = 0;
var syncSeq = 0;
var statsWindowStartedAt = 0;
var totalMeasurementCallbacks = 0;
var totalValidRanges = 0;
var windowMeasurementCallbacks = 0;
var windowValidRanges = 0;
var windowDistanceSum = 0;
var windowDistanceMin = null;
var windowDistanceMax = null;
var windowLqiSum = 0;
var windowLqiCount = 0;
var totalUntrackedCallbacks = 0;
var windowUntrackedCallbacks = 0;
var lastPeer = "none";
var lastDistance = null;
var lastLqi = null;

var PRINT_INTERVAL_SEC = 1;
var NO_DATA_WARN_SEC = 5;
var ID_RECEIVE_TIMEOUT_SEC = 3.0;
var BLE_ADVERTISE_INTERVAL_MS = 300;
var SYNC_FRAME_MAX_SPAN_SEC = 3.0;
var SYNC_FRAME_EXPIRE_SEC = 3.5;

var trackedDevices = [];
var syncedFrame = null;
var lastInvalidPayloadKey = "";
var lastInvalidPayloadHex = "";
var lastPayloadWasInvalid = false;

print("=== UWB POSITIONING TAG ===");
print("Tag name: " + TAG_NAME);
print("Tag ID: " + SELF_ID);
print("Battery: " + sensors.battery.getPerc() + "%");
print("Role: TOF_INITIATOR");
print("PAN ID: " + PAN_ID);
print("Mode: " + UWB_MODE_NAME);
print("Distance gate: " + UWB_MIN_DISTANCE + "m - " + UWB_MAX_DISTANCE + "m");
print("Target anchors: " + describeTargetAnchors());
print("Known-node neighbour filter: " + (USE_KNOWN_NODES_AS_NEIGHBOURS ? "ON" : "OFF"));
print("Tracked slots: " + MAX_TRACKED_ANCHORS);
print("BLE frame requirement: " + MIN_SYNCED_ANCHORS + "/" + MAX_TRACKED_ANCHORS + " anchors");
print("Stats window: " + STATS_INTERVAL_SEC + "s");
print("UWB force restart: " + (UWB_FORCE_RESTART_ENABLED ? "ON" : "OFF") + ", timer=" + UWB_FORCE_RESTART_TIMER);
print("App burst restart: " + (APP_BURST_RESTART_ENABLED ? "ON" : "OFF") + ", timer=" + APP_BURST_RESTART_TIMER);
print("UWB watchdog: " + (UWB_WATCHDOG_ENABLED ? "ON" : "OFF") + ", min_rate=" + UWB_WATCHDOG_MIN_CALLBACK_RATE + "/s, refresh=" + UWB_REFRESH_INTERVAL_SEC + "s");
print("BLE advertising: " + (ENABLE_BLE_ADVERTISE ? "ON" : "OFF"));

initTrackedDevices();

function setSolid(color) {
  io.setLedColor(color);
  io.setLedBrightness(LED_BRIGHTNESS);
  io.led(true);
}

function getTargetAnchorIds() {
  var targets = [];

  if (TEST_ANCHOR_IDS.length > 0) {
    for (var i = 0; i < TEST_ANCHOR_IDS.length; i += 1) {
      targets.push(String(TEST_ANCHOR_IDS[i]).toLowerCase());
    }
  } else if (TEST_ANCHOR_ID !== "") {
    targets.push(String(TEST_ANCHOR_ID).toLowerCase());
  }

  return targets;
}

function describeTargetAnchors() {
  var targets = getTargetAnchorIds();

  if (targets.length === 0) {
    if (USE_KNOWN_NODES_AS_NEIGHBOURS) {
      return "KNOWN_NODE_IDS neighbours";
    }

    return "ANY responders on this PAN/mode";
  }

  return targets.join(",");
}

function getKnownNodeNeighbourIds() {
  var neighbours = [];

  for (var i = 0; i < KNOWN_NODE_IDS.length; i += 1) {
    var candidate = String(KNOWN_NODE_IDS[i]).toLowerCase();

    if (!idsMatch(candidate, SELF_ID)) {
      neighbours.push(candidate);
    }
  }

  return neighbours;
}

function buildUwbOptions() {
  var options = {
    timeout: 0,
    mode: UWB_MODE,
    panId: PAN_ID,
    minDistance: UWB_MIN_DISTANCE,
    maxDistance: UWB_MAX_DISTANCE
  };

  var targets = getTargetAnchorIds();

  if (targets.length > 0) {
    options.neighbours = targets;
  } else if (USE_KNOWN_NODES_AS_NEIGHBOURS) {
    options.neighbours = getKnownNodeNeighbourIds();
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

function formatMetric(value, digits) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  var numeric = value * 1;

  if (numeric !== numeric) {
    return String(value);
  }

  return numeric.toFixed(digits);
}

function resetLinkTestStats(resetTotals) {
  statsWindowStartedAt = sys.getUptime();
  windowMeasurementCallbacks = 0;
  windowValidRanges = 0;
  windowDistanceSum = 0;
  windowDistanceMin = null;
  windowDistanceMax = null;
  windowLqiSum = 0;
  windowLqiCount = 0;
  windowUntrackedCallbacks = 0;
  lastSamplePrintTime = 0;

  if (resetTotals) {
    totalMeasurementCallbacks = 0;
    totalValidRanges = 0;
    totalUntrackedCallbacks = 0;
    lastPeer = "none";
    lastDistance = null;
    lastLqi = null;
  }

  for (var i = 0; i < trackedDevices.length; i += 1) {
    resetDeviceStats(trackedDevices[i], resetTotals);
  }
}

function resetDeviceStats(device, resetTotals) {
  device.windowCallbacks = 0;
  device.windowValid = 0;
  device.windowDistanceSum = 0;
  device.windowDistanceMin = null;
  device.windowDistanceMax = null;
  device.windowLqiSum = 0;
  device.windowLqiCount = 0;

  if (resetTotals) {
    device.totalCallbacks = 0;
    device.totalValid = 0;
    device.lastDistance = null;
    device.lastLqi = null;
  }
}

function recordDeviceMeasurement(index, distance, lqi) {
  if (index < 0 || index >= trackedDevices.length) {
    totalUntrackedCallbacks += 1;
    windowUntrackedCallbacks += 1;
    return;
  }

  var device = trackedDevices[index];

  device.totalCallbacks += 1;
  device.windowCallbacks += 1;
  device.lastDistance = distance;
  device.lastLqi = lqi;

  if (distance !== null) {
    device.totalValid += 1;
    device.windowValid += 1;
    device.windowDistanceSum += distance;

    if (device.windowDistanceMin === null || distance < device.windowDistanceMin) {
      device.windowDistanceMin = distance;
    }

    if (device.windowDistanceMax === null || distance > device.windowDistanceMax) {
      device.windowDistanceMax = distance;
    }
  }

  if (lqi !== null) {
    device.windowLqiSum += lqi;
    device.windowLqiCount += 1;
  }
}

function recordLinkMeasurement(index, peer, distance, lqi) {
  totalMeasurementCallbacks += 1;
  windowMeasurementCallbacks += 1;
  lastPeer = peer;
  lastDistance = distance;
  lastLqi = lqi;
  recordDeviceMeasurement(index, distance, lqi);

  if (distance !== null) {
    totalValidRanges += 1;
    windowValidRanges += 1;
    windowDistanceSum += distance;

    if (windowDistanceMin === null || distance < windowDistanceMin) {
      windowDistanceMin = distance;
    }

    if (windowDistanceMax === null || distance > windowDistanceMax) {
      windowDistanceMax = distance;
    }
  }

  if (lqi !== null) {
    windowLqiSum += lqi;
    windowLqiCount += 1;
  }
}

function maybePrintLinkSample() {
  if (SAMPLE_PRINT_INTERVAL_SEC <= 0) {
    return;
  }

  var now = sys.getUptime();

  if (now - lastSamplePrintTime < SAMPLE_PRINT_INTERVAL_SEC) {
    return;
  }

  lastSamplePrintTime = now;
  print("TAG sample peer=" + lastPeer + " dist=" + formatMetric(lastDistance, 3) + "m lqi=" + formatMetric(lastLqi, 2) + " total_ok=" + totalValidRanges + " active=" + recentTrackedCount() + "/" + trackedDevices.length);
}

function printDeviceStats(index, elapsed) {
  var device = trackedDevices[index];
  var label = "ID" + (index + 1);
  var rate = device.windowValid / elapsed;
  var success = device.windowCallbacks > 0 ? device.windowValid * 100 / device.windowCallbacks : 0;
  var avgDistance = device.windowValid > 0 ? device.windowDistanceSum / device.windowValid : null;
  var avgLqi = device.windowLqiCount > 0 ? device.windowLqiSum / device.windowLqiCount : null;
  var age = device.lastSeen > 0 ? sys.getUptime() - device.lastSeen : null;
  var state = isTrackedDeviceRecent(index) ? "OK" : "STALE";

  if (device.id === "") {
    state = "EMPTY";
  }

  print(label + " " + state + " peer=" + (device.id || "<empty>") + " win_valid=" + device.windowValid + " rate=" + rate.toFixed(2) + "/s success=" + success.toFixed(0) + "% total=" + device.totalValid + " age=" + formatMetric(age, 1) + "s");
  print(label + " dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(device.windowDistanceMin, 3) + " max=" + formatMetric(device.windowDistanceMax, 3) + " last=" + formatMetric(device.lastDistance, 3) + " lqi_avg=" + formatMetric(avgLqi, 2));
}

function printLinkStats() {
  var now = sys.getUptime();
  var elapsed = now - statsWindowStartedAt;

  if (elapsed <= 0) {
    elapsed = 0.001;
  }

  var rate = windowValidRanges / elapsed;
  var callbackRate = windowMeasurementCallbacks / elapsed;
  var success = windowMeasurementCallbacks > 0 ? windowValidRanges * 100 / windowMeasurementCallbacks : 0;
  var avgDistance = windowValidRanges > 0 ? windowDistanceSum / windowValidRanges : null;
  var avgLqi = windowLqiCount > 0 ? windowLqiSum / windowLqiCount : null;

  print("=== TAG LINK STATS ===");
  print("window=" + elapsed.toFixed(1) + "s callbacks=" + windowMeasurementCallbacks + " valid=" + windowValidRanges + " callback_rate=" + callbackRate.toFixed(2) + "/s valid_rate=" + rate.toFixed(2) + "/s success=" + success.toFixed(0) + "%");
  print("total_callbacks=" + totalMeasurementCallbacks + " total_valid=" + totalValidRanges + " untracked=" + totalUntrackedCallbacks + " last_peer=" + lastPeer);
  print("dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(windowDistanceMin, 3) + " max=" + formatMetric(windowDistanceMax, 3) + " last=" + formatMetric(lastDistance, 3));
  print("lqi avg=" + formatMetric(avgLqi, 2) + " last=" + formatMetric(lastLqi, 2));

  for (var i = 0; i < trackedDevices.length; i += 1) {
    printDeviceStats(i, elapsed);
  }

  if (windowUntrackedCallbacks > 0) {
    print("untracked window callbacks=" + windowUntrackedCallbacks + " (increase MAX_TRACKED_ANCHORS or set TEST_ANCHOR_IDS)");
  }

  resetLinkTestStats(false);
}

function resetUwbWatchdogBaseline() {
  lastWatchdogTime = sys.getUptime();
  lastWatchdogCallbacks = totalMeasurementCallbacks;
  slowWatchdogWindows = 0;
}

function recoverUwb(reason) {
  if (recoveringUwb || paused || stoppingApp) {
    return;
  }

  var now = sys.getUptime();

  if (lastRecoverAt > 0 && now - lastRecoverAt < UWB_RECOVER_COOLDOWN_SEC) {
    return;
  }

  recoveringUwb = true;
  lastRecoverAt = now;

  if (UWB_RECOVER_VERBOSE) {
    print("=== UWB RECOVER: " + reason + " ===");
  }

  stopUwb(!UWB_RECOVER_VERBOSE);
  resetTrackedDevices();
  lastMeasurementTime = 0;
  syncedFrame = null;

  timers.single("700ms", function () {
    if (paused || stoppingApp) {
      recoveringUwb = false;
      return;
    }

    startUwb(!UWB_RECOVER_VERBOSE);
    resetUwbWatchdogBaseline();
    recoveringUwb = false;
  });
}

function checkUwbWatchdog() {
  if (!UWB_WATCHDOG_ENABLED || paused || stoppingApp || !uwbStarted || recoveringUwb) {
    return;
  }

  var now = sys.getUptime();

  if (lastMeasurementTime > 0 && now - lastMeasurementTime > NO_DATA_WARN_SEC) {
    recoverUwb("no recent measurements");
    return;
  }

  if (UWB_REFRESH_INTERVAL_SEC > 0 && uwbStartedAt > 0 && now - uwbStartedAt >= UWB_REFRESH_INTERVAL_SEC) {
    recoverUwb("periodic refresh");
    return;
  }

  if (lastWatchdogTime === 0) {
    resetUwbWatchdogBaseline();
    return;
  }

  var elapsed = now - lastWatchdogTime;

  if (elapsed <= 0) {
    return;
  }

  var callbackDelta = totalMeasurementCallbacks - lastWatchdogCallbacks;
  var callbackRate = callbackDelta / elapsed;

  lastWatchdogTime = now;
  lastWatchdogCallbacks = totalMeasurementCallbacks;

  if (callbackRate < UWB_WATCHDOG_MIN_CALLBACK_RATE) {
    slowWatchdogWindows += 1;
  } else {
    slowWatchdogWindows = 0;
  }

  if (slowWatchdogWindows >= UWB_WATCHDOG_SLOW_WINDOWS) {
    recoverUwb("callback_rate=" + callbackRate.toFixed(2) + "/s");
  }
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
      anchorCode: anchorCodeForId(id),
      lastSeen: 0,
      dist: null,
      lqi: null,
      version: 0,
      publishedVersion: 0,
      totalCallbacks: 0,
      totalValid: 0,
      windowCallbacks: 0,
      windowValid: 0,
      windowDistanceSum: 0,
      windowDistanceMin: null,
      windowDistanceMax: null,
      windowLqiSum: 0,
      windowLqiCount: 0,
      lastDistance: null,
      lastLqi: null
    });
  }
}

function resetTrackedDevices() {
  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (DISCOVER_KNOWN_ANCHORS || ACCEPT_UNKNOWN_ANCHORS) {
      trackedDevices[i].id = "";
      trackedDevices[i].anchorCode = 0;
    } else {
      trackedDevices[i].anchorCode = anchorCodeForId(trackedDevices[i].id);
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

function anchorCodeForId(peerId) {
  for (var i = 0; i < KNOWN_NODE_IDS.length; i += 1) {
    if (idsMatch(peerId, KNOWN_NODE_IDS[i])) {
      return KNOWN_ANCHOR_CODES[i];
    }
  }

  return 0;
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
        trackedDevices[i].anchorCode = anchorCodeForId(peerId);
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
        trackedDevices[j].anchorCode = anchorCodeForId(peerId);
        trackedDevices[j].version += 1;
        print("Discovered anchor slot ID" + (j + 1) + ": " + peerId);
        return j;
      }
    }

    if (ACCEPT_UNKNOWN_ANCHORS) {
      for (var k = 0; k < trackedDevices.length; k += 1) {
        if (!isTrackedDeviceRecent(k)) {
          trackedDevices[k].id = peerId;
          trackedDevices[k].lastSeen = sys.getUptime();
          trackedDevices[k].dist = distance;
          trackedDevices[k].lqi = lqi;
          trackedDevices[k].anchorCode = anchorCodeForId(peerId);
          trackedDevices[k].version += 1;
          trackedDevices[k].publishedVersion = 0;
          resetDeviceStats(trackedDevices[k], true);
          syncedFrame = null;
          print("Switched stale anchor slot ID" + (k + 1) + " to: " + peerId);
          return k;
        }
      }

      syncedFrame = null;
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

function appendAnchorCodes(arr, codes) {
  for (var i = 0; i < trackedDevices.length; i += 1) {
    if (codes !== null && i < codes.length) {
      arr.push(clampByte(codes[i]));
    } else {
      arr.push(clampByte(trackedDevices[i].anchorCode));
    }
  }
}

function anchorCodeKey() {
  var parts = [];

  for (var i = 0; i < trackedDevices.length; i += 1) {
    parts.push(clampByte(trackedDevices[i].anchorCode));
  }

  return parts.join(",");
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
  var key = String(flags) + ":" + anchorCodeKey();

  if (lastPayloadWasInvalid && key === lastInvalidPayloadKey && lastInvalidPayloadHex !== "") {
    return lastInvalidPayloadHex;
  }

  bleSeq = (bleSeq + 1) % 256;

  var arr = [];

  arr.push(0xEC);          // magic
  arr.push(PAYLOAD_VERSION);
  arr.push(bleSeq);        // sequence
  arr.push(flags);         // bit0-3 = ID1-ID4 valid, bit4 = paused

  appendAnchorCodes(arr, null);

  for (var i = 0; i < trackedDevices.length; i += 1) {
    pushUint16LE(arr, 65535);
  }

  arr.push(clampByte(sensors.battery.getPerc()));
  arr.push(0);
  appendDiagnostics(arr, 0, null);

  lastPayloadWasInvalid = true;
  lastInvalidPayloadKey = key;
  lastInvalidPayloadHex = arr.toHexString();

  return lastInvalidPayloadHex;
}

function buildSyncedBlePayloadHex() {
  if (syncedFrame.payloadHex !== undefined && syncedFrame.payloadHex !== "") {
    return syncedFrame.payloadHex;
  }

  bleSeq = (bleSeq + 1) % 256;
  lastPayloadWasInvalid = false;

  var arr = [];

  arr.push(0xEC);                 // magic
  arr.push(PAYLOAD_VERSION);
  arr.push(bleSeq);               // BLE advertisement sequence
  arr.push(syncedFrame.flags);    // bit0-3 = ID1-ID4 valid, bit4 = paused

  appendAnchorCodes(arr, syncedFrame.anchorCodes);

  for (var i = 0; i < syncedFrame.distancesCm.length; i += 1) {
    pushUint16LE(arr, syncedFrame.distancesCm[i]);
  }

  arr.push(clampByte(sensors.battery.getPerc()));
  arr.push(syncedFrame.validCount);
  appendDiagnostics(arr, syncedFrame.seq, syncedFrame.span);

  syncedFrame.payloadHex = arr.toHexString();
  return syncedFrame.payloadHex;
}

function buildBlePayloadHex() {
  if (paused || stoppingApp) {
    return "";
  }

  if (syncedFrame === null) {
    return "";
  }

  if (sys.getUptime() - syncedFrame.publishedAt > SYNC_FRAME_EXPIRE_SEC) {
    return "";
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
  var anchorCodes = [];
  var flags = 0;
  var validCount = 0;
  var hasNewMeasurement = false;

  for (var i = 0; i < trackedDevices.length; i += 1) {
    var device = trackedDevices[i];
    var recent = isTrackedDeviceRecent(i) && device.dist !== null;

    anchorCodes.push(clampByte(device.anchorCode));

    if (!recent) {
      distancesCm.push(65535);
      continue;
    }

    if (device.version > device.publishedVersion) {
      hasNewMeasurement = true;
    }

    flags += Math.pow(2, i);
    validCount += 1;
    distancesCm.push(distanceToCmValue(device.dist));

    if (oldest === null || device.lastSeen < oldest) {
      oldest = device.lastSeen;
    }

    if (device.lastSeen > newest) {
      newest = device.lastSeen;
    }
  }

  if (validCount < MIN_SYNCED_ANCHORS || !hasNewMeasurement) {
    return false;
  }

  if (newest - oldest > SYNC_FRAME_MAX_SPAN_SEC) {
    return false;
  }

  syncSeq = (syncSeq + 1) % 256;

  syncedFrame = {
    seq: syncSeq,
    flags: flags,
    anchorCodes: anchorCodes,
    distancesCm: distancesCm,
    validCount: validCount,
    publishedAt: sys.getUptime(),
    span: newest - oldest,
    payloadHex: ""
  };

  for (var j = 0; j < trackedDevices.length; j += 1) {
    if (flags & Math.pow(2, j)) {
      trackedDevices[j].publishedVersion = trackedDevices[j].version;
    }
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
      var payloadHex = buildBlePayloadHex();

      if (payloadHex === "") {
        return {
          serviceData: {}
        };
      }

      var payload = {};
      payload[BLE_SERVICE_UUID] = payloadHex;

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
  recordLinkMeasurement(trackedIndex, peer, distance, lqi);

  if (trackedIndex >= 0 && distance !== null) {
    tryPublishSyncedFrame();
  }

  maybePrintLinkSample();
}

function startUwb(quiet) {
  if (uwbStarted) {
    return;
  }

  if (!quiet) {
    print("Starting UWB as TOF_INITIATOR...");
  }

  try {
    uwb.start(
      uwb.Role.TOF_INITIATOR,
      buildUwbOptions(),
      function (measurement) {
        handleMeasurement(measurement);
      }
    );

    uwbStarted = true;
    uwbStartedAt = sys.getUptime();
    resetUwbWatchdogBaseline();
    if (!quiet) {
      print("uwb.start OK: TOF_INITIATOR");
    }
    showRunning();
  } catch (e) {
    uwbStarted = false;
    uwbStartedAt = 0;
    print("uwb.start ERROR: " + e);
    showError();
  }
}

function stopUwb(quiet) {
  if (!uwbStarted) {
    return;
  }

  if (!quiet) {
    print("Stopping UWB...");
  }

  try {
    uwb.stop(true);
    if (!quiet) {
      print("uwb.stop OK");
    }
  } catch (e) {
    print("uwb.stop ERROR: " + e);
  }

  uwbStarted = false;
  uwbStartedAt = 0;
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
    resetLinkTestStats(true);
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
  if (paused || stoppingApp || !uwbStarted || recoveringUwb || UWB_FORCE_RESTART_ENABLED) {
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

timers.repeat(STATS_TIMER, function () {
  if (paused || stoppingApp || !uwbStarted) {
    return;
  }

  printLinkStats();
});

timers.repeat(UWB_WATCHDOG_TIMER, function () {
  checkUwbWatchdog();
});

timers.repeat(UWB_FORCE_RESTART_TIMER, function () {
  if (!UWB_FORCE_RESTART_ENABLED || paused || stoppingApp) {
    return;
  }

  recoverUwb("5s force restart");
});

timers.repeat(APP_BURST_RESTART_TIMER, function () {
  if (!APP_BURST_RESTART_ENABLED || paused || stoppingApp) {
    return;
  }

  if (APP_BURST_RESTART_VERBOSE) {
    print("=== APP BURST RESTART ===");
  }

  app.restart();
});

resetLinkTestStats(true);
showError();
if (ENABLE_BLE_ADVERTISE) {
  startBleAdvertise();
}
startUwb();
