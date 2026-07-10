package com.evercare.estimoteweargateway;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.text.InputType;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {
    private static final String TAG = "EstimoteWearGateway";
    private static final String DEFAULT_SERVER_HOST = "192.168.0.2";
    private static final int DEFAULT_SERVER_PORT = 8088;
    private static final String SERVER_PATH = "/estimote";
    private static final String PREFERENCES_NAME = "gateway_settings";
    private static final String PREFERENCE_SERVER_HOST = "server_host";
    private static final String PREFERENCE_SERVER_PORT = "server_port";
    private static final ParcelUuid ESTIMOTE_SERVICE_UUID =
            ParcelUuid.fromString("0000fe9a-0000-1000-8000-00805f9b34fb");
    private static final int REQUEST_PERMISSIONS = 1001;
    private static final int PAYLOAD_MAGIC = 0xEC;
    private static final int PAYLOAD_VERSION_V2 = 0x02;
    private static final int PAYLOAD_VERSION_V3 = 0x03;
    private static final int ANCHOR_COUNT = 4;
    private static final int INVALID_DISTANCE_CM = 65535;
    private static final int INVALID_LQI = 255;
    private static final int HTTP_TIMEOUT_MS = 350;
    private static final long MAX_POST_AGE_MS = 1000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService httpExecutor = Executors.newSingleThreadExecutor();
    private final Object postLock = new Object();
    private final AtomicInteger scanCount = new AtomicInteger();
    private final AtomicInteger receivedCount = new AtomicInteger();
    private final AtomicInteger postedCount = new AtomicInteger();
    private final AtomicInteger failedPostCount = new AtomicInteger();
    private final AtomicInteger droppedPostCount = new AtomicInteger();
    private final AtomicInteger replacedPostCount = new AtomicInteger();

    private BluetoothLeScanner scanner;
    private boolean scanning = false;
    private boolean postWorkerRunning = false;
    private long scanStartedAtMs = 0;
    private JSONObject pendingPostBody = null;
    private String lastSource = "";
    private int lastAdvSeq = -1;
    private volatile String serverHost;
    private volatile int serverPort;
    private TextView statusView;
    private TextView serverView;
    private TextView detailView;
    private Button startButton;
    private Button stopButton;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            handleScanResult(result);
        }

        @Override
        public void onBatchScanResults(java.util.List<ScanResult> results) {
            for (ScanResult result : results) {
                handleScanResult(result);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            setStatus("Scan failed: " + errorCode);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loadServerSettings();
        Log.i(TAG, "onCreate server=" + serverUrl());
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        buildUi();
        ensurePermissions();
    }

    @Override
    protected void onDestroy() {
        stopScan();
        httpExecutor.shutdownNow();
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(18, 18, 18, 18);

        statusView = new TextView(this);
        statusView.setTextColor(0xFFFFFFFF);
        statusView.setTextSize(16);
        statusView.setGravity(Gravity.CENTER);
        statusView.setText("Estimote BLE Gateway");

        serverView = new TextView(this);
        serverView.setTextColor(0xFFB0BEC5);
        serverView.setTextSize(12);
        serverView.setGravity(Gravity.CENTER);
        updateServerView();

        Button serverSettingsButton = new Button(this);
        serverSettingsButton.setText("Server settings");
        serverSettingsButton.setOnClickListener(view -> showServerSettings());

        detailView = new TextView(this);
        detailView.setTextColor(0xFFB0BEC5);
        detailView.setTextSize(12);
        detailView.setGravity(Gravity.CENTER);
        detailView.setText("Ready to scan");

        startButton = new Button(this);
        startButton.setText("Start");
        startButton.setOnClickListener(view -> startScan());

        stopButton = new Button(this);
        stopButton.setText("Stop");
        stopButton.setOnClickListener(view -> stopScan());

        root.addView(statusView);
        root.addView(serverView);
        root.addView(serverSettingsButton);
        root.addView(startButton);
        root.addView(stopButton);
        root.addView(detailView);
        scrollView.addView(root);
        setContentView(scrollView);
    }

    private void loadServerSettings() {
        SharedPreferences preferences = getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE);
        serverHost = preferences.getString(PREFERENCE_SERVER_HOST, DEFAULT_SERVER_HOST);
        serverPort = preferences.getInt(PREFERENCE_SERVER_PORT, DEFAULT_SERVER_PORT);
        if (!isValidHost(serverHost) || !isValidPort(serverPort)) {
            serverHost = DEFAULT_SERVER_HOST;
            serverPort = DEFAULT_SERVER_PORT;
        }
    }

    private void showServerSettings() {
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        int padding = 24;
        form.setPadding(padding, padding, padding, padding);

        TextView hostLabel = new TextView(this);
        hostLabel.setText("PC IP address or hostname");
        EditText hostInput = new EditText(this);
        hostInput.setSingleLine(true);
        hostInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        hostInput.setText(serverHost);

        TextView portLabel = new TextView(this);
        portLabel.setText("Port");
        EditText portInput = new EditText(this);
        portInput.setSingleLine(true);
        portInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        portInput.setText(String.valueOf(serverPort));

        form.addView(hostLabel);
        form.addView(hostInput);
        form.addView(portLabel);
        form.addView(portInput);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Server settings")
                .setView(form)
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Save", null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    String host = hostInput.getText().toString().trim();
                    int port;
                    try {
                        port = Integer.parseInt(portInput.getText().toString().trim());
                    } catch (NumberFormatException e) {
                        portInput.setError("Enter a port from 1 to 65535");
                        return;
                    }
                    if (!isValidHost(host)) {
                        hostInput.setError("Enter an IP address or hostname");
                        return;
                    }
                    if (!isValidPort(port)) {
                        portInput.setError("Enter a port from 1 to 65535");
                        return;
                    }
                    serverHost = host;
                    serverPort = port;
                    getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).edit()
                            .putString(PREFERENCE_SERVER_HOST, host)
                            .putInt(PREFERENCE_SERVER_PORT, port)
                            .apply();
                    Log.i(TAG, "server updated to " + serverUrl());
                    updateServerView();
                    dialog.dismiss();
                }));
        dialog.show();
    }

    private boolean isValidHost(String host) {
        return host != null && !host.isEmpty() && !host.contains(":") && !host.contains("/")
                && !host.contains(" ");
    }

    private boolean isValidPort(int port) {
        return port >= 1 && port <= 65535;
    }

    private String serverUrl() {
        return "http://" + serverHost + ":" + serverPort + SERVER_PATH;
    }

    private void updateServerView() {
        if (serverView != null) {
            serverView.setText("Server: " + serverUrl());
        }
    }

    private void ensurePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.ACCESS_FINE_LOCATION
            }, REQUEST_PERMISSIONS);
        } else {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION
            }, REQUEST_PERMISSIONS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_PERMISSIONS) {
            return;
        }

        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "permission denied");
                setStatus("Permission denied");
                return;
            }
        }

        Log.i(TAG, "permissions granted");
        setStatus("Ready");
    }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startScan() {
        if (scanning) {
            return;
        }

        if (!hasScanPermission()) {
            Log.w(TAG, "missing scan permission, requesting again");
            ensurePermissions();
            return;
        }

        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            Log.w(TAG, "bluetooth is off or unavailable");
            setStatus("Bluetooth is off");
            return;
        }

        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            Log.w(TAG, "BLE scanner unavailable");
            setStatus("BLE scanner unavailable");
            return;
        }

        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                .setNumOfMatches(ScanSettings.MATCH_NUM_MAX_ADVERTISEMENT)
                .setReportDelay(0)
                .build();

        try {
            Log.i(TAG, "startScan low latency, no filters");
            scanner.startScan(null, settings, scanCallback);
            scanning = true;
            scanStartedAtMs = System.currentTimeMillis();
            setStatus("Scanning FE9A");
            scheduleScanWatchdog();
        } catch (SecurityException e) {
            Log.e(TAG, "scan permission error", e);
            setStatus("Scan permission error");
        } catch (Exception e) {
            Log.e(TAG, "startScan failed", e);
            setStatus("Start scan failed: " + e.getClass().getSimpleName());
        }
    }

    private void stopScan() {
        if (!scanning || scanner == null) {
            return;
        }

        try {
            Log.i(TAG, "stopScan");
            scanner.stopScan(scanCallback);
        } catch (SecurityException ignored) {
        }

        scanning = false;
        setStatus("Stopped");
    }

    private void handleScanResult(ScanResult result) {
        int scans = scanCount.incrementAndGet();
        if (scans <= 5 || scans % 50 == 0) {
            Log.i(TAG, "SCAN CALLBACK count=" + scans + " rssi=" + result.getRssi());
        }
        ScanRecord record = result.getScanRecord();
        if (record == null) {
            Log.d(TAG, "scan result has no ScanRecord");
            updateScanOnly(result, "no scan record", scans);
            return;
        }

        byte[] payload = record.getServiceData(ESTIMOTE_SERVICE_UUID);
        if (payload == null) {
            payload = findEstimoteServiceData(record);
        }
        if (payload == null) {
            payload = findEstimoteServiceDataFromRaw(record.getBytes());
        }

        if (payload == null) {
            if (scans <= 5 || scans % 50 == 0) {
                Log.i(TAG, "scan without FE9A: " + serviceSummary(record));
            }
            updateScanOnly(result, serviceSummary(record), scans);
            return;
        }

        EstimoteFrame frame = decodePayload(payload);
        if (frame == null) {
            Log.w(TAG, "found FE9A but payload is undecodable len=" + payload.length + " raw=" + toHex(payload));
            updateScanOnly(result, "FE9A undecodable len=" + payload.length, scans);
            return;
        }

        String source = safeAddress(result.getDevice());
        if (source.equals(lastSource) && frame.advSeq == lastAdvSeq) {
            return;
        }
        lastSource = source;
        lastAdvSeq = frame.advSeq;

        Log.i(TAG, "FE9A frame source=" + source + " adv=" + frame.advSeq + " sync=" + frame.syncSeq
                + " valid=" + frame.validCount + " rssi=" + result.getRssi());
        receivedCount.incrementAndGet();
        JSONObject body = buildJson(result, source, frame, payload);
        postJson(body);
        updateDetails(source, result.getRssi(), frame);
    }

    private void scheduleScanWatchdog() {
        mainHandler.postDelayed(() -> {
            if (!scanning) {
                return;
            }

            int scans = scanCount.get();
            int rx = receivedCount.get();
            long ageMs = System.currentTimeMillis() - scanStartedAtMs;
            Log.i(TAG, "watchdog ageMs=" + ageMs + " scan=" + scans + " rx=" + rx
                    + " posted=" + postedCount.get() + " fail=" + failedPostCount.get());

            if (scans == 0) {
                detailView.setText("No BLE callbacks yet\n"
                        + "Check Location permission\n"
                        + "Disable power saving\n"
                        + "Keep app foreground");
            } else if (rx == 0) {
                detailView.setText("BLE callbacks yes, FE9A no\n"
                        + "scan " + scans + " rx 0\n"
                        + "Move watch near tag\n"
                        + "Confirm tag advertises FE9A");
            }

            scheduleScanWatchdog();
        }, 5000);
    }

    private byte[] findEstimoteServiceData(ScanRecord record) {
        Map<ParcelUuid, byte[]> serviceData = record.getServiceData();
        if (serviceData == null) {
            return null;
        }

        for (Map.Entry<ParcelUuid, byte[]> entry : serviceData.entrySet()) {
            String normalized = entry.getKey().getUuid().toString().replace("-", "").toLowerCase(Locale.US);
            if (normalized.equals("0000fe9a00001000800000805f9b34fb") || normalized.equals("fe9a")) {
                return entry.getValue();
            }
        }

        return null;
    }

    private byte[] findEstimoteServiceDataFromRaw(byte[] raw) {
        if (raw == null) {
            return null;
        }

        int index = 0;
        while (index < raw.length) {
            int length = raw[index] & 0xFF;
            if (length == 0) {
                break;
            }

            int typeIndex = index + 1;
            int nextIndex = index + 1 + length;
            if (typeIndex >= raw.length || nextIndex > raw.length) {
                break;
            }

            int adType = raw[typeIndex] & 0xFF;
            if (adType == 0x16 && length >= 3) {
                int uuid16 = (raw[typeIndex + 1] & 0xFF) | ((raw[typeIndex + 2] & 0xFF) << 8);
                if (uuid16 == 0xFE9A) {
                    int payloadOffset = typeIndex + 3;
                    int payloadLength = nextIndex - payloadOffset;
                    byte[] payload = new byte[payloadLength];
                    System.arraycopy(raw, payloadOffset, payload, 0, payloadLength);
                    return payload;
                }
            }

            index = nextIndex;
        }

        return null;
    }

    private JSONObject buildJson(ScanResult result, String source, EstimoteFrame frame, byte[] rawPayload) {
        JSONObject body = new JSONObject();
        try {
            body.put("watch_time_ms", System.currentTimeMillis());
            body.put("watch_time_iso", isoNow());
            body.put("source", source);
            body.put("device_name", safeName(result.getDevice()));
            body.put("rssi", result.getRssi());
            body.put("raw_hex", toHex(rawPayload));
            body.put("payload_version", frame.payloadVersion);
            body.put("adv_seq", frame.advSeq);
            body.put("flags", frame.flags);
            body.put("paused", frame.paused);
            body.put("valid_count", frame.validCount);
            body.put("battery", frame.battery);
            body.put("sync_seq", frame.syncSeq);
            body.put("sync_span_s", frame.syncSpanS == null ? JSONObject.NULL : frame.syncSpanS);
            body.put("anchor_codes", toJsonArray(frame.anchorCodes));
            body.put("anchor_labels", toJsonArray(frame.anchorLabels));
            body.put("distances_m", toJsonArray(frame.distancesM));
            body.put("lqi", toJsonArray(frame.lqi));
            body.put("ages_s", toJsonArray(frame.agesS));
        } catch (JSONException ignored) {
        }
        return body;
    }

    private void postJson(JSONObject body) {
        synchronized (postLock) {
            if (pendingPostBody != null) {
                replacedPostCount.incrementAndGet();
            }

            pendingPostBody = body;

            if (postWorkerRunning) {
                return;
            }

            postWorkerRunning = true;
        }

        httpExecutor.execute(this::drainLatestPost);
    }

    private void drainLatestPost() {
        while (true) {
            JSONObject body;

            synchronized (postLock) {
                body = pendingPostBody;
                pendingPostBody = null;

                if (body == null) {
                    postWorkerRunning = false;
                    return;
                }
            }

            long ageMs = System.currentTimeMillis() - body.optLong("watch_time_ms", System.currentTimeMillis());
            if (ageMs > MAX_POST_AGE_MS) {
                droppedPostCount.incrementAndGet();
                Log.w(TAG, "drop stale HTTP frame ageMs=" + ageMs);
                continue;
            }

            sendJsonNow(body);
        }
    }

    private void sendJsonNow(JSONObject body) {
        HttpURLConnection connection = null;
        try {
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            URL url = new URL(serverUrl());
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(HTTP_TIMEOUT_MS);
            connection.setReadTimeout(HTTP_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(data);
            }

            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                Log.d(TAG, "POST ok status=" + status);
                postedCount.incrementAndGet();
            } else {
                Log.w(TAG, "POST failed status=" + status);
                failedPostCount.incrementAndGet();
            }
        } catch (Exception e) {
            Log.w(TAG, "POST exception: " + e.getClass().getSimpleName() + " " + e.getMessage());
            failedPostCount.incrementAndGet();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void updateDetails(String source, int rssi, EstimoteFrame frame) {
        String text = "src " + source + "\n"
                + "anchors " + joinLabels(frame.anchorLabels) + "\n"
                + "adv " + frame.advSeq + " sync " + frame.syncSeq + " valid " + frame.validCount + "/4\n"
                + "rssi " + rssi + " batt " + frame.battery + "%\n"
                + "scan " + scanCount.get() + " rx " + receivedCount.get() + " posted " + postedCount.get()
                + " fail " + failedPostCount.get() + "\n"
                + "drop " + droppedPostCount.get() + " replaced " + replacedPostCount.get();
        mainHandler.post(() -> detailView.setText(text));
    }

    private void updateScanOnly(ScanResult result, String reason, int scans) {
        if (scans % 20 != 0) {
            return;
        }

        String text = "scanning, no FE9A yet\n"
                + "scan " + scans + " rx " + receivedCount.get() + " posted " + postedCount.get()
                + " fail " + failedPostCount.get() + "\n"
                + "drop " + droppedPostCount.get() + " replaced " + replacedPostCount.get() + "\n"
                + "last rssi " + result.getRssi() + "\n"
                + reason;
        mainHandler.post(() -> detailView.setText(text));
    }

    private String serviceSummary(ScanRecord record) {
        Map<ParcelUuid, byte[]> serviceData = record.getServiceData();
        if (serviceData == null || serviceData.isEmpty()) {
            return "serviceData empty";
        }

        StringBuilder builder = new StringBuilder("serviceData ");
        for (ParcelUuid uuid : serviceData.keySet()) {
            builder.append(uuid.getUuid()).append(" ");
        }
        return builder.toString();
    }

    private void setStatus(String text) {
        mainHandler.post(() -> statusView.setText(text));
    }

    private EstimoteFrame decodePayload(byte[] data) {
        if (data.length < 18) {
            return null;
        }
        int version = data[1] & 0xFF;
        if ((data[0] & 0xFF) != PAYLOAD_MAGIC || (version != PAYLOAD_VERSION_V2 && version != PAYLOAD_VERSION_V3)) {
            return null;
        }
        if (version == PAYLOAD_VERSION_V3 && data.length < 24) {
            return null;
        }

        EstimoteFrame frame = new EstimoteFrame();
        frame.payloadVersion = version;
        frame.advSeq = data[2] & 0xFF;
        frame.flags = data[3] & 0xFF;
        frame.paused = (frame.flags & 0x10) != 0;
        frame.distancesM = new Double[ANCHOR_COUNT];
        frame.lqi = new Double[ANCHOR_COUNT];
        frame.anchorCodes = new int[ANCHOR_COUNT];
        frame.anchorLabels = new String[ANCHOR_COUNT];

        int distanceOffset = 4;
        if (version == PAYLOAD_VERSION_V3) {
            distanceOffset = 8;
            for (int i = 0; i < ANCHOR_COUNT; i += 1) {
                int code = data[4 + i] & 0xFF;
                frame.anchorCodes[i] = code;
                frame.anchorLabels[i] = anchorLabelForCode(code);
            }
        } else {
            for (int i = 0; i < ANCHOR_COUNT; i += 1) {
                frame.anchorCodes[i] = 0;
                frame.anchorLabels[i] = "";
            }
        }

        for (int i = 0; i < ANCHOR_COUNT; i += 1) {
            int cm = readUint16Le(data, distanceOffset + i * 2);
            frame.distancesM[i] = cm == INVALID_DISTANCE_CM ? null : cm / 100.0;
        }

        for (int i = 0; i < ANCHOR_COUNT; i += 1) {
            if (version == PAYLOAD_VERSION_V2) {
                int value = data[12 + i] & 0xFF;
                frame.lqi[i] = value == INVALID_LQI ? null : value / 100.0;
            } else {
                frame.lqi[i] = null;
            }
        }

        frame.battery = data[16] & 0xFF;
        frame.validCount = data[17] & 0xFF;
        frame.syncSeq = null;
        frame.agesS = new Double[]{null, null, null, null};
        frame.syncSpanS = null;

        if (data.length >= 24) {
            frame.syncSeq = data[18] & 0xFF;
            frame.agesS = new Double[ANCHOR_COUNT];
            for (int i = 0; i < ANCHOR_COUNT; i += 1) {
                int value = data[19 + i] & 0xFF;
                frame.agesS[i] = value == 255 ? null : value / 10.0;
            }
            int span = data[23] & 0xFF;
            frame.syncSpanS = span == 255 ? null : span / 10.0;
        }

        return frame;
    }

    private int readUint16Le(byte[] data, int offset) {
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private String anchorLabelForCode(int code) {
        switch (code) {
            case 121:
                return "121";
            case 99:
                return "099";
            case 85:
                return "085";
            case 87:
                return "087";
            case 86:
                return "086";
            case 105:
                return "105";
            default:
                return code == 0 ? "" : String.valueOf(code);
        }
    }

    private JSONArray toJsonArray(Double[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (Double value : values) {
            array.put(value == null ? JSONObject.NULL : value);
        }
        return array;
    }

    private JSONArray toJsonArray(int[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (int value : values) {
            array.put(value == 0 ? JSONObject.NULL : value);
        }
        return array;
    }

    private JSONArray toJsonArray(String[] values) throws JSONException {
        JSONArray array = new JSONArray();
        for (String value : values) {
            array.put(value == null || value.length() == 0 ? JSONObject.NULL : value);
        }
        return array;
    }

    private String joinLabels(String[] labels) {
        if (labels == null) {
            return "--";
        }

        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < labels.length; i += 1) {
            if (i > 0) {
                builder.append(",");
            }
            String label = labels[i];
            builder.append(label == null || label.length() == 0 ? "--" : label);
        }
        return builder.toString();
    }

    private String safeAddress(BluetoothDevice device) {
        try {
            return device == null ? "unknown" : device.getAddress();
        } catch (SecurityException e) {
            return "permission-denied";
        }
    }

    private String safeName(BluetoothDevice device) {
        try {
            String name = device == null ? "" : device.getName();
            return name == null ? "" : name;
        } catch (SecurityException e) {
            return "";
        }
    }

    private String toHex(byte[] data) {
        StringBuilder builder = new StringBuilder(data.length * 2);
        for (byte b : data) {
            builder.append(String.format(Locale.US, "%02x", b & 0xFF));
        }
        return builder.toString();
    }

    private String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
        format.setTimeZone(TimeZone.getDefault());
        return format.format(new Date());
    }

    private static class EstimoteFrame {
        int payloadVersion;
        int advSeq;
        int flags;
        boolean paused;
        int[] anchorCodes;
        String[] anchorLabels;
        Double[] distancesM;
        Double[] lqi;
        int battery;
        int validCount;
        Integer syncSeq;
        Double[] agesS;
        Double syncSpanS;
    }
}
