package app.flowchat;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

/** Adds a code (typed, or read from a picture) or edits one. Saved on the phone at once, then synced. */
public final class CodeEditActivity extends Activity {
    private static final int REQ_PICTURE = 1;
    private static final int ID_TEXT = 201;
    private static final int ID_IMAGE = 202;

    private CodeStore store;
    private CodeSync.Code editing;
    private EditText title;
    private EditText content;
    private RadioGroup kind;
    private LinearLayout textPane;
    private LinearLayout imagePane;
    private TextView bytes;
    private TextView note;
    private TextView error;
    private ImageView preview;
    private String pendingImage;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Secure.apply(this);
        store = CodeStore.get(this);
        String id = getIntent().getStringExtra("id");
        editing = id == null ? null : store.find(id);
        if (id != null && editing == null) {
            finish();
            return;
        }
        setTitle(editing == null ? "Add a QR code" : "Edit code");
        if (saved != null) pendingImage = saved.getString("image");

        int pad = dp(20);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, dp(12), pad, pad);

        col.addView(label("Title"));
        title = new EditText(this);
        title.setId(101);
        title.setSingleLine(true);
        title.setHint("e.g. Gym membership");
        title.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        col.addView(title);

        kind = new RadioGroup(this);
        kind.setId(102);
        kind.setOrientation(RadioGroup.HORIZONTAL);
        kind.addView(radio(ID_TEXT, "Text or link"));
        kind.addView(radio(ID_IMAGE, "From a picture"));
        kind.setPadding(0, dp(10), 0, dp(4));
        col.addView(kind);

        textPane = new LinearLayout(this);
        textPane.setOrientation(LinearLayout.VERTICAL);
        textPane.addView(label("Text or link"));
        content = new EditText(this);
        content.setId(103);
        content.setMinLines(2);
        content.setGravity(Gravity.TOP);
        content.setHint("https://… or any text");
        content.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        textPane.addView(content);
        bytes = small("");
        textPane.addView(bytes);
        col.addView(textPane);

        imagePane = new LinearLayout(this);
        imagePane.setOrientation(LinearLayout.VERTICAL);
        imagePane.addView(small("Pick a photo or screenshot of the code. QR codes are read and redrawn sharply; "
                + "other codes (barcodes, boarding passes) are kept as the picture."));
        Button pick = new Button(this);
        pick.setText("Choose picture");
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose picture"), REQ_PICTURE);
                } catch (ActivityNotFoundException e) {
                    showError("No app on this phone can pick pictures.");
                }
            }
        });
        imagePane.addView(pick);
        col.addView(imagePane);

        note = small("");
        note.setVisibility(View.GONE);
        col.addView(note);

        preview = new ImageView(this);
        preview.setBackgroundColor(Color.WHITE);
        preview.setAdjustViewBounds(true);
        preview.setPadding(dp(6), dp(6), dp(6), dp(6));
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(dp(200), -2);
        pp.gravity = Gravity.CENTER_HORIZONTAL;
        pp.topMargin = dp(12);
        col.addView(preview, pp);

        error = small("");
        error.setTextColor(0xFFD93A32);
        error.setAlpha(1f);
        error.setVisibility(View.GONE);
        col.addView(error);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(16), 0, 0);
        if (editing != null) {
            Button del = new Button(this, null, android.R.attr.borderlessButtonStyle);
            del.setText("Remove");
            del.setTextColor(0xFFD93A32);
            del.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    confirmRemove();
                }
            });
            row.addView(del);
        }
        row.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        Button cancel = new Button(this, null, android.R.attr.borderlessButtonStyle);
        cancel.setText("Cancel");
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        Button save = new Button(this);
        save.setText("Save");
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save();
            }
        });
        row.addView(cancel);
        row.addView(save);
        col.addView(row);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col);
        setContentView(scroll);

        if (editing != null) {
            title.setText(editing.title);
            if ("text".equals(editing.kind)) content.setText(editing.content);
            kind.setVisibility(View.GONE);
            kind.check("image".equals(editing.kind) ? ID_IMAGE : ID_TEXT);
        } else {
            kind.check(pendingImage != null ? ID_IMAGE : ID_TEXT);
        }
        kind.setOnCheckedChangeListener(new RadioGroup.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(RadioGroup g, int checked) {
                note.setVisibility(View.GONE);
                update();
            }
        });
        content.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable e) {
                update();
            }
        });
        update();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (pendingImage != null && pendingImage.length() < 400000) out.putString("image", pendingImage);
    }

    private boolean isImage() {
        return kind.getCheckedRadioButtonId() == ID_IMAGE;
    }

    private void update() {
        boolean image = isImage();
        textPane.setVisibility(image ? View.GONE : View.VISIBLE);
        imagePane.setVisibility(image && editing == null ? View.VISIBLE : View.GONE);
        String text = content.getText().toString();
        int n = Codes.utf8Length(text);
        bytes.setText(n > 0 ? n + " of " + CodeStore.MAX_QR_BYTES + " bytes" : "");
        bytes.setTextColor(n > CodeStore.MAX_QR_BYTES ? 0xFFD93A32 : bytes.getCurrentTextColor());
        Bitmap b = null;
        if (!image && !text.trim().isEmpty() && n <= CodeStore.MAX_QR_BYTES) b = Codes.qr(text, dp(200));
        else if (image) b = Codes.picture(pendingImage != null ? pendingImage : editing != null ? editing.image : null, 800);
        preview.setImageBitmap(b);
        preview.setVisibility(b == null ? View.GONE : View.VISIBLE);
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQ_PICTURE || result != RESULT_OK || data == null || data.getData() == null) return;
        final Uri uri = data.getData();
        note.setVisibility(View.VISIBLE);
        note.setText("Reading the picture…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final Codes.Found f = Codes.read(getContentResolver(), uri);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (f.text != null) {
                                pendingImage = null;
                                content.setText(f.text);
                                kind.check(ID_TEXT);
                                note.setText("QR code found in the picture. It will be redrawn sharply; you can check the text above.");
                            } else {
                                pendingImage = f.image;
                                kind.check(ID_IMAGE);
                                note.setText(f.format != null
                                        ? "Found a " + f.format.replace('_', ' ').toLowerCase() + " code, so the picture itself will be shown."
                                        : "No QR code found, so the picture itself will be shown. That works for barcodes and tickets too.");
                            }
                            note.setVisibility(View.VISIBLE);
                            update();
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            note.setText(e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    private void save() {
        String t = title.getText().toString().replaceAll("[\\u0000-\\u001f]", " ").trim();
        if (t.length() > 100) t = t.substring(0, 100);
        if (t.isEmpty()) {
            showError("Give the code a title.");
            return;
        }
        if (editing != null) {
            String text = "text".equals(editing.kind) ? content.getText().toString() : null;
            if (text != null && !validText(text)) return;
            store.edit(editing.id, t, text);
            finish();
            return;
        }
        if (isImage()) {
            if (pendingImage == null) {
                showError("Choose a picture first.");
                return;
            }
            store.add(t, "image", null, pendingImage);
        } else {
            String text = content.getText().toString();
            if (!validText(text)) return;
            store.add(t, "text", text, null);
        }
        finish();
    }

    private boolean validText(String text) {
        if (text.trim().isEmpty()) {
            showError("Enter the text or link the code should hold.");
            return false;
        }
        if (Codes.utf8Length(text) > CodeStore.MAX_QR_BYTES) {
            showError("Too long for a QR code (" + CodeStore.MAX_QR_BYTES + " bytes at most).");
            return false;
        }
        return true;
    }

    private void confirmRemove() {
        new AlertDialog.Builder(this)
                .setMessage("Remove \"" + editing.title + "\" from every device?")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Remove", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        store.remove(editing.id);
                        finish();
                    }
                })
                .show();
    }

    private void showError(String text) {
        error.setText(text);
        error.setVisibility(View.VISIBLE);
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(13);
        t.setPadding(0, dp(8), 0, 0);
        return t;
    }

    private TextView small(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(13);
        t.setAlpha(0.75f);
        t.setPadding(0, dp(4), 0, dp(4));
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

    @Override
    protected void onResume() {
        super.onResume();
        Secure.apply(this);
    }
}
