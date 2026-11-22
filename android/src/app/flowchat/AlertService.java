package app.flowchat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.IBinder;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps a live connection to the server while the app is closed and turns new messages
 * into notifications. Runs as a foreground service so Android does not stop it.
 */
public final class AlertService extends Service {
    static final String CH_SERVICE = "service";
    static final String CH_ALERTS = "alerts";
    static final String CH_MESSAGES = "messages";
    static final String TAG_MESSAGE = "msg";
    private static final int ID_STATUS = 1;
    private static final int ID_STOPPED = 2;
    private static final int ID_MISSED = 3;
    private static final int MAX_DELAY = 60000;

    private final Object wake = new Object();
    private volatile boolean running;
    private volatile Api api;
    private volatile Network lastNetwork;
    private volatile long delay = 2000;
    private Thread worker;
    private NotificationManager nm;
    private ConnectivityManager.NetworkCallback networkCallback;
    private String myDevice = "";

    static void createChannels(Context c) {
        NotificationChannel service = new NotificationChannel(CH_SERVICE, "Background connection",
                NotificationManager.IMPORTANCE_MIN);
        service.setDescription("Shown while Flowchat stays connected to receive alerts. You can hide this category.");
        service.setShowBadge(false);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, "Webhook alerts",
                NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Messages posted to your Flowchat webhooks.");
        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, "Messages from other devices",
                NotificationManager.IMPORTANCE_DEFAULT);
        messages.setDescription("Messages sent from your other signed-in devices.");
        c.getSystemService(NotificationManager.class)
                .createNotificationChannels(Arrays.asList(service, alerts, messages));
    }

    /** Starts or stops the service to match the settings and sign-in state. */
    static void sync(Context c) {
        boolean wanted = !Prefs.server(c).isEmpty() && !Prefs.cookie(c).isEmpty()
                && !Prefs.ALERTS_OFF.equals(Prefs.alerts(c));
        Intent i = new Intent(c, AlertService.class);
        if (wanted) {
            try {
                c.startForegroundService(i);
            } catch (RuntimeException e) {
                // Android refused a start from the background; the next app launch or boot retries.
            }
        } else {
            c.stopService(i);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        nm = getSystemService(NotificationManager.class);
        createChannels(this);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                Network previous = lastNetwork;
                lastNetwork = network;
                if (previous != null && !previous.equals(network)) {
                    Api a = api; // switched networks (Wi-Fi <-> mobile): the old connection is dead
                    if (a != null) a.close();
                }
                delay = 2000;
                poke();
            }
        };
        try {
            getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException e) {
            networkCallback = null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(ID_STATUS, status("Connecting…"));
        if (worker == null) {
            running = true;
            worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    loop();
                }
            }, "flowchat-alerts");
            worker.start();
        } else {
            poke();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        synchronized (this) {
            running = false;
        }
        Api a = api;
        if (a != null) a.close();
        poke();
        if (worker != null) worker.interrupt();
        if (networkCallback != null) {
            try {
                getSystemService(ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // already gone
            }
        }
        nm.cancel(ID_STATUS);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- connection loop ----------

    private void loop() {
        while (running) {
            final String server = Prefs.server(this);
            String cookie = Prefs.cookie(this);
            if (server.isEmpty() || cookie.isEmpty() || Prefs.ALERTS_OFF.equals(Prefs.alerts(this))) {
                shutdown();
                return;
            }
            Api a = new Api(server, cookie);
            api = a;
            try {
                myDevice = a.me().optString("device", "");
                catchUp(a);
                a.listen(new Api.Events() {
                    @Override
                    public void onOpen() {
                        delay = 2000;
                        setStatus("Connected to " + Uri.parse(server).getHost());
                    }

                    @Override
                    public void onMessage(JSONObject message) {
                        handle(message);
                    }

                    @Override
                    public void onDelete(String id) {
                        nm.cancel(TAG_MESSAGE, id.hashCode());
                    }

                    @Override
                    public void onCodesChanged() {
                        CodeStore.get(AlertService.this).sync();
                    }
                });
            } catch (Api.HttpError e) {
                if (e.status == 401) {
                    if (cookie.equals(Prefs.cookie(this))) {
                        signedOut();
                        return;
                    }
                    continue; // signed in again meanwhile: retry with the new session at once
                }
                setStatus("Server problem: " + e.getMessage() + " Retrying…");
            } catch (IOException e) {
                setStatus("Offline. Reconnecting…");
            } catch (RuntimeException e) {
                setStatus("Unexpected problem: " + e.getMessage() + ". Retrying…");
            } finally {
                api = null;
            }
            if (!running) return;
            pause(delay);
            delay = Math.min(delay * 2, MAX_DELAY);
        }
    }

    private void pause(long ms) {
        synchronized (wake) {
            try {
                wake.wait(ms);
            } catch (InterruptedException ignored) {
                // stopping
            }
        }
    }

    private void poke() {
        synchronized (wake) {
            wake.notifyAll();
        }
    }

    /** Announces messages that arrived while this phone was offline. */
    private void catchUp(Api a) throws IOException {
        JSONArray list = a.recent(50);
        long last = Prefs.lastTs(this);
        long newest = last;
        List<JSONObject> missed = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject m = list.optJSONObject(i);
            if (m == null) continue;
            long ts = m.optLong("ts");
            if (ts > newest) newest = ts;
            if (last > 0 && ts > last && wanted(m)) missed.add(m);
        }
        newest = Math.max(newest, 1); // first connection: start from here, announce nothing old
        if (newest > last) Prefs.setLastTs(this, newest);
        int skipped = Math.max(0, missed.size() - 5);
        for (int i = skipped; i < missed.size(); i++) notifyMessage(missed.get(i));
        if (skipped > 0) {
            nm.notify(ID_MISSED, new Notification.Builder(this, CH_ALERTS)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("Flowchat")
                    .setContentText(skipped + " more while this phone was offline")
                    .setContentIntent(openApp())
                    .setAutoCancel(true)
                    .build());
        }
    }

    private void handle(JSONObject m) {
        long ts = m.optLong("ts");
        if (ts > Prefs.lastTs(this)) Prefs.setLastTs(this, ts);
        if (wanted(m)) notifyMessage(m);
    }

    private boolean wanted(JSONObject m) {
        String mode = Prefs.alerts(this);
        if (Prefs.ALERTS_OFF.equals(mode) || MainActivity.visible) return false;
        if (m.optBoolean("hook")) return true;
        return Prefs.ALERTS_ALL.equals(mode) && !m.optString("device").equals(myDevice);
    }

    // ---------- notifications ----------

    private PendingIntent openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification status(String text) {
        return new Notification.Builder(this, CH_SERVICE)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Flowchat alerts")
                .setContentText(text)
                .setContentIntent(openApp())
                .setOngoing(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
    }

    private void setStatus(String text) {
        synchronized (this) {
            if (running) nm.notify(ID_STATUS, status(text));
        }
    }

    private void notifyMessage(JSONObject m) {
        boolean hook = m.optBoolean("hook");
        String channel = hook ? CH_ALERTS : CH_MESSAGES;
        String from = m.optString("device", "Flowchat");
        String text = m.optString("text", "");
        JSONObject file = m.optJSONObject("file");
        if (file != null) text = "File: " + file.optString("name") + (text.isEmpty() ? "" : "\n" + text);
        if (text.length() > 2000) text = text.substring(0, 2000) + "…";
        // On the lock screen only "new alert" shows; the text needs the phone unlocked.
        Notification hidden = new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(hook ? "New Flowchat alert" : "New Flowchat message")
                .build();
        Notification n = new Notification.Builder(this, channel)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(hook ? from : from + " (Flowchat)")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setWhen(m.optLong("ts", System.currentTimeMillis()))
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(openApp())
                .setCategory(hook ? Notification.CATEGORY_EVENT : Notification.CATEGORY_MESSAGE)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(hidden)
                .build();
        nm.notify(TAG_MESSAGE, m.optString("id").hashCode(), n);
    }

    private void signedOut() {
        Prefs.setCookie(this, "");
        CodeStore.get(this).wipe();
        nm.notify(ID_STOPPED, new Notification.Builder(this, CH_MESSAGES)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Flowchat alerts stopped")
                .setContentText("This phone was signed out. Open Flowchat and sign in to get alerts again.")
                .setStyle(new Notification.BigTextStyle()
                        .bigText("This phone was signed out. Open Flowchat and sign in to get alerts again."))
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .build());
        shutdown();
    }

    private void shutdown() {
        synchronized (this) {
            running = false;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}
