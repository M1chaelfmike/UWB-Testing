var ANCHOR_NAME = "ANCHOR_A";
var PAN_ID = 0xCA57;
var UWB_MODE_NAME = "HIGH_RESPONSIVNESS";
var UWB_MODE = uwb.Mode.HIGH_RESPONSIVNESS;
var UWB_MIN_DISTANCE = 0.1;
var UWB_MAX_DISTANCE = 10;
var LED_BRIGHTNESS = 1.0;
var LED_FLASH_ON_MS = "45ms";
var LED_FLASH_OFF_MS = "45ms";
var MAX_PENDING_FLASHES = 8;
var STATS_TIMER = "10s";
var STATS_INTERVAL_SEC = 10;
var SAMPLE_PRINT_INTERVAL_SEC = 1;
var PRINT_RAW_TAG_MESSAGE = false;

var uwbStarted = false;
var uwbPaused = false;
var stoppingApp = false;
var flashing = false;
var pendingFlashes = 0;
var lastSamplePrintTime = 0;
var statsWindowStartedAt = 0;
var totalTagCallbacks = 0;
var windowTagCallbacks = 0;
var lastTagCallbackTime = 0;
var lastPeer = "none";
var lastDistance = null;
var lastLqi = null;

var UWB_OPTIONS = {
  timeout: 0,
  mode: UWB_MODE,
  panId: PAN_ID,
  minDistance: UWB_MIN_DISTANCE,
  maxDistance: UWB_MAX_DISTANCE
};

print("=== UWB LINK TEST ANCHOR ===");
print("Anchor name: " + ANCHOR_NAME);
print("Anchor ID: " + sys.getPublicId());
print("Battery: " + sensors.battery.getPerc() + "%");
print("Role: TOF_RESPONDER");
print("PAN ID: " + PAN_ID);
print("Mode: " + UWB_MODE_NAME);
print("Distance gate: " + UWB_MIN_DISTANCE + "m - " + UWB_MAX_DISTANCE + "m");
print("Stats window: " + STATS_INTERVAL_SEC + "s");

function setSolid(color) {
  io.setLedColor(color);
  io.setLedBrightness(LED_BRIGHTNESS);
  io.led(true);
}

function turnOffLeds() {
  io.led(false);
}

function setNoDataState() {
  if (!uwbPaused && !stoppingApp) {
    setSolid(io.Color.RED);
  }
}

function pulseDataState() {
  if (uwbPaused || stoppingApp) {
    return;
  }

  if (pendingFlashes < MAX_PENDING_FLASHES) {
    pendingFlashes += 1;
  }

  runFlashQueue();
}

function runFlashQueue() {
  if (flashing || pendingFlashes <= 0 || uwbPaused || stoppingApp) {
    return;
  }

  flashing = true;
  pendingFlashes -= 1;

  setSolid(io.Color.GREEN);

  timers.single(LED_FLASH_ON_MS, function () {
    if (uwbPaused || stoppingApp) {
      flashing = false;
      return;
    }

    setNoDataState();

    timers.single(LED_FLASH_OFF_MS, function () {
      flashing = false;

      if (pendingFlashes > 0) {
        runFlashQueue();
      } else {
        setNoDataState();
      }
    });
  });
}

function getDistance(message) {
  if (!message) {
    return null;
  }

  if (message.dist !== undefined) {
    return message.dist;
  }

  if (message.distance !== undefined) {
    return message.distance;
  }

  if (message.range !== undefined) {
    return message.range;
  }

  return null;
}

function getPeerId(message) {
  if (!message) {
    return "unknown";
  }

  return message.id || message.peer || message.peerId || message.tagId || message.initiatorId || "unknown";
}

function getPayload(message) {
  if (!message) {
    return null;
  }

  if (message.payload !== undefined) {
    return message.payload;
  }

  if (message.data !== undefined) {
    return message.data;
  }

  if (message.message !== undefined) {
    return message.message;
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

function resetAnchorStats(resetTotals) {
  statsWindowStartedAt = sys.getUptime();
  windowTagCallbacks = 0;
  lastSamplePrintTime = 0;

  if (resetTotals) {
    totalTagCallbacks = 0;
    lastTagCallbackTime = 0;
    lastPeer = "none";
    lastDistance = null;
    lastLqi = null;
  }
}

function recordTagCallback(message) {
  totalTagCallbacks += 1;
  windowTagCallbacks += 1;
  lastTagCallbackTime = sys.getUptime();

  if (message === undefined || message === null) {
    lastPeer = "no-payload";
    lastDistance = null;
    lastLqi = null;
    return;
  }

  lastPeer = getPeerId(message);
  lastDistance = getDistance(message);
  lastLqi = message.lqi !== undefined ? message.lqi : null;
}

function maybePrintAnchorSample() {
  if (SAMPLE_PRINT_INTERVAL_SEC <= 0) {
    return;
  }

  var now = sys.getUptime();

  if (now - lastSamplePrintTime < SAMPLE_PRINT_INTERVAL_SEC) {
    return;
  }

  lastSamplePrintTime = now;
  print("ANCHOR rx peer=" + lastPeer + " dist=" + formatMetric(lastDistance, 3) + "m lqi=" + formatMetric(lastLqi, 2) + " total_rx=" + totalTagCallbacks);
}

function printAnchorStats() {
  var now = sys.getUptime();
  var elapsed = now - statsWindowStartedAt;

  if (elapsed <= 0) {
    elapsed = 0.001;
  }

  var rate = windowTagCallbacks / elapsed;
  var age = lastTagCallbackTime > 0 ? now - lastTagCallbackTime : null;

  print("=== ANCHOR RX STATS ===");
  print("window=" + elapsed.toFixed(1) + "s callbacks=" + windowTagCallbacks + " rx_rate=" + rate.toFixed(2) + "/s total_rx=" + totalTagCallbacks);
  print("last_peer=" + lastPeer + " last_age=" + formatMetric(age, 1) + "s last_dist=" + formatMetric(lastDistance, 3) + "m last_lqi=" + formatMetric(lastLqi, 2));

  resetAnchorStats(false);
}

function handleTagMessage(message) {
  pulseDataState();
  recordTagCallback(message);
  maybePrintAnchorSample();

  if (PRINT_RAW_TAG_MESSAGE) {
    try {
      print("Raw: " + JSON.stringify(message));
    } catch (e) {
      print("Raw print error: " + e);
    }
  }
}

function startUwb() {
  if (uwbStarted || stoppingApp) {
    return;
  }

  try {
    uwb.start(
      uwb.Role.TOF_RESPONDER,
      UWB_OPTIONS,
      function (message) {
        handleTagMessage(message);
      }
    );

    uwbStarted = true;
    print("uwb.start OK: TOF_RESPONDER");
  } catch (e) {
    print("uwb.start ERROR: " + e);
    setNoDataState();
  }
}

function stopUwb() {
  if (!uwbStarted) {
    return;
  }

  try {
    uwb.stop(true);
    uwbStarted = false;
    print("uwb.stop OK");
  } catch (e) {
    print("uwb.stop ERROR: " + e);
  }
}

function togglePause() {
  if (stoppingApp) {
    return;
  }

  if (uwbPaused) {
    uwbPaused = false;
    print("Button pressed: UWB resumed");
    setNoDataState();
    resetAnchorStats(true);
    startUwb();
  } else {
    uwbPaused = true;
    print("Button pressed: UWB paused");
    stopUwb();
    setSolid(io.Color.BLUE);
  }
}

function stopApplication() {
  if (stoppingApp) {
    return;
  }

  stoppingApp = true;
  uwbPaused = true;

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

timers.repeat(STATS_TIMER, function () {
  if (uwbPaused || stoppingApp || !uwbStarted) {
    return;
  }

  printAnchorStats();
});

resetAnchorStats(true);
setNoDataState();
startUwb();
