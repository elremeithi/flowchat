package app.flowchat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

/** First-run setup and app settings: server address, which alerts to show, battery. */
public final class SetupActivity extends Activity {
    private static final int ID_HOOKS = 101;
    private static final int ID_ALL = 102;
    private static final int ID_OFF = 103;

    private EditText address;
    private RadioGroup alerts;
    private TextView error;
    private TextView battery;
    private Button batteryButton;
    private Button save;
    /** Address the person already chose to keep despite a warning or failed check. */
    private String acceptedAnyway = "";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setTitle("Flowchat settings");
        int pad = dp(20);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);

        col.addView(heading("Server address"));
        address = new EditText(this);
        address.setId(1);
        address.setSingleLine(true);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://flow.example.com");
        address.setText(Prefs.server(this));
        col.addView(address);
        col.addView(note("The address you open Flowchat at in a browser, for example http://192.168.1.20:8080 "
                + "at home or your https address from outside."));

        col.addView(heading("Notifications"));
        alerts = new RadioGroup(this);
        alerts.setId(2);
        alerts.addView(radio(ID_HOOKS, "Webhook alerts only"));
        alerts.addView(radio(ID_ALL, "Webhook alerts and messages from my other devices"));
        alerts.addView(radio(ID_OFF, "None"));
        String mode = Prefs.alerts(this);
        alerts.check(Prefs.ALERTS_ALL.equals(mode) ? ID_ALL : Prefs.ALERTS_OFF.equals(mode) ? ID_OFF : ID_HOOKS);
        col.addView(alerts);
        col.addView(note("To deliver alerts while the app is closed, Flowchat keeps a connection open and shows a "
                + "small \"Flowchat alerts\" notification. You can hide it in Android's notification settings "
                + "under \"Background connection\"."));

        battery = note("");
        col.addView(battery);
        batteryButton = new Button(this);
        batteryButton.setText("Allow background use");
        batteryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                askBatteryExemption();
            }
        });
        col.addView(batteryButton);

        error = note("");
        error.setTextColor(0xFFD93A32);
        error.setVisibility(View.GONE);
        col.addView(error);

        save = new Button(this);
        save.setText("Save");
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onSave();
            }
        });
        col.addView(save);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean exempt = getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(getPackageName());
        battery.setText(exempt
                ? "Background use is allowed, so alerts arrive promptly."
                : "Battery optimisation is on for Flowchat. Alerts can be delayed while the phone is idle, and some "
                        + "phones stop the connection altogether.");
        batteryButton.setVisibility(exempt ? View.GONE : View.VISIBLE);
    }

    private void askBatteryExemption() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (RuntimeException e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void onSave() {
        final String server;
        try {
            server = Api.normalize(address.getText().toString());
        } catch (IllegalArgumentException e) {
            showError(e.getMessage());
            return;
        }
        final String host = Uri.parse(server).getHost();
        if (server.startsWith("http://") && !Api.isLocal(host) && !acceptedAnyway.equals(server)) {
            acceptedAnyway = server;
            showError("This address uses plain http over the internet, so your password and messages can be read "
                    + "on the way. Use the https address, or press Save again to continue anyway.");
            return;
        }
        save.setEnabled(false);
        save.setText("Checking…");
        error.setVisibility(View.GONE);
        new Thread(new Runnable() {
            @Override
            public void run() {
                String problem = null;
                try {
                    if (!new Api(server, "").healthy()) problem = "That address answers, but it is not a Flowchat server.";
                } catch (Exception e) {
                    problem = "Could not reach " + server + " (" + e.getMessage() + ").";
                }
                final String result = problem;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        save.setEnabled(true);
                        save.setText("Save");
                        if (result != null && !acceptedAnyway.equals(server + "#unreachable")) {
                            acceptedAnyway = server + "#unreachable";
                            showError(result + " Check the address, and that this phone is on the same network or "
                                    + "VPN. Press Save again to keep it anyway.");
                            return;
                        }
                        commit(server);
                    }
                });
            }
        }).start();
    }

    private void commit(String server) {
        if (!server.equals(Prefs.server(this))) {
            // A different server: forget the old sign-in and stored page data.
            Prefs.setCookie(this, "");
            Prefs.setLastTs(this, 0);
            CookieManager.getInstance().removeAllCookies(null);
            WebStorage.getInstance().deleteAllData();
        }
        Prefs.setServer(this, server);
        int checked = alerts.getCheckedRadioButtonId();
        Prefs.setAlerts(this, checked == ID_ALL ? Prefs.ALERTS_ALL : checked == ID_OFF ? Prefs.ALERTS_OFF : Prefs.ALERTS_HOOKS);
        AlertService.sync(this);
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }

    private void showError(String text) {
        error.setText(text);
        error.setVisibility(View.VISIBLE);
    }

    private TextView heading(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(17);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(18), 0, dp(6));
        return t;
    }

    private TextView note(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setPadding(0, dp(6), 0, dp(6));
        t.setAlpha(0.8f);
        return t;
    }

    private RadioButton radio(int id, String text) {
        RadioButton r = new RadioButton(this);
        r.setId(id);
        r.setText(text);
        return r;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
