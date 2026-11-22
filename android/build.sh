#!/bin/bash
# Builds Flowchat.apk without Android Studio, using Ubuntu's Android packages:
#   sudo apt-get install aapt zipalign apksigner dalvik-exchange android-framework-res default-jdk-headless
set -euo pipefail
cd "$(dirname "$0")"

VERSION_CODE=${VERSION_CODE:-7}
VERSION_NAME=${VERSION_NAME:-1.6}
FRAMEWORK=/usr/share/android-framework-res/framework-res.apk   # Android 13 resources
ANDROID_JAR=lib/android-all.jar                                  # Android 14 classes, compile only
ANDROID_ALL=14-robolectric-10818077
ZXING_JAR=lib/zxing-core-3.5.3.jar                            # QR and barcode reading/writing, Apache-2.0

if [ ! -f "$ZXING_JAR" ]; then
  mkdir -p lib
  curl -fL -o "$ZXING_JAR" https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar
fi
if [ ! -f "$ANDROID_JAR" ]; then
  mkdir -p lib
  curl -fL -o "$ANDROID_JAR" \
    "https://repo1.maven.org/maven2/org/robolectric/android-all/$ANDROID_ALL/android-all-$ANDROID_ALL.jar"
fi

rm -rf build
mkdir -p build/gen build/classes build/dex

aapt2 compile --dir res -o build/res.zip
aapt2 link -o build/base.apk -I "$FRAMEWORK" --manifest AndroidManifest.xml --java build/gen \
  --min-sdk-version 29 --target-sdk-version 33 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" build/res.zip

javac --release 8 -Xlint:-options -encoding UTF-8 -cp "$ANDROID_JAR:$ZXING_JAR" -d build/classes \
  $(find src build/gen -name '*.java')
dalvik-exchange --dex --min-sdk-version=26 --output=build/dex/classes.dex build/classes "$ZXING_JAR"

cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
zipalign -p -f 4 build/unsigned.apk build/aligned.apk

# Signing. Use your own key with KEYSTORE, KEYSTORE_PASS_FILE and KEY_ALIAS, for example:
#   KEYSTORE=~/keys/flowchat.jks KEYSTORE_PASS_FILE=~/keys/flowchat.pass KEY_ALIAS=flowchat ./build.sh
# Without them a key is made once in this folder (flowchat.keystore + flowchat.keystore.pass, both
# git-ignored). Keep the key safe: Android only installs updates signed with the same key.
KEYSTORE=${KEYSTORE:-flowchat.keystore}
KEYSTORE_PASS_FILE=${KEYSTORE_PASS_FILE:-flowchat.keystore.pass}
KEY_ALIAS=${KEY_ALIAS:-flowchat}
if [ ! -f "$KEYSTORE" ]; then
  PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
  printf '%s\n' "$PASS" > "$KEYSTORE_PASS_FILE"
  chmod 600 "$KEYSTORE_PASS_FILE"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass:file "$KEYSTORE_PASS_FILE" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=Flowchat" 2>/dev/null
  chmod 600 "$KEYSTORE"
fi
apksigner sign --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE_PASS_FILE" --ks-key-alias "$KEY_ALIAS" \
  --out Flowchat.apk build/aligned.apk
apksigner verify Flowchat.apk
echo "Built $(pwd)/Flowchat.apk"
