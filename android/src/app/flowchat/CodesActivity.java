package app.flowchat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** The QR codes kept on this phone (and synced with the server): tap one to show it. */
public final class CodesActivity extends Activity implements CodeStore.Listener {
    private CodeStore store;
    private final List<CodeSync.Code> shown = new ArrayList<>();
    private BaseAdapter adapter;
    private EditText search;
    private TextView status;
    private TextView empty;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Secure.apply(this);
        setTitle("QR codes");
        if (getActionBar() != null) getActionBar().setDisplayHomeAsUpEnabled(true);
        store = CodeStore.get(this);

        int pad = dp(16);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, dp(8), pad, 0);

        LinearLayout tools = new LinearLayout(this);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        search = new EditText(this);
        search.setId(View.generateViewId());
        search.setHint("Search codes");
        search.setSingleLine(true);
        tools.addView(search, new LinearLayout.LayoutParams(0, -2, 1));
        Button add = new Button(this);
        add.setText("Add code");
        add.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(CodesActivity.this, CodeEditActivity.class));
            }
        });
        tools.addView(add);
        col.addView(tools);

        status = new TextView(this);
        status.setTextSize(13);
        status.setAlpha(0.75f);
        status.setPadding(0, dp(4), 0, dp(8));
        status.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                store.sync();
            }
        });
        col.addView(status);

        empty = new TextView(this);
        empty.setText("No QR codes yet.\n\nAdd tickets, Wi-Fi details, links or membership cards, then tap one to show it "
                + "full screen. They are kept on this phone, encrypted, and synced with your server.");
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(12), dp(48), dp(12), 0);
        empty.setVisibility(View.GONE);
        col.addView(empty);

        GridView grid = new GridView(this);
        grid.setNumColumns(GridView.AUTO_FIT);
        grid.setColumnWidth(dp(150));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setHorizontalSpacing(dp(12));
        grid.setVerticalSpacing(dp(12));
        grid.setClipToPadding(false);
        grid.setPadding(0, 0, 0, dp(24));
        adapter = new Adapter();
        grid.setAdapter(adapter);
        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                startActivity(new Intent(CodesActivity.this, ShowCodeActivity.class)
                        .putExtra("id", shown.get(position).id).putExtra("query", search.getText().toString()));
            }
        });
        col.addView(grid, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(col);

        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void onTextChanged(CharSequence s, int a, int b, int c) {
            }

            @Override
            public void afterTextChanged(Editable e) {
                refresh();
            }
        });
    }

    @Override
    public boolean onNavigateUp() {
        finish();
        return true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        Secure.apply(this);
        store.addListener(this);
        refresh();
        store.sync();
    }

    @Override
    protected void onPause() {
        store.removeListener(this);
        super.onPause();
    }

    @Override
    public void onChanged() {
        refresh();
    }

    static List<CodeSync.Code> filter(List<CodeSync.Code> all, String query) {
        String q = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) return all;
        List<CodeSync.Code> out = new ArrayList<>();
        for (CodeSync.Code c : all) {
            String hay = (c.title + " " + (c.content == null ? "" : c.content)).toLowerCase(Locale.ROOT);
            if (hay.contains(q)) out.add(c);
        }
        return out;
    }

    private void refresh() {
        List<CodeSync.Code> all = store.list();
        shown.clear();
        shown.addAll(filter(all, search.getText().toString()));
        adapter.notifyDataSetChanged();
        empty.setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);
        status.setText(statusText());
    }

    private String statusText() {
        int pending = store.pending();
        String waiting = pending > 0 ? " " + pending + " change" + (pending == 1 ? "" : "s") + " waiting to be sent." : "";
        switch (store.state()) {
            case SYNCING:
                return "Syncing with your server…";
            case SYNCED:
                return "Synced with your server." + waiting;
            case OFFLINE:
                return "Offline: showing codes saved on this phone." + waiting + " Tap to retry.";
            case NOT_SIGNED_IN:
                return "Not signed in: codes stay on this phone only. Sign in to Flowchat to sync them.";
            case SERVER_TOO_OLD:
                return "Your server has no QR codes yet, so these stay on this phone. Update the server to sync them.";
            case ERROR:
                return store.stateDetail() + " Tap to retry.";
            default:
                return "";
        }
    }

    private final class Adapter extends BaseAdapter {
        @Override
        public int getCount() {
            return shown.size();
        }

        @Override
        public Object getItem(int i) {
            return shown.get(i);
        }

        @Override
        public long getItemId(int i) {
            return shown.get(i).id.hashCode();
        }

        @Override
        public View getView(int i, View convert, ViewGroup parent) {
            Holder h;
            if (convert == null) {
                LinearLayout card = new LinearLayout(CodesActivity.this);
                card.setOrientation(LinearLayout.VERTICAL);
                card.setPadding(dp(10), dp(10), dp(10), dp(10));
                GradientDrawable bg = new GradientDrawable();
                bg.setCornerRadius(dp(14));
                bg.setColor(themeColor(android.R.attr.colorBackgroundFloating));
                bg.setStroke(dp(1), 0x33888888);
                card.setBackground(bg);
                h = new Holder();
                h.image = new SquareImage(CodesActivity.this);
                h.image.setBackgroundColor(Color.WHITE);
                h.image.setScaleType(ImageView.ScaleType.FIT_CENTER);
                h.image.setPadding(dp(4), dp(4), dp(4), dp(4));
                card.addView(h.image, new LinearLayout.LayoutParams(-1, -2));
                h.title = new TextView(CodesActivity.this);
                h.title.setTypeface(Typeface.DEFAULT_BOLD);
                h.title.setSingleLine(true);
                h.title.setEllipsize(TextUtils.TruncateAt.END);
                h.title.setPadding(0, dp(8), 0, 0);
                card.addView(h.title);
                h.sub = new TextView(CodesActivity.this);
                h.sub.setTextSize(12);
                h.sub.setAlpha(0.7f);
                h.sub.setSingleLine(true);
                h.sub.setEllipsize(TextUtils.TruncateAt.END);
                card.addView(h.sub);
                card.setTag(h);
                convert = card;
            }
            h = (Holder) convert.getTag();
            CodeSync.Code c = shown.get(i);
            Bitmap b = "image".equals(c.kind) ? Codes.picture(c.image, 600) : Codes.qr(c.content, dp(150));
            h.image.setImageBitmap(b);
            h.image.setContentDescription(c.title);
            h.title.setText(c.title);
            String sub = "image".equals(c.kind) ? "Picture" : c.content.replaceAll("\\s+", " ");
            if (c.dirty) sub = "Not yet synced · " + sub;
            h.sub.setText(sub);
            return convert;
        }
    }

    private static final class Holder {
        ImageView image;
        TextView title;
        TextView sub;
    }

    /** An image view as tall as it is wide. */
    static final class SquareImage extends ImageView {
        SquareImage(android.content.Context c) {
            super(c);
        }

        @Override
        protected void onMeasure(int w, int h) {
            super.onMeasure(w, w);
        }
    }

    private int themeColor(int attr) {
        TypedValue tv = new TypedValue();
        getTheme().resolveAttribute(attr, tv, true);
        return tv.resourceId != 0 ? getColor(tv.resourceId) : tv.data;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
