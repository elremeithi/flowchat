package app.flowchat;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.text.InputFilter;
import android.text.InputType;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * The PIN asked for before QR codes are shown, when the server has CODES_PIN set. The server
 * sends "salt:hash" with the codes and it is kept here, so the PIN can be checked without a
 * connection. A privacy lock for an unlocked phone, not encryption. Once entered, it holds until
 * the app's process ends, for these screens and the page in the app's main screen alike.
 */
final class CodeLock {
    private static volatile String unlockedHash = "";
    private static int fails;
    private static long waitUntil;

    private CodeLock() {
    }

    private static String hash(Context c) {
        String lock = Prefs.codesLock(c);
        int colon = lock.indexOf(':');
        return colon < 0 ? "" : lock.substring(colon + 1);
    }

    /** True when a PIN is set and has not been entered since the app was started. */
    static boolean locked(Context c) {
        String h = hash(c);
        return !h.isEmpty() && !h.equals(unlockedHash);
    }

    static boolean unlockedFor(String hash) {
        return hash != null && !hash.isEmpty() && hash.equals(unlockedHash);
    }

    /** Called by the page once the PIN was entered there. */
    static void unlock(Context c, String hash) {
        if (hash != null && hash.equals(hash(c))) unlockedHash = hash;
    }

    static boolean check(Context c, String pin) {
        String lock = Prefs.codesLock(c);
        int colon = lock.indexOf(':');
        if (colon < 0) return true;
        String salt = lock.substring(0, colon);
        String want = lock.substring(colon + 1);
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest((salt + ":" + pin).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : d) hex.append(String.format("%02x", b & 0xff));
            if (!MessageDigest.isEqual(hex.toString().getBytes(StandardCharsets.UTF_8), want.getBytes(StandardCharsets.UTF_8))) return false;
        } catch (Exception e) {
            return false;
        }
        unlockedHash = want;
        return true;
    }

    /**
     * Asks for the PIN over the given screen. {@code onUnlocked} runs once it is right; leaving
     * the question closes the screen.
     */
    static void ask(final Activity a, final Runnable onUnlocked, String problem) {
        if (a.isFinishing()) return;
        int pad = (int) (20 * a.getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);
        TextView hint = new TextView(a);
        hint.setText(problem != null ? problem
                : "Enter your PIN to see your QR codes. Forgot it? Change it in the container settings on your server (CODES_PIN).");
        box.addView(hint);
        final EditText pin = new EditText(a);
        pin.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pin.setFilters(new InputFilter[] { new InputFilter.LengthFilter(4) });
        pin.setGravity(Gravity.CENTER);
        pin.setTextSize(26);
        box.addView(pin);

        final AlertDialog dlg = new AlertDialog.Builder(a)
                .setTitle("QR codes are locked")
                .setView(box)
                .setPositiveButton("Unlock", null)
                .setNegativeButton("Cancel", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        a.finish();
                    }
                })
                .setOnCancelListener(new DialogInterface.OnCancelListener() {
                    @Override
                    public void onCancel(DialogInterface d) {
                        a.finish();
                    }
                })
                .create();
        dlg.setCanceledOnTouchOutside(false);
        final Runnable submit = new Runnable() {
            @Override
            public void run() {
                long wait = (waitUntil - System.currentTimeMillis() + 999) / 1000;
                String entered = pin.getText().toString();
                pin.setText("");
                if (wait > 0) {
                    hint.setText("Too many wrong tries. Try again in " + wait + " seconds.");
                } else if (entered.length() != 4) {
                    hint.setText("Enter the 4 digits of your PIN.");
                } else if (check(a, entered)) {
                    fails = 0;
                    dlg.dismiss();
                    onUnlocked.run();
                } else {
                    fails++;
                    if (fails >= 5) {
                        waitUntil = System.currentTimeMillis() + Math.min(30000L << Math.min(fails - 5, 5), 600000L);
                        hint.setText("Wrong PIN. Try again in " + ((waitUntil - System.currentTimeMillis() + 999) / 1000) + " seconds.");
                    } else {
                        hint.setText("Wrong PIN.");
                    }
                }
            }
        };
        pin.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int st, int c, int af) {
            }

            @Override
            public void onTextChanged(CharSequence s, int st, int b, int c) {
            }

            @Override
            public void afterTextChanged(android.text.Editable e) {
                if (e.length() == 4) pin.post(submit);
            }
        });
        dlg.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface d) {
                dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new android.view.View.OnClickListener() {
                    @Override
                    public void onClick(android.view.View v) {
                        submit.run();
                    }
                });
                pin.requestFocus();
            }
        });
        if (dlg.getWindow() != null) dlg.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        dlg.show();
    }
}
