package app.flowchat;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Talks to the Flowchat server. Uses no Android classes (org.json aside), so it can be
 * tested on a desktop JVM against a real server.
 */
public final class Api {

    /** The server answered with an error status. */
    public static final class HttpError extends IOException {
        public final int status;

        HttpError(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    public interface Events {
        void onOpen();

        void onMessage(JSONObject message);

        void onDelete(String id);

        /** A QR code was added, changed or removed on another device. */
        void onCodesChanged();
    }

    public interface Progress {
        void onProgress(long done, long total);
    }

    static final String USER_AGENT = "FlowchatAndroid/1.0";

    private final String base;
    private final String cookie;
    private volatile HttpURLConnection stream;
    private volatile boolean closed;
    /** After {@link #listCodes}: the server's PIN lock as "salt:hash", "" for none, null if not sent. */
    public volatile String codesLock;

    /** @param base a normalized server address such as https://flow.example.com */
    public Api(String base, String cookie) {
        this.base = base;
        this.cookie = cookie;
    }

    // ---------- addresses ----------

    /**
     * Turns what a person typed into scheme://host[:port]. Without a scheme, local
     * addresses get http and everything else https.
     */
    public static String normalize(String input) {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) throw new IllegalArgumentException("Enter the server address.");
        try {
            if (!s.contains("://")) {
                String host = new URI("http://" + s).getHost();
                s = (host != null && isLocal(host) ? "http://" : "https://") + s;
            }
            URI u = new URI(s);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                throw new IllegalArgumentException("The address must start with http:// or https://.");
            }
            String host = u.getHost();
            if (host == null || host.isEmpty()) throw new IllegalArgumentException("The address has no server name.");
            host = host.toLowerCase(Locale.ROOT);
            int port = u.getPort();
            boolean defaultPort = port == -1 || (scheme.equals("http") && port == 80) || (scheme.equals("https") && port == 443);
            return scheme + "://" + host + (defaultPort ? "" : ":" + port);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("That is not a valid address.");
        }
    }

    /** Addresses that are only reachable on a home network or a VPN such as Tailscale. */
    public static boolean isLocal(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")
                || h.endsWith(".internal") || h.endsWith(".ts.net")) {
            return true;
        }
        if (h.contains(":")) { // IPv6
            return h.equals("::1") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
        }
        String[] p = h.split("\\.");
        if (p.length != 4) return false;
        int[] n = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                n[i] = Integer.parseInt(p[i]);
            } catch (NumberFormatException e) {
                return false;
            }
            if (n[i] < 0 || n[i] > 255) return false;
        }
        return n[0] == 10 || n[0] == 127 || (n[0] == 192 && n[1] == 168) || (n[0] == 172 && n[1] >= 16 && n[1] <= 31)
                || (n[0] == 169 && n[1] == 254) || (n[0] == 100 && n[1] >= 64 && n[1] <= 127);
    }

    // ---------- requests ----------

    private HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setRequestProperty("User-Agent", USER_AGENT);
        if (cookie != null && !cookie.isEmpty()) c.setRequestProperty("Cookie", cookie);
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            in.close();
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static JSONObject finish(HttpURLConnection c) throws IOException {
        try {
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = in == null ? "" : readAll(in);
            if (code >= 300 && code < 400) {
                throw new HttpError(code, "The server sent this app to another address ("
                        + c.getHeaderField("Location") + "). Use that address in the app settings.");
            }
            if (code >= 400) {
                String message = "The server answered " + code + ".";
                try {
                    message = new JSONObject(body).optString("error", message);
                } catch (JSONException ignored) {
                    // not JSON: keep the generic message
                }
                throw new HttpError(code, message);
            }
            try {
                return new JSONObject(body.isEmpty() ? "{}" : body);
            } catch (JSONException e) {
                throw new IOException("This address does not look like a Flowchat server.");
            }
        } finally {
            c.disconnect();
        }
    }

    private static void writeJson(HttpURLConnection c, JSONObject body) throws IOException {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setFixedLengthStreamingMode(bytes.length);
        OutputStream out = c.getOutputStream();
        try {
            out.write(bytes);
        } finally {
            out.close();
        }
    }

    /** True when the address answers like a Flowchat server. */
    public boolean healthy() throws IOException {
        HttpURLConnection c = open("/healthz", "GET");
        try {
            int code = c.getResponseCode();
            if (code != 200) return false;
            return readAll(c.getInputStream()).trim().equals("ok");
        } finally {
            c.disconnect();
        }
    }

    /** This device's session: {device, sid, maxUploadMb}. Throws HttpError 401 when signed out. */
    public JSONObject me() throws IOException {
        return finish(open("/api/me", "GET"));
    }

    /** The newest messages, oldest first. */
    public JSONArray recent(int limit) throws IOException {
        JSONArray list = finish(open("/api/messages?limit=" + limit, "GET")).optJSONArray("messages");
        return list == null ? new JSONArray() : list;
    }

    // ---------- QR codes ----------

    /** All QR codes on the server. Throws HttpError 404 when the server is too old to have them. */
    public JSONArray listCodes() throws IOException {
        JSONObject o = finish(open("/api/codes", "GET"));
        if (o.has("lock")) {
            JSONObject lock = o.optJSONObject("lock");
            codesLock = lock == null ? "" : lock.optString("salt") + ":" + lock.optString("hash");
        } else {
            codesLock = ""; // a server older than 1.12 has no PIN
        }
        JSONArray list = o.optJSONArray("codes");
        return list == null ? new JSONArray() : list;
    }

    public JSONObject createCode(JSONObject body) throws IOException {
        HttpURLConnection c = open("/api/codes", "POST");
        c.setReadTimeout(60000);
        writeJson(c, body);
        return finish(c);
    }

    public JSONObject updateCode(String id, JSONObject body) throws IOException {
        HttpURLConnection c = open("/api/codes/" + id, "PUT");
        writeJson(c, body);
        return finish(c);
    }

    public void deleteCode(String id) throws IOException {
        finish(open("/api/codes/" + id, "DELETE"));
    }

    public JSONObject sendText(String text) throws IOException {
        HttpURLConnection c = open("/api/messages", "POST");
        try {
            writeJson(c, new JSONObject().put("text", text));
        } catch (JSONException e) {
            throw new IOException(e.getMessage());
        }
        return finish(c);
    }

    /** Streams a file to the server. Pass size -1 when the length is unknown. */
    public JSONObject upload(String name, String type, InputStream data, long size, Progress progress) throws IOException {
        String q = URLEncoder.encode(name, "UTF-8").replace("+", "%20");
        HttpURLConnection c = open("/api/upload?name=" + q, "POST");
        c.setDoOutput(true);
        c.setReadTimeout(120000);
        c.setRequestProperty("Content-Type", type == null || type.isEmpty() ? "application/octet-stream" : type);
        if (size >= 0) c.setFixedLengthStreamingMode(size);
        else c.setChunkedStreamingMode(64 * 1024);
        OutputStream out = c.getOutputStream();
        byte[] buf = new byte[64 * 1024];
        long done = 0;
        int n;
        try {
            while ((n = data.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (progress != null) progress.onProgress(done, size);
            }
        } catch (IOException e) {
            // The server may have refused the upload part-way (for example: too large). Prefer its message.
            try {
                finish(c);
            } catch (HttpError refused) {
                throw refused;
            } catch (IOException ignored) {
                // no usable answer
            }
            throw new IOException("The upload was cut off. The file may be over the server's upload limit, "
                    + "or the connection dropped.");
        } finally {
            try {
                out.close();
            } catch (IOException ignored) {
                // reported by finish() below
            }
        }
        return finish(c);
    }

    /**
     * Listens to the server's live event stream until it ends or fails. Always ends with an
     * exception; call {@link #close()} from another thread to stop it.
     */
    public void listen(Events events) throws IOException {
        HttpURLConnection c = open("/api/events", "GET");
        c.setRequestProperty("Accept", "text/event-stream");
        c.setReadTimeout(70000); // the server sends a keep-alive every 25 seconds
        stream = c;
        if (closed) c.disconnect();
        try {
            int code = c.getResponseCode();
            if (code != 200) {
                finish(c);
                throw new HttpError(code, "The server answered " + code + ".");
            }
            events.onOpen();
            BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            String event = "message";
            StringBuilder data = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) dispatch(events, event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith(":")) {
                    // keep-alive comment
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    String value = line.substring(5);
                    if (value.startsWith(" ")) value = value.substring(1);
                    if (data.length() > 0) data.append('\n');
                    data.append(value);
                }
            }
            throw new IOException("The connection was closed.");
        } finally {
            stream = null;
            c.disconnect();
        }
    }

    private static void dispatch(Events events, String event, String data) {
        try {
            if (event.equals("message")) events.onMessage(new JSONObject(data));
            else if (event.equals("delete")) events.onDelete(new JSONObject(data).optString("id"));
            else if (event.equals("code") || event.equals("codeDelete")) events.onCodesChanged();
        } catch (JSONException ignored) {
            // skip events this version does not understand
        }
    }

    /** Stops a running {@link #listen}. Safe to call from any thread. */
    public void close() {
        closed = true;
        HttpURLConnection c = stream;
        if (c != null) c.disconnect();
    }
}
