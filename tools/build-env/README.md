# Viewer Build Environment V1

This directory defines the qualified, container-only build interface for the
device-hosted product Viewer. It does not add a runtime dependency to the root
development harness or change the recovered historical builder.

The Dockerfile is the exact Candidate A definition that passed the repository's
historical beta.1 oracle, final PR #11 continuity, and independent fresh-container
determinism. The qualified local image digest and exact output authorities are
recorded in
[`docs/provenance/build-environment-v1.json`](../../docs/provenance/build-environment-v1.json).
That image is a new reproducible baseline with historical-output-equivalent
results. Ubuntu 24.04 and Node 18.19.1 are not claims about the unknown original
beta.1 host.

## Build and inspect

~~~sh
docker build \
  --platform linux/amd64 \
  --provenance=false \
  -t viewer-build-env-v1 \
  -f tools/build-env/Dockerfile \
  .

docker run --rm --network none --platform linux/amd64 \
  -v "$PWD/tools/build-env/inventory.sh:/inventory.sh:ro" \
  viewer-build-env-v1 sh /inventory.sh > /tmp/viewer-build-env-v1-inventory.txt

python3 tools/build-env/verify.py provenance
python3 tools/build-env/verify.py inventory \
  /tmp/viewer-build-env-v1-inventory.txt
~~~

The complete inventory, including all installed dpkg identities, belongs in
the evidence for each qualification run. `verify.py` additionally fails closed
on the exact build-facing paths, versions, and directly requested packages.
A rebuilt image is not silently substituted for the qualified image digest:
it must pass the same inventory and output gates before its output is trusted.

## Run the existing reproduction tools

`run-product-repro.sh` accepts only an absolute, standalone Git checkout and a
fresh evidence directory. It mounts source read-only, disables networking, and
runs the repository's existing tool unchanged in a read-only container:

~~~sh
tools/build-env/run-product-repro.sh \
  viewer-build-env-v1 \
  /absolute/path/to/clean/viewer-checkout \
  /absolute/path/to/fresh/evidence \
  current
~~~

Use `historical` for `verify-beta1-reproduction.py`. Use `current` for
`build-current-product.py`; the latter still enforces its clean-HEAD, D2B-tree,
file-scope, recovered-builder, and two-run determinism gates.

## CI bootstrap boundary

The workflow runs on pushes to the dedicated infrastructure branch because a
new `workflow_dispatch` definition cannot be invoked from the default branch
until that definition exists there. It also declares `workflow_dispatch` for
later manual qualification. The workflow has read-only repository permission,
does not use Docker cache as provenance, fetches exact PR #12 authority, and
re-runs the historical, PR #11, and PR #12 gates before emitting a summary.
It does not merge, release, tag, update PR #12, or publish Viewer assets.

## CI review evidence artifact

After every qualification gate and the runner-local evidence checksum gate
passes, CI stages a compact review package and uploads exactly one artifact
named `viewer-repro-build-evidence-RUN_ID`. The artifact retains the run and
container authority, complete toolchain inventory, historical beta.1 summary,
PR #11 summary, PR #12 summary and exact served representations, relevant
result logs, and a `SHA256SUMS` covering every retained file.

The explicit retention period is 30 days. GitHub Actions Artifact storage is
evidence transport for external review, not permanent archival storage. The
GitHub-generated ZIP digest is also not the Viewer bundle authority. Authority
remains separated as follows:

- GitHub Actions Artifact: evidence transport and retention;
- internal `SHA256SUMS`: artifact-content integrity;
- tracked `build-environment-v1.json`: expected authority;
- exact files under `pr12/served/`: built-byte authority.

An authorized external reviewer can download and verify a run with:

~~~sh
gh run download RUN_ID \
  --name viewer-repro-build-evidence-RUN_ID \
  --dir viewer-repro-build-evidence-RUN_ID
cd viewer-repro-build-evidence-RUN_ID
sha256sum -c SHA256SUMS
~~~

The local immutable qualification evidence remains a separate authority and is
not replaced by the retained GitHub artifact.
