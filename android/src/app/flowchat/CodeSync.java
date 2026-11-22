package app.flowchat;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Two-way sync of QR codes between this phone and the server, with no Android classes so it
 * can be tested on a desktop JVM. Changes made here are queued ({@code dirty} / {@code deleted})
 * and sent on the next sync; the server's list then replaces everything not waiting to be sent.
 * Not thread-safe: {@link CodeStore} calls it under its own lock.
 */
final class CodeSync {
    /** One code as stored here. {@code sid} is the server's id once the server has it. */
    static final class Code {
        String id;
        String sid;
        String title;
        String kind; // "text" or "image"
        String content;
        String image; // data: URL
        long updated;
        String by;
        boolean dirty; // changed here, not yet on the server
        boolean deleted; // removed here, server not yet told
        int rev; // counts local changes, to tell whether a code changed during a sync (not stored)

        Code copy() {
            Code c = new Code();
            c.id = id; c.sid = sid; c.title = title; c.kind = kind; c.content = content; c.image = image;
            c.updated = updated; c.by = by; c.dirty = dirty; c.deleted = deleted; c.rev = rev;
            return c;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("id", id).put("sid", sid == null ? JSONObject.NULL : sid).put("title", title)
                    .put("kind", kind).put("content", content == null ? JSONObject.NULL : content)
                    .put("image", image == null ? JSONObject.NULL : image).put("updated", updated)
                    .put("by", by == null ? "" : by).put("dirty", dirty).put("deleted", deleted);
        }

        static Code fromJson(JSONObject o) {
            Code c = new Code();
            c.id = o.optString("id");
            c.sid = o.isNull("sid") ? null : o.optString("sid", null);
            c.title = o.optString("title");
            c.kind = o.optString("kind", "text");
            c.content = o.isNull("content") ? null : o.optString("content", null);
            c.image = o.isNull("image") ? null : o.optString("image", null);
            c.updated = o.optLong("updated");
            c.by = o.optString("by", "");
            c.dirty = o.optBoolean("dirty");
            c.deleted = o.optBoolean("deleted");
            return c;
        }

        static Code fromServer(JSONObject o, String localId) {
            Code c = new Code();
            c.id = localId != null ? localId : o.optString("id");
            c.sid = o.optString("id");
            c.title = o.optString("title");
            c.kind = o.optString("kind", "text");
            c.content = o.isNull("content") ? null : o.optString("content", null);
            c.image = o.isNull("image") ? null : o.optString("image", null);
            c.updated = o.optLong("updated");
            c.by = o.optString("by", "");
            return c;
        }
    }

    /** Result of one sync. */
    enum Outcome { SYNCED, OFFLINE, SIGNED_OUT, SERVER_TOO_OLD, ERROR }

    static final int MAX_QR_BYTES = 2331;

    final List<Code> codes = new ArrayList<>();
    /** Set when the server refused a code, or another error: shown to the person. */
    String problem = "";

    // ---------- reading ----------

    List<Code> visible() {
        List<Code> out = new ArrayList<>();
        for (Code c : codes) if (!c.deleted) out.add(c);
        Collections.sort(out, new Comparator<Code>() {
            @Override
            public int compare(Code a, Code b) {
                return a.title.compareToIgnoreCase(b.title);
            }
        });
        return out;
    }

    Code find(String id) {
        for (Code c : codes) if (c.id.equals(id) && !c.deleted) return c;
        return null;
    }

    int pending() {
        int n = 0;
        for (Code c : codes) if (c.dirty || c.deleted) n++;
        return n;
    }

    // ---------- changing ----------

    Code add(String title, String kind, String content, String image) {
        Code c = new Code();
        c.id = "local-" + UUID.randomUUID();
        c.title = title;
        c.kind = kind;
        c.content = content;
        c.image = image;
        c.updated = System.currentTimeMillis();
        c.by = "This phone";
        c.dirty = true;
        c.rev = 1;
        codes.add(c);
        return c;
    }

    boolean edit(String id, String title, String content) {
        Code c = find(id);
        if (c == null) return false;
        c.title = title;
        if ("text".equals(c.kind) && content != null) c.content = content;
        c.updated = System.currentTimeMillis();
        c.dirty = true;
        c.rev++;
        return true;
    }

    boolean remove(String id) {
        Code c = find(id);
        if (c == null) return false;
        if (c.sid == null) codes.remove(c);
        else c.deleted = true;
        c.rev++;
        return true;
    }

    /** A deep copy, to sync without holding up the screens. */
    CodeSync copy() {
        CodeSync s = new CodeSync();
        for (Code c : codes) s.codes.add(c.copy());
        return s;
    }

    /** Each code's change count, taken when a sync starts. */
    Map<String, Integer> revisions() {
        Map<String, Integer> m = new HashMap<>();
        for (Code c : codes) m.put(c.id, c.rev);
        return m;
    }

    /**
     * Takes the result of a sync that ran on a copy made when {@code before} was taken. Codes not
     * changed here meanwhile take the synced state; codes added or changed meanwhile keep their
     * change (and learn their server id); codes new from the server are added.
     */
    void adopt(CodeSync synced, Map<String, Integer> before) {
        Map<String, Code> after = new HashMap<>();
        for (Code c : synced.codes) after.put(c.id, c);
        List<Code> next = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (Code c : codes) {
            seen.add(c.id);
            Integer was = before.get(c.id);
            Code s = after.get(c.id);
            if (was != null && was == c.rev) {
                if (s != null) next.add(s); // otherwise removed by the sync
            } else {
                if (s != null && s.sid != null) c.sid = s.sid;
                next.add(c);
            }
        }
        for (Code s : synced.codes) if (!seen.contains(s.id) && !before.containsKey(s.id)) next.add(s);
        codes.clear();
        codes.addAll(next);
        problem = synced.problem;
    }

    // ---------- sync ----------

    /** Sends queued changes, then takes the server's list. {@code persist} runs after each step. */
    Outcome sync(Api api, Runnable persist) {
        problem = "";
        try {
            push(api, persist);
            merge(api.listCodes());
            persist.run();
            return problem.isEmpty() ? Outcome.SYNCED : Outcome.ERROR;
        } catch (Api.HttpError e) {
            if (e.status == 401) return Outcome.SIGNED_OUT;
            if (e.status == 404) return Outcome.SERVER_TOO_OLD;
            problem = e.getMessage();
            return Outcome.ERROR;
        } catch (IOException e) {
            return Outcome.OFFLINE;
        } catch (JSONException | RuntimeException e) {
            problem = String.valueOf(e.getMessage());
            return Outcome.ERROR;
        }
    }

    private void push(Api api, Runnable persist) throws IOException, JSONException {
        for (Code c : new ArrayList<>(codes)) {
            if (!c.dirty && !c.deleted) continue;
            try {
                if (c.deleted) {
                    api.deleteCode(c.sid);
                    codes.remove(c);
                    persist.run();
                    continue;
                }
                JSONObject body = new JSONObject().put("title", c.title);
                JSONObject result;
                if (c.sid == null) {
                    result = api.createCode(withData(body, c));
                } else {
                    if ("text".equals(c.kind)) body.put("content", c.content);
                    try {
                        result = api.updateCode(c.sid, body);
                    } catch (Api.HttpError gone) {
                        if (gone.status != 404 || gone.getMessage().equals("Not found")) throw gone;
                        // Removed on another device while edited here: keep this edit as a new code.
                        result = api.createCode(withData(new JSONObject().put("title", c.title), c));
                    }
                }
                c.sid = result.optString("id");
                c.updated = result.optLong("updated", c.updated);
                c.by = result.optString("by", c.by);
                c.dirty = false;
                persist.run();
            } catch (Api.HttpError e) {
                // Refused (too long, storage full): stays on this phone, the rest still syncs.
                if (e.status == 400 || e.status == 413) {
                    problem = "\"" + c.title + "\" stays on this phone only: " + e.getMessage();
                    continue;
                }
                throw e;
            }
        }
    }

    private static JSONObject withData(JSONObject body, Code c) throws JSONException {
        body.put("kind", c.kind);
        if ("image".equals(c.kind)) body.put("image", c.image);
        else body.put("content", c.content);
        return body;
    }

    /** Takes the server's list, keeping changes here that are still waiting to be sent. */
    void merge(JSONArray remote) {
        Map<String, Code> bySid = new HashMap<>();
        for (Code c : codes) if (c.sid != null) bySid.put(c.sid, c);
        List<Code> next = new ArrayList<>();
        for (int i = 0; i < remote.length(); i++) {
            JSONObject o = remote.optJSONObject(i);
            if (o == null) continue;
            Code local = bySid.remove(o.optString("id"));
            if (local != null && (local.dirty || local.deleted)) next.add(local);
            else next.add(Code.fromServer(o, local == null ? null : local.id));
        }
        for (Code c : codes) {
            if (c.sid == null) next.add(c); // not yet accepted by the server
            else if (bySid.containsKey(c.sid) && c.dirty) next.add(c); // edited here, removed there: kept
        }
        codes.clear();
        codes.addAll(next);
    }
}
