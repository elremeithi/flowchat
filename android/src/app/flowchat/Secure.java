package app.flowchat;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;

/**
 * Marks a screen as secure: Android then blocks screenshots and screen recordings of it,
 * shows it as black when the screen is shared or cast, and hides its preview in the
 * recent-apps list.
 */
final class Secure {
    private Secure() {
    }

    static void apply(Activity activity) {
        activity.getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) activity.setRecentsScreenshotEnabled(false);
    }
}
