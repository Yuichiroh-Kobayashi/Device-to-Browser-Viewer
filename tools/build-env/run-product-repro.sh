#!/bin/sh
set -eu

usage() {
    printf 'usage: %s IMAGE SOURCE_DIR EVIDENCE_DIR historical|current\n' "$0" >&2
    exit 2
}

[ "$#" -eq 4 ] || usage

image=$1
source_dir=$2
evidence_dir=$3
mode=$4

case "$source_dir" in
    /*) ;;
    *) printf 'SOURCE_DIR must be absolute\n' >&2; exit 2 ;;
esac
case "$evidence_dir" in
    /*) ;;
    *) printf 'EVIDENCE_DIR must be absolute\n' >&2; exit 2 ;;
esac
case "$mode" in
    historical) tool=tools/product-repro/verify-beta1-reproduction.py ;;
    current) tool=tools/product-repro/build-current-product.py ;;
    *) usage ;;
esac

[ -d "$source_dir/.git" ] || {
    printf 'SOURCE_DIR must be a standalone Git checkout with a .git directory\n' >&2
    exit 2
}
[ -f "$source_dir/$tool" ] || {
    printf 'missing reproduction tool: %s\n' "$source_dir/$tool" >&2
    exit 2
}

mkdir -p "$evidence_dir"
if find "$evidence_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    printf 'EVIDENCE_DIR must be empty: %s\n' "$evidence_dir" >&2
    exit 2
fi

docker image inspect "$image" >/dev/null
docker run --rm \
    --platform linux/amd64 \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --env HOME=/tmp \
    --env TMPDIR=/evidence \
    --volume "$source_dir:/workspace:ro" \
    --volume "$evidence_dir:/evidence:rw" \
    --workdir /workspace \
    "$image" \
    /usr/bin/python3 "$tool"

case "$mode" in
    historical) summary_name=verification-summary.json ;;
    current) summary_name=current-product-summary.json ;;
esac

summary=$(find "$evidence_dir" -mindepth 2 -maxdepth 2 -type f -name "$summary_name" -print)
[ "$(printf '%s\n' "$summary" | sed '/^$/d' | wc -l)" -eq 1 ] || {
    printf 'expected exactly one %s under %s\n' "$summary_name" "$evidence_dir" >&2
    exit 1
}
printf '%s\n' "$summary"
