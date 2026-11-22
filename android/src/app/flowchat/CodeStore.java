package app.flowchat;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * QR codes kept on this phone, encrypted with a key held in Android's keystore, and synced
 * both ways with the server (see {@link CodeSync}).
 */
final class CodeStore {
    /** Sync states shown to the person. */
    enum State { IDLE, SYNCING, SYNCED, OFFLINE, NOT_SIGNED_IN, SERVER_TOO_OLD, ERROR }

    interface Listener {
        void onChanged();
    }

    static final int MAX_QR_BYTES = CodeSync.MAX_QR_BYTES;
    private static final String KEY_ALIAS = "flowchat-codes";
    private static final String FILE = "codes.enc";
    private static final String KEY_FILE = "codes.key"; // the data key, wrapped by the keystore key
    private SecretKey dataKey;
    private static CodeStore instance;

    private final Context app;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private final CodeSync data = new CodeSync();
    private boolean loaded;
    private boolean needsResave;
    private volatile State state = State.IDLE;
    private volatile String stateDetail = "";
    private volatile boolean syncQueued;

    private CodeStore(Context context) {
        app = context.getApplicationContext();
    }

    static synchronized CodeStore get(Context context) {
        if (instance == null) instance = new CodeStore(context);
        return instance;
    }

    void addListener(Listener l) {
        listeners.add(l);
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    private void changed() {
        main.post(new Runnable() {
            @Override
            public void run() {
                for (Listener l : listeners) l.onChanged();
            }
        });
    }

    State state() {
        return state;
    }

    String stateDetail() {
        return stateDetail;
    }

    /** Reads and decrypts the codes in the background, so the codes screen opens at once. */
    void preload() {
        worker.execute(new Runnable() {
            @Override
            public void run() {
                synchronized (CodeStore.this) {
                    ensureLoaded();
                }
            }
        });
    }

    // ---------- reading and changing ----------

    synchronized List<CodeSync.Code> list() {
        ensureLoaded();
        return data.visible();
    }

    synchronized CodeSync.Code find(String id) {
        ensureLoaded();
        return data.find(id);
    }

    synchronized int pending() {
        ensureLoaded();
        return data.pending();
    }

    synchronized void add(String title, String kind, String content, String image) {
        ensureLoaded();
        data.add(title, kind, content, image);
        saved();
    }

    synchronized void edit(String id, String title, String content) {
        ensureLoaded();
        if (data.edit(id, title, content)) saved();
    }

    synchronized void remove(String id) {
        ensureLoaded();
        if (data.remove(id)) saved();
    }

    private void saved() {
        save();
        changed();
        sync();
    }

    /** Signed out: removes every code and the key from this phone. */
    synchronized void wipe() {
        data.codes.clear();
        loaded = true;
        new File(app.getFilesDir(), FILE).delete();
        new File(app.getFilesDir(), FILE + ".tmp").delete();
        new File(app.getFilesDir(), KEY_FILE).delete();
        dataKey = null;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // nothing stored
        }
        state = State.NOT_SIGNED_IN;
        changed();
    }

    // ---------- sync ----------

    /** Sends local changes and fetches the server's codes, in the background. */
    void sync() {
        if (syncQueued) return;
        syncQueued = true;
        worker.execute(new Runnable() {
            @Override
            public void run() {
                syncQueued = false;
                syncNow();
            }
        });
    }

    private void setState(State s, String detail) {
        state = s;
        stateDetail = detail == null ? "" : detail;
        changed();
    }

    private void syncNow() {
        final String cookie = Prefs.cookie(app);
        String server = Prefs.server(app);
        if (server.isEmpty() || cookie.isEmpty()) {
            setState(State.NOT_SIGNED_IN, null);
            return;
        }
        setState(State.SYNCING, null);
        // The sync runs on a copy, without the lock, so the screens never wait for the network.
        CodeSync work;
        java.util.Map<String, Integer> before;
        synchronized (this) {
            ensureLoaded();
            work = data.copy();
            before = data.revisions();
        }
        CodeSync.Outcome outcome = work.sync(new Api(server, cookie), new Runnable() {
            @Override
            public void run() {
                // saved once below, together with any changes made meanwhile
            }
        });
        String problem;
        synchronized (this) {
            if (outcome != CodeSync.Outcome.SIGNED_OUT) {
                data.adopt(work, before);
                save();
            }
            problem = data.problem;
        }
        changed();
        switch (outcome) {
            case SYNCED:
                setState(State.SYNCED, null);
                break;
            case OFFLINE:
                setState(State.OFFLINE, null);
                break;
            case SERVER_TOO_OLD:
                setState(State.SERVER_TOO_OLD, null);
                break;
            case SIGNED_OUT:
                if (cookie.equals(Prefs.cookie(app))) {
                    Prefs.setCookie(app, "");
                    wipe(); // signed out from another device: nothing stays on this phone
                }
                break;
            default:
                setState(State.ERROR, problem);
        }
    }

    // ---------- encrypted file ----------

    private void ensureLoaded() {
        if (loaded) return;
        loaded = true;
        File f = new File(app.getFilesDir(), FILE);
        if (!f.exists()) return;
        try {
            byte[] all = readFile(f);
            boolean legacy = !new File(app.getFilesDir(), KEY_FILE).exists(); // saved by app 1.3
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, legacy ? keystoreKey() : dataKey(), new GCMParameterSpec(128, all, 0, 12));
            byte[] plain = cipher.doFinal(all, 12, all.length - 12);
            if (legacy) needsResave = true;
            JSONArray arr = new JSONObject(new String(plain, StandardCharsets.UTF_8)).optJSONArray("codes");
            if (arr != null) for (int i = 0; i < arr.length(); i++) data.codes.add(CodeSync.Code.fromJson(arr.getJSONObject(i)));
            if (needsResave) {
                needsResave = false;
                save(); // move to the faster format
            }
        } catch (Exception e) {
            // Unreadable (for example the key was reset by a phone restore): start empty and refetch.
            data.codes.clear();
            f.delete();
        }
    }

    private void save() {
        try {
            JSONArray arr = new JSONArray();
            for (CodeSync.Code c : data.codes) arr.put(c.toJson());
            byte[] plain = new JSONObject().put("codes", arr).toString().getBytes(StandardCharsets.UTF_8);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            byte[] iv = new byte[12];
            new java.security.SecureRandom().nextBytes(iv);
            cipher.init(Cipher.ENCRYPT_MODE, dataKey(), new GCMParameterSpec(128, iv));
            byte[] ct = cipher.doFinal(plain);
            File tmp = new File(app.getFilesDir(), FILE + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(iv);
                out.write(ct);
                out.getFD().sync();
            } finally {
                out.close();
            }
            if (!tmp.renameTo(new File(app.getFilesDir(), FILE))) throw new IOException("rename failed");
        } catch (Exception e) {
            setState(State.ERROR, "Could not save on this phone: " + e.getMessage());
        }
    }

    /**
     * The key that encrypts the codes file: random, kept in codes.key encrypted by the keystore
     * key (which never leaves Android's secure hardware). Unwrapped once, so large files stay fast.
     */
    private SecretKey dataKey() throws Exception {
        if (dataKey != null) return dataKey;
        File kf = new File(app.getFilesDir(), KEY_FILE);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        if (kf.exists()) {
            byte[] all = readFile(kf);
            c.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, all, 0, 12));
            dataKey = new javax.crypto.spec.SecretKeySpec(c.doFinal(all, 12, all.length - 12), "AES");
            return dataKey;
        }
        byte[] raw = new byte[32];
        new java.security.SecureRandom().nextBytes(raw);
        c.init(Cipher.ENCRYPT_MODE, keystoreKey());
        byte[] iv = c.getIV();
        byte[] wrapped = c.doFinal(raw);
        File tmp = new File(app.getFilesDir(), KEY_FILE + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(iv);
            out.write(wrapped);
            out.getFD().sync();
        } finally {
            out.close();
        }
        if (!tmp.renameTo(kf)) throw new IOException("rename failed");
        dataKey = new javax.crypto.spec.SecretKeySpec(raw, "AES");
        return dataKey;
    }

    private static SecretKey keystoreKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(KEY_ALIAS, null);
    }

    private static byte[] readFile(File f) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }
}
