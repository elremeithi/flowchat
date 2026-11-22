package app.flowchat;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;

/** "Send to Flowchat" in Android's share menu. Asks before sending anything. */
public final class ShareActivity extends Activity {
    private static final class Item {
        Uri uri;
        String name;
        String type;
        long size = -1;
    }

    private final ArrayList<Item> files = new ArrayList<>();
    private String text = "";
    private TextView status;
    private ProgressBar bar;
    private Button send;
    private volatile boolean cancelled;
    private volatile InputStream current;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Secure.apply(this);
        setTitle("Send to Flowchat");
        if (Prefs.server(this).isEmpty() || Prefs.cookie(this).isEmpty()) {
            Toast.makeText(this, "Open Flowchat and sign in first.", Toast.LENGTH_LONG).show();
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
            return;
        }
        readIntent(getIntent());
        if (files.isEmpty() && text.isEmpty()) {
            Toast.makeText(this, "Nothing to send.", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        int pad = dp(22);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad, pad, pad);

        TextView summary = new TextView(this);
        summary.setTextSize(16);
        summary.setText(describe());
        col.addView(summary);

        status = new TextView(this);
        status.setPadding(0, dp(14), 0, dp(6));
        status.setVisibility(View.GONE);
        col.addView(status);

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        bar.setVisibility(View.GONE);
        col.addView(bar);

        LinearLayout row = new LinearLayout(this);
        row.setPadding(0, dp(16), 0, 0);
        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                cancelled = true;
                InputStream in = current;
                if (in != null) {
                    try {
                        in.close();
                    } catch (IOException ignored) {
                        // closing only to stop the upload
                    }
                }
                finish();
            }
        });
        send = new Button(this);
        send.setText("Send");
        send.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                start();
            }
        });
        row.addView(cancel);
        row.addView(send);
        col.addView(row);
        setContentView(col);
    }

    private void readIntent(Intent in) {
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(in.getAction())) {
            Uri u = in.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(in.getAction())) {
            ArrayList<Uri> list = in.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        for (Uri u : uris) {
            // Only files another app deliberately shares (content://), never paths into this app's storage.
            if (u == null || !"content".equals(u.getScheme())) continue;
            Item item = new Item();
            item.uri = u;
            item.type = getContentResolver().getType(u);
            item.name = u.getLastPathSegment() == null ? "file" : u.getLastPathSegment();
            try (Cursor c = getContentResolver().query(u, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
                    null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    if (!c.isNull(0)) item.name = c.getString(0);
                    if (!c.isNull(1)) item.size = c.getLong(1);
                }
            } catch (RuntimeException ignored) {
                // keep the fallback name; size stays unknown
            }
            files.add(item);
        }
        CharSequence body = in.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = in.getStringExtra(Intent.EXTRA_SUBJECT);
        String b = body == null ? "" : body.toString().trim();
        String s = subject == null ? "" : subject.trim();
        text = !s.isEmpty() && !b.contains(s) ? (s + "\n" + b).trim() : b;
    }

    private String describe() {
        StringBuilder sb = new StringBuilder();
        if (!files.isEmpty()) {
            sb.append(files.size() == 1 ? "1 file:" : files.size() + " files:");
            for (int i = 0; i < files.size() && i < 6; i++) sb.append("\n• ").append(files.get(i).name);
            if (files.size() > 6) sb.append("\n• and ").append(files.size() - 6).append(" more");
        }
        if (!text.isEmpty()) {
            if (sb.length() > 0) sb.append("\n\n");
            sb.append(text.length() > 300 ? text.substring(0, 300) + "…" : text);
        }
        return sb.toString();
    }

    private void start() {
        send.setEnabled(false);
        status.setVisibility(View.VISIBLE);
        status.setText("Sending…");
        final Api api = new Api(Prefs.server(this), Prefs.cookie(this));
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    // Check the server's size limit first: an oversized upload is cut off without an answer.
                    long limit = api.me().optLong("maxUploadMb", 0) * 1024 * 1024;
                    for (Item f : files) {
                        if (limit > 0 && f.size > limit) {
                            fail(f.name + " is larger than the server's " + (limit / 1024 / 1024) + " MB upload limit.");
                            return;
                        }
                    }
                    for (int i = 0; i < files.size(); i++) {
                        if (cancelled) return;
                        final Item f = files.get(i);
                        final String label = (files.size() > 1 ? "File " + (i + 1) + " of " + files.size() + ": " : "") + f.name;
                        ui(label, 0);
                        InputStream in = getContentResolver().openInputStream(f.uri);
                        if (in == null) throw new IOException("Could not open " + f.name);
                        current = in;
                        try {
                            api.upload(f.name, f.type, in, f.size, new Api.Progress() {
                                long shown;

                                @Override
                                public void onProgress(long done, long total) {
                                    long now = System.currentTimeMillis();
                                    if (total > 0 && now - shown > 150) {
                                        shown = now;
                                        ui(label, (int) (done * 1000 / total));
                                    }
                                }
                            });
                        } finally {
                            current = null;
                            in.close();
                        }
                    }
                    if (!text.isEmpty() && !cancelled) api.sendText(text);
                    if (cancelled) return;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(ShareActivity.this, "Sent to Flowchat", Toast.LENGTH_SHORT).show();
                            finish();
                        }
                    });
                } catch (Api.HttpError e) {
                    fail(e.status == 401
                            ? "This phone is signed out of Flowchat. Open the app, sign in, then share again."
                            : e.getMessage());
                } catch (IOException | RuntimeException e) {
                    if (!cancelled) fail("Could not send: " + e.getMessage());
                }
            }
        }).start();
    }

    private void ui(final String label, final int permille) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                status.setText("Sending " + label);
                bar.setVisibility(View.VISIBLE);
                bar.setProgress(permille);
            }
        });
    }

    private void fail(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                status.setText(message);
                bar.setVisibility(View.GONE);
                send.setEnabled(true);
                send.setText("Try again");
            }
        });
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Secure.apply(this);
    }
}
