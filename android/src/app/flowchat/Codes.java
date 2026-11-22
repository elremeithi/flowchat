package app.flowchat;

import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.net.Uri;
import android.util.Base64;
import android.util.LruCache;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;

/** Drawing QR codes and reading them from pictures (ZXing). */
final class Codes {
    private Codes() {
    }

    private static final LruCache<String, Bitmap> CACHE = new LruCache<String, Bitmap>(24 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };

    static int utf8Length(String s) {
        return s == null ? 0 : s.getBytes(StandardCharsets.UTF_8).length;
    }

    /** A QR code (error correction M, 4-module quiet zone) as a black-on-white bitmap. */
    static Bitmap qr(String text, int sizePx) {
        String key = "q" + sizePx + ":" + text;
        Bitmap hit = CACHE.get(key);
        if (hit != null) return hit;
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            hints.put(EncodeHintType.MARGIN, 4);
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints);
            int n = m.getWidth();
            int scale = Math.max(1, sizePx / n);
            int[] px = new int[n * n];
            for (int y = 0; y < n; y++) {
                for (int x = 0; x < n; x++) px[y * n + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap small = Bitmap.createBitmap(px, n, n, Bitmap.Config.ARGB_8888);
            Bitmap big = Bitmap.createScaledBitmap(small, n * scale, n * scale, false); // sharp edges
            CACHE.put(key, big);
            return big;
        } catch (Exception e) {
            return null;
        }
    }

    /** A stored picture (data: URL), scaled down to about {@code maxPx} on its longer side. */
    static Bitmap picture(String dataUrl, int maxPx) {
        if (dataUrl == null) return null;
        String key = "p" + maxPx + ":" + dataUrl.length() + ":" + dataUrl.hashCode();
        Bitmap hit = CACHE.get(key);
        if (hit != null) return hit;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
            o.inSampleSize = 1;
            while (Math.max(o.outWidth, o.outHeight) / (o.inSampleSize * 2) >= maxPx) o.inSampleSize *= 2;
            o.inJustDecodeBounds = false;
            Bitmap b = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
            if (b != null) CACHE.put(key, b);
            return b;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** What was found in a picture: QR text, or the picture itself to keep as is. */
    static final class Found {
        String text;
        String image;
        String format;
    }

    static Found read(ContentResolver resolver, Uri uri) throws IOException {
        Bitmap bmp = load(resolver, uri, 2000);
        if (bmp == null) throw new IOException("That file is not a picture this phone can open.");
        Found f = new Found();
        Result r = decode(bmp);
        if (r != null && r.getBarcodeFormat() == BarcodeFormat.QR_CODE && r.getText() != null && !r.getText().isEmpty()
                && utf8Length(r.getText()) <= CodeStore.MAX_QR_BYTES) {
            f.text = r.getText();
            return f;
        }
        if (r != null) f.format = r.getBarcodeFormat().name();
        f.image = toDataUrl(bmp);
        return f;
    }

    private static Result decode(Bitmap bmp) {
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        hints.put(DecodeHintType.POSSIBLE_FORMATS, java.util.EnumSet.allOf(BarcodeFormat.class));
        MultiFormatReader reader = new MultiFormatReader();
        reader.setHints(hints);
        for (int size : new int[] {1600, 900, 2000}) {
            Bitmap b = scale(bmp, size);
            int w = b.getWidth(), h = b.getHeight();
            int[] px = new int[w * h];
            b.getPixels(px, 0, w, 0, 0, w, h);
            BinaryBitmap bin = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, px)));
            try {
                return reader.decodeWithState(bin);
            } catch (NotFoundException e) {
                reader.reset();
            }
        }
        return null;
    }

    private static Bitmap load(ContentResolver resolver, Uri uri, int maxPx) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        InputStream in = resolver.openInputStream(uri);
        if (in == null) return null;
        try {
            BitmapFactory.decodeStream(in, null, o);
        } finally {
            in.close();
        }
        if (o.outWidth <= 0) return null;
        o.inSampleSize = 1;
        while (Math.max(o.outWidth, o.outHeight) / (o.inSampleSize * 2) >= maxPx) o.inSampleSize *= 2;
        o.inJustDecodeBounds = false;
        in = resolver.openInputStream(uri);
        try {
            return BitmapFactory.decodeStream(in, null, o);
        } finally {
            in.close();
        }
    }

    private static Bitmap scale(Bitmap b, int longest) {
        int max = Math.max(b.getWidth(), b.getHeight());
        if (max <= longest) return b;
        float s = longest / (float) max;
        return Bitmap.createScaledBitmap(b, Math.round(b.getWidth() * s), Math.round(b.getHeight() * s), true);
    }

    /** Keeps a picture as a data: URL under the server's 2 MB limit (on a white background). */
    private static String toDataUrl(Bitmap src) {
        for (int size : new int[] {1400, 1000, 700}) {
            Bitmap b = scale(src, size);
            Bitmap flat = Bitmap.createBitmap(b.getWidth(), b.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(flat);
            c.drawColor(Color.WHITE);
            c.drawBitmap(b, 0, 0, null);
            String png = encode(flat, Bitmap.CompressFormat.PNG, 100, "image/png");
            if (png.length() < 1_500_000) return png;
            String jpg = encode(flat, Bitmap.CompressFormat.JPEG, 90, "image/jpeg");
            if (jpg.length() < 1_900_000) return jpg;
        }
        return encode(scale(src, 600), Bitmap.CompressFormat.JPEG, 80, "image/jpeg");
    }

    private static String encode(Bitmap b, Bitmap.CompressFormat format, int quality, String type) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(format, quality, out);
        return "data:" + type + ";base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

}
