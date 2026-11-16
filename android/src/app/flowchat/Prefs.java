package app.flowchat;

import android.content.Context;
import android.content.SharedPreferences;

/** Settings kept in the app's private storage (excluded from backups). */
final class Prefs {
    /** Notify for webhook messages only. */
    static final String ALERTS_HOOKS = "hooks";
    /** Notify for webhook messages and messages from other devices. */
    static final String ALERTS_ALL = "all";
    static final String ALERTS_OFF = "off";

    private Prefs() {
    }

    private static SharedPreferences p(Context c) {
        return c.getSharedPreferences("flowchat", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        return p(c).getString("server", "");
    }

    static void setServer(Context c, String value) {
        p(c).edit().putString("server", value).apply();
    }

    /** The session cookie, copied from the WebView so the background service can use it. */
    static String cookie(Context c) {
        return p(c).getString("cookie", "");
    }

    static void setCookie(Context c, String value) {
        p(c).edit().putString("cookie", value).apply();
    }

    static String alerts(Context c) {
        return p(c).getString("alerts", ALERTS_HOOKS);
    }

    static void setAlerts(Context c, String value) {
        p(c).edit().putString("alerts", value).apply();
    }

    /** Time of the newest message already seen, so nothing is announced twice. 0 = never connected. */
    static long lastTs(Context c) {
        return p(c).getLong("lastTs", 0);
    }

    static void setLastTs(Context c, long value) {
        p(c).edit().putLong("lastTs", value).apply();
    }
}
