package app.flowchat;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.os.Build;
import android.widget.Toast;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * If the app closes unexpectedly, keeps the reason and shows it the next time the app opens,
 * so it can be copied and reported. Nothing is sent anywhere.
 */
final class CrashReport {
    private static boolean installed;

    private CrashReport() {
    }

    static synchronized void install(Context context) {
        if (installed) return;
        installed = true;
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    String text = sw.toString();
                    if (text.length() > 6000) text = text.substring(0, 6000);
                    app.getSharedPreferences("crash", Context.MODE_PRIVATE).edit()
                            .putString("report", "Flowchat " + version(app) + ", Android " + Build.VERSION.RELEASE
                                    + ", " + Build.MANUFACTURER + " " + Build.MODEL + ", thread " + t.getName() + "\n\n" + text)
                            .commit();
                } catch (Throwable ignored) {
                    // never get in the way of the crash itself
                }
                if (previous != null) previous.uncaughtException(t, e);
            }
        });
    }

    static void showIfAny(final Activity activity) {
        final android.content.SharedPreferences p = activity.getSharedPreferences("crash", Context.MODE_PRIVATE);
        final String report = p.getString("report", null);
        if (report == null) return;
        p.edit().remove("report").apply();
        new AlertDialog.Builder(activity)
                .setTitle("Flowchat closed unexpectedly")
                .setMessage("Copy this report and send it to whoever looks after your Flowchat, so the problem can be fixed.\n\n"
                        + report.substring(0, Math.min(report.length(), 1500)))
                .setNegativeButton("Close", null)
                .setPositiveButton("Copy report", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        ClipboardManager cm = activity.getSystemService(ClipboardManager.class);
                        cm.setPrimaryClip(ClipData.newPlainText("Flowchat crash report", report));
                        Toast.makeText(activity, "Report copied", Toast.LENGTH_SHORT).show();
                    }
                })
                .show();
    }

    private static String version(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }
}
