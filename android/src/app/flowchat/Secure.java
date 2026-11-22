package app.flowchat;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;

/**
 * Marks a screen as secure, unless turned off in the app settings: Android then blocks
 * screenshots and screen recordings of it, shows it as black when the screen is shared or
 * cast, and hides its preview in the recent-apps list. Called when each screen is created and
 * resumed, so a change in the settings applies to every screen at once.
 */
final class Secure {
    private Secure() {
    }

    static void apply(Activity activity) {
        boolean on = Prefs.blockScreenshots(activity);
        if (on) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(!on);
    }
}
