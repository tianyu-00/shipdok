#!/bin/sh
# Starts the worker as the unprivileged `node` user, but with the group that owns the Docker socket.
#
# That group's number differs from machine to machine (999, 998, 1001 ...), so it is read from the socket itself instead of being
# configured. The container starts as root only for the few lines below; `setpriv` then drops to node (user, group and the one extra
# group), and nothing of Shipdok ever runs as root. Without the socket (a test, a plain `docker run`) it just runs the command.
set -eu

SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
CURRENT_UID="${ENTRYPOINT_UID:-$(id -u)}" # overridable only so that the script can be tested without being root

if [ "$CURRENT_UID" = "0" ]; then
  # The container starts as root, so HOME is /root: not readable by node, which breaks git (its config) and docker (its config and the
  # buildx plugin it finds there). Give the process node's own home, as `USER node` used to.
  export HOME=/home/node USER=node LOGNAME=node
  if [ -S "$SOCKET" ]; then
    SOCKET_GID="$(stat -c %g "$SOCKET")"
    exec setpriv --reuid=node --regid=node --groups="$SOCKET_GID" "$@"
  fi
  exec setpriv --reuid=node --regid=node --clear-groups "$@"
fi
exec "$@"
