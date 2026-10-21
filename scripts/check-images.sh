#!/bin/sh
# Builds the Shipdok images on THIS machine and runs the same secret check the publish workflow runs, so a broken Dockerfile or a secret in an
# image is found before anything is pushed (the workflow runs only on a push to `publish` and costs GitHub Actions minutes).
#
#   npm run check-images              all three: api, worker, web
#   npm run check-images -- worker    only the ones named
#   KEEP=1 npm run check-images       keep the built images (shipdok-check:<name>) afterwards
#
# It builds for this machine's architecture only. The workflow also builds for ARM64 (emulated); to check ARM64, build on the Pi with
# `docker compose -f infrastructure/compose.yaml -f infrastructure/compose.build.yaml build`.
set -u
cd "$(dirname "$0")/.."

images="${*:-api worker web}"
for name in $images; do
  case "$name" in
    api|worker|web) ;;
    *) echo "Unknown image \"$name\": choose from api, worker, web" >&2; exit 2 ;;
  esac
done

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
failed=""
summary=""

for name in $images; do
  tag="shipdok-check:$name"
  start="$(date +%s)"
  printf 'Building %-7s ' "$name"
  if docker build --progress=plain -f "apps/$name/Dockerfile" -t "$tag" . >"$log" 2>&1; then
    printf 'built in %ss, checking for secrets... ' "$(( $(date +%s) - start ))"
    if sh .github/scripts/check-image.sh "$tag" >"$log" 2>&1; then
      echo "ok"
      summary="$summary\n  ok      $name"
    else
      echo "FAILED"
      cat "$log" >&2
      failed="$failed $name"
      summary="$summary\n  FAILED  $name (a file that must never be published is in the image)"
    fi
  else
    echo "FAILED"
    echo "--- last lines of the build of $name ---" >&2
    tail -n 40 "$log" >&2
    failed="$failed $name"
    summary="$summary\n  FAILED  $name (the build)"
  fi
done

if [ "${KEEP:-}" != "1" ]; then
  for name in $images; do docker rmi "shipdok-check:$name" >/dev/null 2>&1 || true; done
fi

printf '\n%b\n' "$summary"
if [ -n "$failed" ]; then
  echo "Not ready to publish:$failed" >&2
  exit 1
fi
echo "All images build and are free of secret-looking files (this machine's architecture only)."
