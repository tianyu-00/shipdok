#!/bin/sh
# Fails if an image holds a file that must never be published: environment files, private keys, the login cookie jar.
# Usage: check-image.sh <image>
set -eu
image="$1"
found="$(docker run --rm --entrypoint sh "$image" -c '
  find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "jar.txt" -o -name "id_rsa*" \) \
    -not -path "*/node_modules/*" -not -path "/etc/ssl*" -not -path "/etc/pki/*" -not -path "/usr/lib/ssl/*" -not -path "/usr/share/ca-certificates/*" \
    -not -path "/proc/*" 2>/dev/null || true  # find exits 1 on directories it may not read; that is not a finding
')"
if [ -n "$found" ]; then
  echo "Secret-looking files found in $image:" >&2
  echo "$found" >&2
  exit 1
fi
echo "No secret-looking files in $image"
