var LED_BRIGHTNESS = 1.0;
var SHOW_MS = "3000ms";
var BLINK_ON_MS = "180ms";
var BLINK_OFF_MS = "180ms";

var showingBattery = false;
var singleLedMode = null;

print("=== Battery 4-LED Indicator Started ===");
print("Device ID: " + sys.getPublicId());
print("Battery: " + sensors.battery.getPerc() + "%");
print("Short press: show battery");

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}

function batteryLevel(percent) {
  if (percent <= 0) {
    return 0;
  }

  return clamp(Math.ceil(percent / 25), 1, 4);
}

function batteryColor(percent) {
  if (percent <= 25) {
    return io.Color.RED;
  }

  if (percent <= 50) {
    return io.Color.YELLOW;
  }

  if (percent <= 75) {
    return io.Color.BLUE;
  }

  return io.Color.GREEN;
}

function allOff() {
  try {
    io.led(false);
  } catch (e) {
    print("LED off error: " + e);
  }
}

function setAll(color, on) {
  try {
    io.setLedColor(color);
    io.setLedBrightness(LED_BRIGHTNESS);
    io.led(on);
  } catch (e) {
    print("LED set error: " + e);
  }
}

function setOneLed(index, color, on) {
  // Some Estimote firmware exposes only all-LED control. If indexed LED calls
  // are unavailable, this function returns false and the app falls back to blink mode.
  try {
    io.setLedColor(index, color);
    io.setLedBrightness(index, LED_BRIGHTNESS);
    io.led(index, on);
    return true;
  } catch (e1) {
    try {
      io.setLedColor(color, index);
      io.setLedBrightness(LED_BRIGHTNESS, index);
      io.led(on, index);
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function showFourLedBar(percent) {
  var level = batteryLevel(percent);
  var color = batteryColor(percent);
  var ok = true;

  for (var i = 0; i < 4; i += 1) {
    if (!setOneLed(i, color, i < level)) {
      ok = false;
      break;
    }
  }

  if (!ok) {
    return false;
  }

  timers.single(SHOW_MS, function () {
    for (var j = 0; j < 4; j += 1) {
      setOneLed(j, color, false);
    }

    showingBattery = false;
  });

  return true;
}

function blinkLevel(level, color, step) {
  if (step >= level) {
    showingBattery = false;
    allOff();
    return;
  }

  setAll(color, true);

  timers.single(BLINK_ON_MS, function () {
    allOff();

    timers.single(BLINK_OFF_MS, function () {
      blinkLevel(level, color, step + 1);
    });
  });
}

function showBlinkFallback(percent) {
  var level = batteryLevel(percent);
  var color = batteryColor(percent);

  blinkLevel(level, color, 0);
}

function showBattery() {
  if (showingBattery) {
    return;
  }

  showingBattery = true;

  var percent = sensors.battery.getPerc();
  var level = batteryLevel(percent);

  print("Battery: " + percent + "%, level " + level + "/4");

  if (singleLedMode !== false) {
    if (showFourLedBar(percent)) {
      singleLedMode = true;
      return;
    }

    singleLedMode = false;
    print("Indexed LED control not available; using blink fallback.");
  }

  showBlinkFallback(percent);
}

io.press(showBattery, io.PressType.SHORT);

allOff();
