var TAG_NAME = "WEARABLE_TAG_LONG_RANGE_FIXED_NEIGHBOURS_NO_BLE";
var PAN_ID = 0xCA57;
var UWB_MODE_NAME = "LONG_RANGE";
var UWB_MODE = uwb.Mode.LONG_RANGE;
var UWB_MIN_DISTANCE = 0.1;
var UWB_MAX_DISTANCE = 20;
var LED_BRIGHTNESS = 1.0;
var STATS_TIMER = "5s";
var STATS_INTERVAL_SEC = 5;
var SAMPLE_PRINT_INTERVAL_SEC = 0;
var RECENT_PEER_TIMEOUT_SEC = 3.0;
var SELF_ID = String(sys.getPublicId()).toLowerCase();

var TEST_ANCHOR_IDS = [
  "92f64d9faf64fec41a1a0f6190869c1a", // 85
  "dc511fe398f7f537a918ce57351b9805", // 87
  "3c672ac91dc36b1a367de39a7b257c09", // 121
  "d395656b93be9272e4394ee5dfd2d520"  // 105
];

var TEST_ANCHOR_CODES = [
  85,
  87,
  121,
  105
];
var ACTIVE_ANCHOR_COUNT = 1;

var paused = false;
var stoppingApp = false;
var uwbStarted = false;
var lastMeasurementTime = 0;
var lastSamplePrintTime = 0;
var statsWindowStartedAt = 0;
var totalCallbacks = 0;
var totalValid = 0;
var windowCallbacks = 0;
var windowValid = 0;
var windowDistanceSum = 0;
var windowDistanceMin = null;
var windowDistanceMax = null;
var windowLqiSum = 0;
var windowLqiCount = 0;
var totalUntracked = 0;
var windowUntracked = 0;
var lastPeer = "none";
var lastDistance = null;
var lastLqi = null;
var anchors = [];

print("=== UWB TAG LONG RANGE RATE TEST ===");
print("Tag name: " + TAG_NAME);
print("Tag ID: " + SELF_ID);
print("Battery: " + sensors.battery.getPerc() + "%");
print("Role: TOF_INITIATOR");
print("PAN ID: " + PAN_ID);
print("Mode: " + UWB_MODE_NAME);
print("Distance gate: " + UWB_MIN_DISTANCE + "m - " + UWB_MAX_DISTANCE + "m");
print("Neighbours: ON, fixed anchors active=" + getActiveAnchorCount() + "/" + TEST_ANCHOR_IDS.length);
print("BLE advertising: OFF");
print("Stats window: " + STATS_INTERVAL_SEC + "s");

initAnchors();

function setSolid(color) {
  io.setLedColor(color);
  io.setLedBrightness(LED_BRIGHTNESS);
  io.led(true);
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

function getActiveAnchorCount() {
  if (ACTIVE_ANCHOR_COUNT < 1) {
    return 1;
  }

  if (ACTIVE_ANCHOR_COUNT > TEST_ANCHOR_IDS.length) {
    return TEST_ANCHOR_IDS.length;
  }

  return ACTIVE_ANCHOR_COUNT;
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

function initAnchors() {
  anchors = [];

  for (var i = 0; i < getActiveAnchorCount(); i += 1) {
    anchors.push({
      id: String(TEST_ANCHOR_IDS[i]).toLowerCase(),
      code: TEST_ANCHOR_CODES[i],
      lastSeen: 0,
      lastDistance: null,
      lastLqi: null,
      totalCallbacks: 0,
      totalValid: 0,
      windowCallbacks: 0,
      windowValid: 0,
      windowDistanceSum: 0,
      windowDistanceMin: null,
      windowDistanceMax: null,
      windowLqiSum: 0,
      windowLqiCount: 0
    });
  }
}

function getTargetAnchorIds() {
  var targets = [];

  for (var i = 0; i < getActiveAnchorCount(); i += 1) {
    var candidate = String(TEST_ANCHOR_IDS[i]).toLowerCase();

    if (!idsMatch(candidate, SELF_ID)) {
      targets.push(candidate);
    }
  }

  return targets;
}

function buildUwbOptions() {
  return {
    timeout: 0,
    mode: UWB_MODE,
    panId: PAN_ID,
    minDistance: UWB_MIN_DISTANCE,
    maxDistance: UWB_MAX_DISTANCE,
    neighbours: getTargetAnchorIds()
  };
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

function findAnchorIndex(peerId) {
  for (var i = 0; i < anchors.length; i += 1) {
    if (idsMatch(peerId, anchors[i].id)) {
      return i;
    }
  }

  return -1;
}

function resetAnchorWindow(anchor) {
  anchor.windowCallbacks = 0;
  anchor.windowValid = 0;
  anchor.windowDistanceSum = 0;
  anchor.windowDistanceMin = null;
  anchor.windowDistanceMax = null;
  anchor.windowLqiSum = 0;
  anchor.windowLqiCount = 0;
}

function resetStats(resetTotals) {
  statsWindowStartedAt = sys.getUptime();
  windowCallbacks = 0;
  windowValid = 0;
  windowDistanceSum = 0;
  windowDistanceMin = null;
  windowDistanceMax = null;
  windowLqiSum = 0;
  windowLqiCount = 0;
  windowUntracked = 0;
  lastSamplePrintTime = 0;

  if (resetTotals) {
    totalCallbacks = 0;
    totalValid = 0;
    totalUntracked = 0;
    lastPeer = "none";
    lastDistance = null;
    lastLqi = null;
  }

  for (var i = 0; i < anchors.length; i += 1) {
    resetAnchorWindow(anchors[i]);

    if (resetTotals) {
      anchors[i].lastSeen = 0;
      anchors[i].lastDistance = null;
      anchors[i].lastLqi = null;
      anchors[i].totalCallbacks = 0;
      anchors[i].totalValid = 0;
    }
  }
}

function recordAnchorMeasurement(index, distance, lqi) {
  if (index < 0 || index >= anchors.length) {
    totalUntracked += 1;
    windowUntracked += 1;
    return;
  }

  var anchor = anchors[index];

  anchor.totalCallbacks += 1;
  anchor.windowCallbacks += 1;
  anchor.lastSeen = sys.getUptime();
  anchor.lastDistance = distance;
  anchor.lastLqi = lqi;

  if (distance !== null) {
    anchor.totalValid += 1;
    anchor.windowValid += 1;
    anchor.windowDistanceSum += distance;

    if (anchor.windowDistanceMin === null || distance < anchor.windowDistanceMin) {
      anchor.windowDistanceMin = distance;
    }

    if (anchor.windowDistanceMax === null || distance > anchor.windowDistanceMax) {
      anchor.windowDistanceMax = distance;
    }
  }

  if (lqi !== null) {
    anchor.windowLqiSum += lqi;
    anchor.windowLqiCount += 1;
  }
}

function recentAnchorCount() {
  var count = 0;
  var now = sys.getUptime();

  for (var i = 0; i < anchors.length; i += 1) {
    if (anchors[i].lastSeen > 0 && now - anchors[i].lastSeen <= RECENT_PEER_TIMEOUT_SEC) {
      count += 1;
    }
  }

  return count;
}

function maybePrintSample() {
  if (SAMPLE_PRINT_INTERVAL_SEC <= 0) {
    return;
  }

  var now = sys.getUptime();

  if (now - lastSamplePrintTime < SAMPLE_PRINT_INTERVAL_SEC) {
    return;
  }

  lastSamplePrintTime = now;
  print("sample peer=" + lastPeer + " dist=" + formatMetric(lastDistance, 3) + "m lqi=" + formatMetric(lastLqi, 2) + " total_valid=" + totalValid + " recent_anchors=" + recentAnchorCount());
}

function printAnchorStats(anchor, index, elapsed) {
  var avgDistance = anchor.windowValid > 0 ? anchor.windowDistanceSum / anchor.windowValid : null;
  var avgLqi = anchor.windowLqiCount > 0 ? anchor.windowLqiSum / anchor.windowLqiCount : null;
  var age = anchor.lastSeen > 0 ? sys.getUptime() - anchor.lastSeen : null;
  var callbackRate = anchor.windowCallbacks / elapsed;
  var validRate = anchor.windowValid / elapsed;
  var success = anchor.windowCallbacks > 0 ? anchor.windowValid * 100 / anchor.windowCallbacks : 0;

  print("ID" + (index + 1) + " code=" + anchor.code + " callbacks=" + anchor.windowCallbacks + " valid=" + anchor.windowValid + " callback_rate=" + callbackRate.toFixed(2) + "/s valid_rate=" + validRate.toFixed(2) + "/s success=" + success.toFixed(0) + "% age=" + formatMetric(age, 1) + "s");
  print("ID" + (index + 1) + " dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(anchor.windowDistanceMin, 3) + " max=" + formatMetric(anchor.windowDistanceMax, 3) + " last=" + formatMetric(anchor.lastDistance, 3) + " lqi_avg=" + formatMetric(avgLqi, 2));
}

function printStats() {
  var now = sys.getUptime();
  var elapsed = now - statsWindowStartedAt;

  if (elapsed <= 0) {
    elapsed = 0.001;
  }

  var callbackRate = windowCallbacks / elapsed;
  var validRate = windowValid / elapsed;
  var success = windowCallbacks > 0 ? windowValid * 100 / windowCallbacks : 0;
  var avgDistance = windowValid > 0 ? windowDistanceSum / windowValid : null;
  var avgLqi = windowLqiCount > 0 ? windowLqiSum / windowLqiCount : null;

  print("=== LONG RANGE UWB RATE STATS ===");
  print("window=" + elapsed.toFixed(1) + "s callbacks=" + windowCallbacks + " valid=" + windowValid + " callback_rate=" + callbackRate.toFixed(2) + "/s valid_rate=" + validRate.toFixed(2) + "/s success=" + success.toFixed(0) + "%");
  print("total_callbacks=" + totalCallbacks + " total_valid=" + totalValid + " recent_anchors=" + recentAnchorCount() + "/" + anchors.length + " untracked=" + totalUntracked + " last_peer=" + lastPeer);
  print("dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(windowDistanceMin, 3) + " max=" + formatMetric(windowDistanceMax, 3) + " last=" + formatMetric(lastDistance, 3));
  print("lqi avg=" + formatMetric(avgLqi, 2) + " last=" + formatMetric(lastLqi, 2));

  for (var i = 0; i < anchors.length; i += 1) {
    printAnchorStats(anchors[i], i, elapsed);
  }

  if (windowUntracked > 0) {
    print("untracked window callbacks=" + windowUntracked + " (unexpected with fixed neighbours)");
  }

  resetStats(false);
}

function handleMeasurement(measurement) {
  if (paused || stoppingApp) {
    return;
  }

  lastMeasurementTime = sys.getUptime();
  totalCallbacks += 1;
  windowCallbacks += 1;

  var peer = String(measurement.id || measurement.peer || measurement.peerId || "unknown").toLowerCase();
  var distance = getDistance(measurement);
  var lqi = null;

  if (measurement.lqi !== undefined) {
    lqi = measurement.lqi;
  }

  lastPeer = peer;
  lastDistance = distance;
  lastLqi = lqi;

  if (distance !== null) {
    totalValid += 1;
    windowValid += 1;
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

  recordAnchorMeasurement(findAnchorIndex(peer), distance, lqi);
  maybePrintSample();
}

function startUwb() {
  if (uwbStarted) {
    return;
  }

  print("Starting UWB as TOF_INITIATOR with fixed neighbours...");

  try {
    uwb.start(
      uwb.Role.TOF_INITIATOR,
      buildUwbOptions(),
      function (measurement) {
        handleMeasurement(measurement);
      }
    );

    uwbStarted = true;
    print("uwb.start OK: TOF_INITIATOR, fixed neighbours");
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
    print("=== RESUME FIXED NEIGHBOURS RATE TEST ===");
    resetStats(true);
    lastMeasurementTime = 0;
    startUwb();
  } else {
    paused = true;
    print("=== PAUSE FIXED NEIGHBOURS RATE TEST ===");
    stopUwb();
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
  setSolid(io.Color.YELLOW);
  stopUwb();

  timers.single("500ms", function () {
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
    print("No UWB measurement yet. Check anchors, PAN_ID, mode, fixed neighbours, and distance.");
    return;
  }

  if (sys.getUptime() - lastMeasurementTime > 5) {
    print("No recent UWB measurement. Last data was more than 5s ago.");
  }
});

timers.repeat(STATS_TIMER, function () {
  if (paused || stoppingApp || !uwbStarted) {
    return;
  }

  printStats();
});

resetStats(true);
showError();
startUwb();
