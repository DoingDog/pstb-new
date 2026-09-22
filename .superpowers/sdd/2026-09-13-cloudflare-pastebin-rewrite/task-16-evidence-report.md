# Task 16 evidence tooling report

## Scope

Implemented the evidence-tooling files in the assigned scope:

- `scripts/browser-evidence.mjs`
- `scripts/verify-release-evidence.mjs`
- `test/e2e/browser-manual.md`
- `test/e2e/accessibility-manual.md`

The scripts implement official-source normalization, target derivation, closed branded receipt paths, immutable receipt hashing, release-date timestamp validation, one-call operation clocks, deadline handling, atomic writes, lock files, manual accessibility aggregation, engine reporter ingestion, and final release verification.

`browser-evidence.mjs self-test` uses temporary directories under `os.tmpdir()` and injected clocks. It exercises Chrome duplicate grouping, Edge UTC normalization, Firefox UTC-midnight normalization, Safari table/entity parsing, nonadjacent major selection, campaign no-write failures, deadline failures, closed mapping failures, future receipt rejection, accessibility receipt rejection, and engine reporter/observation output policies. `verify-release-evidence.mjs --self-test` creates a complete temporary campaign, accepts it, then rejects source, target, branded receipt, timestamp, engine, and manual accessibility mutations.

## RED evidence

Before either script existed:

```plaintext
node scripts/browser-evidence.mjs self-test
Error: Cannot find module '...\\scripts\\browser-evidence.mjs'

node scripts/verify-release-evidence.mjs --self-test
Error: Cannot find module '...\\scripts\\verify-release-evidence.mjs'
```

After creating self-test placeholders and before implementation:

```plaintext
node scripts/browser-evidence.mjs self-test
Error: browser evidence self-test is not implemented

node scripts/verify-release-evidence.mjs --self-test
Error: release evidence verifier self-test is not implemented
```

## Commands and results

```powershell
node scripts/browser-evidence.mjs self-test
# exit 0

node scripts/verify-release-evidence.mjs --self-test
# exit 0

node --check scripts/browser-evidence.mjs
node --check scripts/verify-release-evidence.mjs
git diff --check
# exit 0
```

The final verifier was run without generated release artifacts:

```plaintext
node scripts/verify-release-evidence.mjs
ENOENT: no such file or directory, open '...\\test\\e2e\\browser-matrix.json'
```

That failure is expected while the source-acquisition campaign is blocked and no release evidence is fabricated.

## Official acquisition result

The release controller clock was inside the intended release window:

```plaintext
node -p "new Date().toISOString()"
2026-09-22T07:46:27.410Z
```

Acquisition was attempted with the required command:

```powershell
node scripts/browser-evidence.mjs acquire-targets --release-date 2026-09-22
```

It exited nonzero before staging any artifacts:

```plaintext
Official vendor source did not return HTTP 200: https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions/all/releases?filter=fraction%3D1&order_by=starttime%20desc&page_size=1000&page_token=2283488919
```

A direct read of the first official Chrome response returned HTTP 200, 1,000 records, and a `nextPageToken`; the exact required `page_token` follow-up returned HTTP 400. The command correctly treated that as an acquisition failure and wrote no source artifacts, matrix, accessibility aggregate, branded receipt, Safari unavailable receipt, engine receipt, or manual accessibility pass.

## Generated artifacts

No release-time JSON evidence was committed. Creating `browser-matrix.json`, `accessibility-manual.json`, official source artifacts, browser receipts, engine receipts, or accessibility receipts without a successful official campaign or actual environments would create false release evidence.

The two manual procedure files were created. They describe how actual testers produce the six branded browser smoke checks and four manual accessibility categories after the respective real environments are available.

## Blockers

- The Chrome official source cannot complete the required exact `page_token` pagination contract because the official follow-up returned HTTP 400.
- This worktree has no pre-provisioned Chrome, Edge, Firefox historical binaries, no macOS Safari runner, and no actual screen-reader, contrast, zoom, or physical-touch executions. No branded, Safari, engine, or manual accessibility pass is claimed.

## Commit

Committed as `test: add release evidence tooling`.
