package app.flowchat;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** One code full screen, black on white at full brightness, for another phone or a scanner. */
public final class ShowCodeActivity extends Activity implements CodeStore.Listener {
    private CodeStore store;
    private String id;
    private String query;
    private TextView title;
    private TextView count;
    private TextView text;
    private ImageView image;
    private Button prev;
    private Button next;
    private GestureDetector swipe;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Secure.apply(this);
        store = CodeStore.get(this);
        id = getIntent().getStringExtra("id");
        query = getIntent().getStringExtra("query");
        if (saved != null) id = saved.getString("id", id);

        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL;
        getWindow().setAttributes(lp);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(8), dp(4), dp(8), 0);
        Button close = flat("Close");
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        count = new TextView(this);
        count.setTextColor(0xFF666666);
        count.setGravity(Gravity.CENTER);
        Button edit = flat("Edit");
        edit.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(ShowCodeActivity.this, CodeEditActivity.class).putExtra("id", id));
            }
        });
        top.addView(close);
        top.addView(count, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(edit);
        root.addView(top);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setGravity(Gravity.CENTER);
        body.setPadding(dp(16), 0, dp(16), 0);
        title = new TextView(this);
        title.setTextColor(0xFF111111);
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        body.addView(title);
        image = new ImageView(this);
        image.setAdjustViewBounds(true);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(-1, 0, 1);
        ip.topMargin = dp(16);
        ip.bottomMargin = dp(12);
        body.addView(image, ip);
        text = new TextView(this);
        text.setTextColor(0xFF555555);
        text.setGravity(Gravity.CENTER);
        text.setMaxLines(3);
        body.addView(text);
        root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout nav = new LinearLayout(this);
        nav.setPadding(dp(8), 0, dp(8), dp(8));
        prev = flat("‹ Previous");
        next = flat("Next ›");
        prev.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                step(-1);
            }
        });
        next.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                step(1);
            }
        });
        nav.addView(prev);
        nav.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        nav.addView(next);
        root.addView(nav);
        setContentView(root);

        swipe = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onFling(MotionEvent a, MotionEvent b, float vx, float vy) {
                if (a == null || b == null) return false;
                float dx = b.getX() - a.getX();
                if (Math.abs(dx) < dp(60) || Math.abs(dx) < Math.abs(b.getY() - a.getY())) return false;
                step(dx < 0 ? 1 : -1);
                return true;
            }
        });
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        swipe.onTouchEvent(e);
        return super.dispatchTouchEvent(e);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("id", id);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Secure.apply(this);
        if (CodeLock.locked(this)) { // the list underneath asks for the PIN
            finish();
            return;
        }
        store.addListener(this);
        render();
    }

    @Override
    protected void onPause() {
        store.removeListener(this);
        super.onPause();
    }

    @Override
    public void onChanged() {
        if (CodeLock.locked(this)) {
            finish();
            return;
        }
        render();
    }

    private List<CodeSync.Code> list() {
        return CodesActivity.filter(store.list(), query);
    }

    private void step(int dir) {
        List<CodeSync.Code> all = list();
        for (int i = 0; i < all.size(); i++) {
            if (all.get(i).id.equals(id) && i + dir >= 0 && i + dir < all.size()) {
                id = all.get(i + dir).id;
                render();
                return;
            }
        }
    }

    private void render() {
        List<CodeSync.Code> all = list();
        int index = -1;
        for (int i = 0; i < all.size(); i++) if (all.get(i).id.equals(id)) index = i;
        if (index < 0) {
            finish(); // removed (here or on another device)
            return;
        }
        CodeSync.Code c = all.get(index);
        title.setText(c.title);
        int size = Math.min(getResources().getDisplayMetrics().widthPixels, getResources().getDisplayMetrics().heightPixels);
        Bitmap b = "image".equals(c.kind) ? Codes.picture(c.image, 2000) : Codes.qr(c.content, size);
        image.setImageBitmap(b);
        image.setContentDescription(c.title);
        text.setText("text".equals(c.kind) ? c.content : "");
        text.setVisibility("text".equals(c.kind) ? View.VISIBLE : View.GONE);
        count.setText(all.size() > 1 ? (index + 1) + " of " + all.size() : "");
        prev.setVisibility(index > 0 ? View.VISIBLE : View.INVISIBLE);
        next.setVisibility(index < all.size() - 1 ? View.VISIBLE : View.INVISIBLE);
    }

    private Button flat(String label) {
        Button b = new Button(this, null, android.R.attr.borderlessButtonStyle);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(0xFF1F5FD1);
        b.setTextSize(16);
        return b;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
