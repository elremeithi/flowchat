# Flowchat

A personal chat and file drop you host yourself. Sign in from any browser, write
notes, paste links, share files, and pick up where you left off on another device.

- One password, long-lived sign-in per device (90 days by default)
- Messages and files appear live on every signed-in device
- Drag and drop, paste, or pick files; images, video and audio preview in place
- "Devices" lists every signed-in browser and can sign any of them out
- No database and no npm packages: everything lives in one `/data` folder

## Install on Unraid

1. Copy this folder to the server, for example to `/mnt/user/appdata/flowchat-src`.
2. Open the Unraid terminal and build the image:

   ```bash
   docker build -t flowchat:latest /mnt/user/appdata/flowchat-src
   ```

   Or, if you have the prebuilt `flowchat-image.tar.gz` (Intel/AMD servers), load it instead of building:

   ```bash
   docker load -i /mnt/user/appdata/flowchat-src/flowchat-image.tar.gz
   ```

3. Install the template:

   ```bash
   cp /mnt/user/appdata/flowchat-src/unraid/my-flowchat.xml /boot/config/plugins/dockerMan/templates-user/
   ```

4. In the Unraid web UI: Docker → Add Container → Template → **flowchat**.
   Set **Password**, check the port and data path, then Apply.
5. Open `http://<server-ip>:8080`.

Because the image is built locally, Unraid's "check for updates" reports it as
unavailable. To update, copy the new source over and repeat step 2, then
restart the container.

With the Compose Manager plugin you can use `docker-compose.yml` instead: copy
`.env.example` to `.env` next to it and fill in your values (`.env` is git-ignored).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_PASSWORD` | generated | Sign-in password, and the key that unlocks your stored data. If unset, one is generated and saved in `/data/generated-password.txt`, which leaves the data unprotected; set your own. |
| `OLD_APP_PASSWORD` | unset | Only when changing the password: the previous one, for one start. See Security. |
| `ENCRYPTION_KEY` | unset | Only for upgrading data from an older version that used it, for one start. |
| `TOTP_SECRET` | off | Adds a 6-digit authenticator code to sign-in. |
| `REQUIRE_HTTPS` | `0` | `1` refuses plain HTTP. Use it behind an HTTPS proxy. |
| `ALLOWED_HOSTS` | any | Comma-separated addresses the app answers on. |
| `RETENTION_DAYS` | `0` | Auto-delete messages and files older than this. `0` keeps everything. |
| `WEBHOOK_URL` | off | Announce every new message to this address. Comma-separate several. |
| `WEBHOOK_SECRET` | off | Signs outgoing webhooks. |
| `WEBHOOK_INCLUDE_TEXT` | `1` | `0` announces only that a message arrived, without text or file name. |
| `MAX_UPLOAD_MB` | `2048` | Largest file that can be uploaded. |
| `SESSION_DAYS` | `90` | How long an unused device stays signed in. |
| `TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy so login throttling sees real client addresses. |
| `PUID` / `PGID` | `99` / `100` | Owner of the files in `/data` (Unraid's nobody:users). |

Data: `/data/messages.jsonl`, `/data/sessions.json`, `/data/uploads/`. Back up that folder.

## Webhooks

**Incoming** (other tools post into the chat). Open Settings in the app, name a
webhook and press Create. The address is shown once; anyone who has it can post
messages (not read them), so treat it like a password. Remove a webhook in
Settings to switch its address off.

```bash
curl -d "Backup finished" https://flow.example.com/hook/<token>
```

```bash
curl -H "Content-Type: application/json" -d '{"title":"Array","text":"Parity check done"}' https://flow.example.com/hook/<token>
```

Accepted bodies: plain text, or JSON / form fields named `text`, `content`,
`message`, `body` or `description`, with an optional `title` or `subject`.
Limits: 256 KB per message, 60 messages a minute per webhook.

**Outgoing** (the chat notifies another service). Set `WEBHOOK_URL`; every new
message is sent there as a POST:

```json
{"event":"message","message":{"id":"…","ts":1794407089873,"from":"Opera on Windows","source":"device","text":"hello","file":{"name":"a.pdf","size":1234,"type":"application/pdf"}}}
```

`source` is `device` or `webhook`. File contents are never sent. With
`WEBHOOK_SECRET` set, each request carries
`X-Flowchat-Signature: sha256=<HMAC-SHA256 of the body>` so the receiver can
verify it. Outgoing webhooks send message text off the server; set
`WEBHOOK_INCLUDE_TEXT=0` to send only a "new message" notice. Outgoing addresses
are set in the container settings on purpose, so a signed-in browser cannot
redirect your messages elsewhere.

## Android app

![Flowchat on a phone: sign in, chat, notes, a note, settings and dark mode](docs/app-preview.png)

`android/Flowchat.apk` is a small companion app (Android 10 or newer):

- **Chat** with your server's page, with the phone's file picker for attachments
  and downloads saved to the Downloads folder.
- **Share to Flowchat** from any app (photos, files, links, text). It asks before sending.
- **Webhook alerts as notifications** while the app is closed. Choose in the app
  settings: webhook alerts only (default), webhook alerts and messages from your
  other devices, or none. Alerts missed while the phone was offline are announced
  on reconnect (up to five, then a count).

Install: copy the APK to the phone, open it, and allow installing from that
source when Android asks. Enter your server address, sign in, and allow
notifications. Then, in the app settings (Settings → Phone app settings), tap
**Allow background use** so Android does not pause the connection.

To deliver alerts the app keeps one connection open and shows a silent
"Flowchat alerts" notification; hide it under Android's notification settings →
Flowchat → Background connection. On the lock screen alerts show only
"New Flowchat alert"; the text needs the phone unlocked. The app's data is
excluded from backups and phone-to-phone transfers.

Build it with `android/build.sh` on Ubuntu/Debian (packages listed at the top
of the script; it downloads the Android class library from Maven Central on the
first run). Sign with your own key:

```bash
KEYSTORE=~/keys/flowchat.jks KEYSTORE_PASS_FILE=~/keys/flowchat.pass KEY_ALIAS=flowchat android/build.sh
```

Without those variables the first build creates `android/flowchat.keystore` and
`android/flowchat.keystore.pass` (both git-ignored). **Keep the key private and
backed up**: Android only installs updates signed with the same key, and anyone
holding it can sign an app your phone would accept as an update.

## Security

Built in, nothing to configure:

- Sign-in cookies are HttpOnly and SameSite=Strict; over HTTPS they are also
  Secure and host-locked. Only a hash of each token is stored on the server.
- Repeated wrong passwords are throttled per address and overall, and logged.
- Other websites can neither send requests to the app nor load its files.
- Uploaded files are never run as web pages, and never kept in the browser's
  disk cache. Signing out clears what the browser stored.
- Data files are readable only by the app's user. The app process runs as a non-root user,
  in a container with a read-only filesystem and almost all capabilities dropped.

**Encryption at rest, always on, with your password.** Messages, notes, file
names and contents, the device list and webhooks are stored encrypted
(AES-256-GCM / AES-256-CTR) with a random data key. That key is kept in
`/data/key.json`, locked with a key derived from `APP_PASSWORD` (scrypt, about
128 MB of memory per guess, which makes guessing slow). A copy of the appdata
folder, such as a backup or a stolen disk, is unreadable without the password.
It does not protect against someone who controls the running server, because
the password is in the container settings.

- **Use a long password.** Someone holding a copy of the folder can try
  passwords offline; the scrypt cost slows that down but cannot save a short one.
- **Do not lose the password.** There is no recovery: without it the data is
  gone. Keep `key.json` together with the rest of the folder in backups.
- **Changing the password:** set the new one as `APP_PASSWORD` and the previous
  one as `OLD_APP_PASSWORD`, start once, then remove `OLD_APP_PASSWORD`. Only
  the small key file is re-locked; every device is signed out. If you change
  `APP_PASSWORD` without this, the app refuses to start rather than touch the data.
- **Upgrading from a version that used `ENCRYPTION_KEY`:** keep it set for one
  start; its data is moved under the password, after which it can be removed.
  Data from versions without encryption is encrypted automatically on first start.

Worth switching on:

**Two-step sign-in** (`TOTP_SECRET`). Create a secret:

```bash
docker run --rm --entrypoint node flowchat:latest /app/server.js --totp-new
```

Put the printed `TOTP_SECRET` value in the container settings and add the same
secret to an authenticator app (manual entry, or turn the printed link into a
QR code on a device you trust). A stolen password alone then no longer signs in.

**If you think the password leaked:** change it as described above. Every
device is signed out. The Devices list shows who is signed in at any time, and
the container log records each sign-in and failed attempt.

## Reaching it from anywhere

Do not forward port 8080 straight to the internet: the app speaks plain HTTP.
Put it behind one of these:

- **Tailscale or WireGuard** (built into Unraid): simplest, nothing is public.
- **A reverse proxy with HTTPS** (Nginx Proxy Manager, SWAG, Caddy). Raise the
  proxy's upload limit to match `MAX_UPLOAD_MB` (nginx: `client_max_body_size 2048m;`)
  and turn off request buffering for large files (`proxy_request_buffering off;`).
  Set `TRUST_PROXY=1`, `REQUIRE_HTTPS=1` and `ALLOWED_HOSTS` to your address.
- **Cloudflare Tunnel**: works, but Cloudflare caps uploads at 100 MB on the free plan.

Over HTTPS the page can be installed as an app from the browser menu
("Install" / "Add to Home Screen").

## Run without Docker

```bash
APP_PASSWORD=secret DATA_DIR=./data node server.js
```

Needs Node 20 or newer.
