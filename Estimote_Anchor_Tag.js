var ANCHOR_NAME = "ANCHOR_A";
var PAN_ID = 0xCA57;
var LED_BRIGHTNESS = 1.0;
var LED_FLASH_ON_MS = "45ms";
var LED_FLASH_OFF_MS = "45ms";
var MAX_PENDING_FLASHES = 8;

var uwbStarted = false;
var uwbPaused = false;
var stoppingApp = false;
var flashing = false;
var pendingFlashes = 0;

var UWB_OPTIONS = {
  timeout: 0,
  mode: uwb.Mode.LONG_RANGE,
  panId: PAN_ID,
  minDistance: 0.1,
  maxDistance: 20
};

print("=== EverCare UWB Anchor Started ===");
print("Anchor name: " + ANCHOR_NAME);
print("Anchor ID: " + sys.getPublicId());
print("Battery: " + sensors.battery.getPerc() + "%");
print("PAN ID: " + PAN_ID);

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

function startUwb() {
  if (uwbStarted || stoppingApp) {
    return;
  }

  try {
    uwb.start(
      uwb.Role.TOF_RESPONDER,
      UWB_OPTIONS,
      function () {
        pulseDataState();
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
setNoDataState();
startUwb();
