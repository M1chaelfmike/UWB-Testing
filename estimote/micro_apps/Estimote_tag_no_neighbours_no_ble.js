var TAG_NAME = "WEARABLE_TAG_NO_NEIGHBOURS_NO_BLE";
var PAN_ID = 0xCA57;
var UWB_MODE_NAME = "HIGH_RESPONSIVNESS";
var UWB_MODE = uwb.Mode.HIGH_RESPONSIVNESS;
var UWB_MIN_DISTANCE = 0.1;
var UWB_MAX_DISTANCE = 10;
var LED_BRIGHTNESS = 1.0;
var STATS_TIMER = "5s";
var STATS_INTERVAL_SEC = 5;
var SAMPLE_PRINT_INTERVAL_SEC = 0;
var PRINT_RAW_SAMPLE = false;
var MAX_TRACKED_PEERS = 12;
var RECENT_PEER_TIMEOUT_SEC = 3.0;
var SELF_ID = String(sys.getPublicId()).toLowerCase();

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
var overflowCallbacks = 0;
var lastPeer = "none";
var lastDistance = null;
var lastLqi = null;
var peers = [];

print("=== UWB TAG RAW RATE TEST ===");
print("Tag name: " + TAG_NAME);
print("Tag ID: " + SELF_ID);
print("Battery: " + sensors.battery.getPerc() + "%");
print("Role: TOF_INITIATOR");
print("PAN ID: " + PAN_ID);
print("Mode: " + UWB_MODE_NAME);
print("Distance gate: " + UWB_MIN_DISTANCE + "m - " + UWB_MAX_DISTANCE + "m");
print("Neighbours: OFF, options.neighbours omitted");
print("BLE advertising: OFF");
print("Stats window: " + STATS_INTERVAL_SEC + "s");

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

function buildUwbOptions() {
  return {
    timeout: 0,
    mode: UWB_MODE,
    panId: PAN_ID,
    minDistance: UWB_MIN_DISTANCE,
    maxDistance: UWB_MAX_DISTANCE
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

function codeForId(peerId) {
  for (var i = 0; i < KNOWN_NODE_IDS.length; i += 1) {
    if (idsMatch(peerId, KNOWN_NODE_IDS[i])) {
      return KNOWN_ANCHOR_CODES[i];
    }
  }

  return 0;
}

function findPeerIndex(peerId) {
  for (var i = 0; i < peers.length; i += 1) {
    if (idsMatch(peerId, peers[i].id)) {
      return i;
    }
  }

  return -1;
}

function newPeer(peerId) {
  return {
    id: peerId,
    code: codeForId(peerId),
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
  };
}

function resetPeerWindow(peer) {
  peer.windowCallbacks = 0;
  peer.windowValid = 0;
  peer.windowDistanceSum = 0;
  peer.windowDistanceMin = null;
  peer.windowDistanceMax = null;
  peer.windowLqiSum = 0;
  peer.windowLqiCount = 0;
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
  lastSamplePrintTime = 0;

  if (resetTotals) {
    totalCallbacks = 0;
    totalValid = 0;
    overflowCallbacks = 0;
    lastPeer = "none";
    lastDistance = null;
    lastLqi = null;
    peers = [];
  } else {
    for (var i = 0; i < peers.length; i += 1) {
      resetPeerWindow(peers[i]);
    }
  }
}

function recordDistanceStats(peer, distance, lqi) {
  peer.totalCallbacks += 1;
  peer.windowCallbacks += 1;
  peer.lastSeen = sys.getUptime();
  peer.lastDistance = distance;
  peer.lastLqi = lqi;

  if (distance !== null) {
    peer.totalValid += 1;
    peer.windowValid += 1;
    peer.windowDistanceSum += distance;

    if (peer.windowDistanceMin === null || distance < peer.windowDistanceMin) {
      peer.windowDistanceMin = distance;
    }

    if (peer.windowDistanceMax === null || distance > peer.windowDistanceMax) {
      peer.windowDistanceMax = distance;
    }
  }

  if (lqi !== null) {
    peer.windowLqiSum += lqi;
    peer.windowLqiCount += 1;
  }
}

function recordMeasurement(peerId, distance, lqi) {
  var index = findPeerIndex(peerId);

  if (index < 0) {
    if (peers.length >= MAX_TRACKED_PEERS) {
      overflowCallbacks += 1;
      return;
    }

    peers.push(newPeer(peerId));
    index = peers.length - 1;
    print("Discovered peer #" + (index + 1) + ": code=" + peers[index].code + " id=" + peerId);
  }

  recordDistanceStats(peers[index], distance, lqi);
}

function recentPeerCount() {
  var count = 0;
  var now = sys.getUptime();

  for (var i = 0; i < peers.length; i += 1) {
    if (peers[i].lastSeen > 0 && now - peers[i].lastSeen <= RECENT_PEER_TIMEOUT_SEC) {
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
  print("sample peer=" + lastPeer + " dist=" + formatMetric(lastDistance, 3) + "m lqi=" + formatMetric(lastLqi, 2) + " total_valid=" + totalValid + " recent_peers=" + recentPeerCount());
}

function printPeerStats(peer, index, elapsed) {
  var avgDistance = peer.windowValid > 0 ? peer.windowDistanceSum / peer.windowValid : null;
  var avgLqi = peer.windowLqiCount > 0 ? peer.windowLqiSum / peer.windowLqiCount : null;
  var age = peer.lastSeen > 0 ? sys.getUptime() - peer.lastSeen : null;
  var callbackRate = peer.windowCallbacks / elapsed;
  var validRate = peer.windowValid / elapsed;
  var success = peer.windowCallbacks > 0 ? peer.windowValid * 100 / peer.windowCallbacks : 0;

  print("peer#" + (index + 1) + " code=" + peer.code + " callbacks=" + peer.windowCallbacks + " valid=" + peer.windowValid + " callback_rate=" + callbackRate.toFixed(2) + "/s valid_rate=" + validRate.toFixed(2) + "/s success=" + success.toFixed(0) + "% age=" + formatMetric(age, 1) + "s");
  print("peer#" + (index + 1) + " id=" + peer.id);
  print("peer#" + (index + 1) + " dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(peer.windowDistanceMin, 3) + " max=" + formatMetric(peer.windowDistanceMax, 3) + " last=" + formatMetric(peer.lastDistance, 3) + " lqi_avg=" + formatMetric(avgLqi, 2));
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

  print("=== RAW UWB RATE STATS ===");
  print("window=" + elapsed.toFixed(1) + "s callbacks=" + windowCallbacks + " valid=" + windowValid + " callback_rate=" + callbackRate.toFixed(2) + "/s valid_rate=" + validRate.toFixed(2) + "/s success=" + success.toFixed(0) + "%");
  print("total_callbacks=" + totalCallbacks + " total_valid=" + totalValid + " peers=" + peers.length + " recent_peers=" + recentPeerCount() + " overflow=" + overflowCallbacks + " last_peer=" + lastPeer);
  print("dist_m avg=" + formatMetric(avgDistance, 3) + " min=" + formatMetric(windowDistanceMin, 3) + " max=" + formatMetric(windowDistanceMax, 3) + " last=" + formatMetric(lastDistance, 3));
  print("lqi avg=" + formatMetric(avgLqi, 2) + " last=" + formatMetric(lastLqi, 2));

  for (var i = 0; i < peers.length; i += 1) {
    printPeerStats(peers[i], i, elapsed);
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

  if (!idsMatch(peer, SELF_ID)) {
    recordMeasurement(peer, distance, lqi);
  }

  if (PRINT_RAW_SAMPLE) {
    try {
      print("raw=" + JSON.stringify(measurement));
    } catch (e) {
      print("raw print error: " + e);
    }
  }

  maybePrintSample();
}

function startUwb() {
  if (uwbStarted) {
    return;
  }

  print("Starting UWB as TOF_INITIATOR without neighbours...");

  try {
    uwb.start(
      uwb.Role.TOF_INITIATOR,
      buildUwbOptions(),
      function (measurement) {
        handleMeasurement(measurement);
      }
    );

    uwbStarted = true;
    print("uwb.start OK: TOF_INITIATOR, neighbours omitted");
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
    print("=== RESUME UWB RAW RATE TEST ===");
    resetStats(true);
    lastMeasurementTime = 0;
    startUwb();
  } else {
    paused = true;
    print("=== PAUSE UWB RAW RATE TEST ===");
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
    print("No UWB measurement yet. This script has no neighbours filter, so check PAN_ID, mode, responders, and distance.");
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
