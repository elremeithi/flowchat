#!/bin/sh
# Make the data folder writable by the configured user. The server then drops root itself.
mkdir -p "$DATA_DIR" 2>/dev/null
if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ]; then
  chown -R "$PUID:$PGID" "$DATA_DIR" || echo "Could not take ownership of everything in $DATA_DIR. If the app fails to start, run: chown -R $PUID:$PGID <your data folder> on the host."
fi
exec node /app/server.js
