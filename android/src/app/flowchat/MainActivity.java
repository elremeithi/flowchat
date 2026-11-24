package app.flowchat;

import android.app.Activity;
import android.app.DownloadManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.service.notification.StatusBarNotification;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URLDecoder;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The chat itself: your Flowchat server's page in a WebView, with native files and downloads. */
public final class MainActivity extends Activity {
    /** True while the chat is on screen; alerts are not announced then. */
    static volatile boolean visible;

    private static final int REQ_FILES = 1;
    private static final int REQ_NOTIFY = 2;

    private WebView web;
    private LinearLayout errorView;
    private TextView errorText;
    private ValueCallback<Uri[]> fileCallback;
    private String server;
    /** Loading the copy of the page saved on this phone, because the server could not be reached. */
    private boolean fromCache;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Secure.apply(this);
        server = Prefs.server(this);
        if (server.isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        AlertService.createChannels(this);
        CodeStore.get(this).preload();
        CrashReport.install(this);
        CrashReport.showIfAny(this);

        FrameLayout frame = new FrameLayout(this);
        web = new WebView(this);
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        errorView = buildErrorView();
        frame.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);

        setUpWebView();
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(server + "/");
        askForNotifications();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        Secure.apply(this);
        visible = true;
        String now = Prefs.server(this);
        if (web != null && !now.isEmpty() && !now.equals(server)) {
            fromCache = false;
            web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            server = now; // changed in settings
            errorView.setVisibility(View.GONE);
            web.clearHistory();
            web.loadUrl(server + "/");
        }
        clearMessageNotifications();
    }

    @Override
    protected void onPause() {
        visible = false;
        if (!Prefs.cookie(this).isEmpty()) CodeStore.get(this).sync();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && errorView.getVisibility() != View.VISIBLE && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ---------- web view ----------

    private void setUpWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " " + Api.USER_AGENT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        // Lets the page open these app settings and name this device. Only your server's
        // page is ever loaded here: every other address opens in the browser instead.
        web.addJavascriptInterface(new Bridge(), "FlowchatAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String o = origin(u);
                if (o.equals(server)) return false;
                if (request.isRedirect() && server.startsWith("http://") && o.equals("https://" + server.substring(7))) {
                    server = o; // the server requires https: remember that
                    Prefs.setServer(MainActivity.this, o);
                    return false;
                }
                openOutside(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                syncSession();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                if (!fromCache) {
                    // Server unreachable: open the saved copy so saved QR codes can still be shown.
                    fromCache = true;
                    view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ONLY);
                    view.loadUrl(request.getUrl().toString());
                    return;
                }
                showError(String.valueOf(error.getDescription()));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*");
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(pick, "Attach files"), REQ_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    toast("No app on this phone can pick files.");
                }
                return true;
            }
        });

        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition, String mime, long length) {
                download(url, userAgent, disposition, mime);
            }
        });
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != REQ_FILES || fileCallback == null) return;
        Uri[] picked = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[] {data.getData()};
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    /** Saves a shared file to Downloads, signed in as this device. */
    private void download(String url, String userAgent, String disposition, String mime) {
        Uri u = Uri.parse(url);
        if (!origin(u).equals(server)) {
            openOutside(u);
            return;
        }
        String name = fileName(url, disposition, mime);
        int dot = name.lastIndexOf('.');
        String byExtension = dot > 0
                ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT))
                : null;
        DownloadManager.Request r = new DownloadManager.Request(u);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) r.addRequestHeader("Cookie", cookie);
        r.addRequestHeader("User-Agent", userAgent);
        r.setTitle(name);
        r.setMimeType(byExtension != null ? byExtension : mime);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        try {
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            toast("Downloading " + name);
        } catch (RuntimeException e) {
            toast("Could not start the download: " + e.getMessage());
        }
    }

    static String fileName(String url, String disposition, String mime) {
        String name = null;
        if (disposition != null) {
            Matcher m = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(disposition);
            if (m.find()) {
                try {
                    name = URLDecoder.decode(m.group(1).replace("+", "%2B"), "UTF-8");
                } catch (Exception ignored) {
                    // fall back below
                }
            }
        }
        if (name == null || name.trim().isEmpty()) name = URLUtil.guessFileName(url, disposition, mime);
        name = name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        return name.isEmpty() || name.startsWith(".") ? "download" + name : name;
    }

    /** Copies the sign-in cookie for the background service and starts or stops it. */
    private void syncSession() {
        CookieManager cm = CookieManager.getInstance();
        cm.flush();
        String session = sessionCookie(cm.getCookie(server + "/"));
        String before = Prefs.cookie(this);
        if (!session.equals(before)) {
            Prefs.setCookie(this, session);
            if (session.isEmpty()) CodeStore.get(this).wipe(); // signed out: no codes stay on this phone
        }
        // Keep the phone's encrypted copy of the QR codes current, for showing them offline.
        if (!session.isEmpty()) CodeStore.get(this).sync();
        AlertService.sync(this);
    }

    static String sessionCookie(String all) {
        if (all == null) return "";
        for (String part : all.split(";")) {
            String p = part.trim();
            if (p.startsWith("__Host-flow=") || p.startsWith("flow_session=")) return p;
        }
        return "";
    }

    static String origin(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        int port = u.getPort();
        boolean defaultPort = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
        return scheme + "://" + host + (defaultPort ? "" : ":" + port);
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            toast("No app on this phone can open that link.");
        }
    }

    /** Leaves the saved copy and loads the page from the server again. */
    private void reconnect() {
        fromCache = false;
        errorView.setVisibility(View.GONE);
        web.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
        String url = web.getUrl();
        web.loadUrl(url != null && url.startsWith(server) ? url : server + "/");
    }

    /** Full brightness and screen kept on while a QR code is shown, so scanners can read it. */
    private void setBright(boolean on) {
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.screenBrightness = on ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
                : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
        getWindow().setAttributes(lp);
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    // ---------- bridge for the page ----------

    final class Bridge {
        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startActivity(new Intent(MainActivity.this, SetupActivity.class));
                }
            });
        }

        @JavascriptInterface
        public String deviceName() {
            String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
            String model = Build.MODEL == null ? "Android phone" : Build.MODEL.trim();
            String name = maker.isEmpty() || model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT))
                    ? model
                    : maker.substring(0, 1).toUpperCase(Locale.ROOT) + maker.substring(1) + " " + model;
            return name.length() > 40 ? name.substring(0, 40) : name;
        }

        @JavascriptInterface
        public void setBright(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.setBright(on);
                }
            });
        }

        /**
         * Tells a 1.7.1-or-newer page that this app keeps an offline copy of the QR codes, which
         * the page opens only when the server can't be reached. It replaces pageHasCodes on purpose:
         * pages older than 1.7 looked for that name and then sent their QR codes tab to the app's
         * screen and switched to Chat. Without it, an older server's page shows its own codes view.
         */
        @JavascriptInterface
        public boolean hasOfflineCodes() {
            return true;
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        /** The page passes on the server's QR code PIN ("salt:hash", or "" for none). */
        @JavascriptInterface
        public void setCodesLock(String lock) {
            Prefs.setCodesLock(MainActivity.this, lock);
        }

        /** Whether the PIN was entered since the app was started, on the page or the app's own screens. */
        @JavascriptInterface
        public boolean codesUnlocked(String hash) {
            return CodeLock.unlockedFor(hash);
        }

        @JavascriptInterface
        public void unlockCodes(String hash) {
            CodeLock.unlock(MainActivity.this, hash);
        }

        @JavascriptInterface
        public void openCodes() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.openCodes();
                }
            });
        }

        @JavascriptInterface
        public void reconnect() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.reconnect();
                }
            });
        }

        @JavascriptInterface
        public void sessionChanged() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    syncSession();
                }
            });
        }
    }

    // ---------- error screen, notifications ----------

    private LinearLayout buildErrorView() {
        LinearLayout v = new LinearLayout(this);
        v.setOrientation(LinearLayout.VERTICAL);
        v.setGravity(Gravity.CENTER);
        int pad = dp(28);
        v.setPadding(pad, pad, pad, pad);
        v.setBackgroundColor(themeColor(android.R.attr.colorBackground));
        v.setVisibility(View.GONE);
        v.setClickable(true);

        TextView title = new TextView(this);
        title.setText("Can't reach your Flowchat server");
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        errorText = new TextView(this);
        errorText.setGravity(Gravity.CENTER);
        errorText.setPadding(0, dp(10), 0, dp(20));

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View b) {
                reconnect();
            }
        });
        Button settings = new Button(this);
        settings.setText("Change server address");
        settings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View b) {
                startActivity(new Intent(MainActivity.this, SetupActivity.class));
            }
        });
        Button codes = new Button(this);
        codes.setText("Show my QR codes");
        codes.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View b) {
                openCodes();
            }
        });
        v.addView(title);
        v.addView(errorText);
        v.addView(codes);
        v.addView(retry);
        v.addView(settings);
        return v;
    }

    private void openCodes() {
        try {
            startActivity(new Intent(this, CodesActivity.class));
        } catch (RuntimeException e) {
            toast("Could not open QR codes: " + e);
        }
    }


    private void showError(String why) {
        errorText.setText(server + "\n" + why + "\n\nCheck that the server is running and that this phone can reach it "
                + "(same Wi-Fi, VPN or Tailscale).");
        errorView.setVisibility(View.VISIBLE);
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !Prefs.ALERTS_OFF.equals(Prefs.alerts(this))
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
        }
    }

    private void clearMessageNotifications() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        for (StatusBarNotification n : nm.getActiveNotifications()) {
            if (AlertService.TAG_MESSAGE.equals(n.getTag())) nm.cancel(n.getTag(), n.getId());
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

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }
}
