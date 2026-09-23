import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datePattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const timestampPattern = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const chromeSourceTimestampPattern = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{3}|\d{6}|\d{9}))?Z$/u;
const versionPattern = /^(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const productNames = Object.freeze(["Chrome", "Edge", "Firefox", "Safari"]);
const slots = Object.freeze(["current", "previous"]);
const windowsMetadataExtractionMethod = "windows-powershell-authenticode-fileversion-v1";
const windowsMetadataPathEnvironment = "CFPB_BROWSER_EXECUTABLE_LITERAL";
const windowsBrowserIdentities = Object.freeze({
  Chrome: Object.freeze({ productName: "Google Chrome", publisher: "Google LLC" }),
  Edge: Object.freeze({ productName: "Microsoft Edge", publisher: "Microsoft Corporation" }),
});
const windowsMetadataScript = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  `$LiteralPath = [Environment]::GetEnvironmentVariable('${windowsMetadataPathEnvironment}')`,
  "if ([string]::IsNullOrWhiteSpace($LiteralPath)) { throw 'Browser executable path is missing' }",
  "$file = Get-Item -LiteralPath $LiteralPath",
  "if ($file.PSIsContainer) { throw 'Browser executable path is not a file' }",
  "$signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath",
  "$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($file.FullName)",
  "[PSCustomObject]@{ path = $file.FullName; productName = $version.ProductName; productVersion = $version.ProductVersion; authenticodeStatus = [string]$signature.Status; publisher = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }; bytes = [long]$file.Length; sha256 = (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress",
].join("; ");
export const accessibilityCategories = Object.freeze(["screen-reader", "contrast", "zoom-reflow-200", "physical-touch"]);
export const browserCheckIds = Object.freeze([
  "root-create",
  "password-post-hard-refresh",
  "ordinary-edit-autosave",
  "tabs-sheet",
  "raw-html-md-file",
  "delete-root-handoff",
]);
export const engineSuiteFiles = Object.freeze([
  "test/e2e/create-password.spec.ts",
  "test/e2e/ordinary-sync.spec.ts",
  "test/e2e/view-once-representations.spec.ts",
  "test/e2e/accessibility.spec.ts",
  "test/e2e/engine-version.spec.ts",
]);

const sourceConfigurations = Object.freeze({
  Chrome: Object.freeze({
    id: "google-chrome-versionhistory-win-stable",
    url: "https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions/all/releases?filter=fraction%3D1&order_by=starttime%20desc&page_size=1000",
    artifact: "test/e2e/evidence/browser-target-sources/chrome-stable.json",
  }),
  Edge: Object.freeze({
    id: "microsoft-edge-enterprise-win-x64-stable",
    url: "https://edgeupdates.microsoft.com/api/products?view=enterprise",
    artifact: "test/e2e/evidence/browser-target-sources/edge-stable.json",
  }),
  Firefox: Object.freeze({
    id: "mozilla-firefox-stability-releases",
    url: "https://product-details.mozilla.org/1.0/firefox_history_stability_releases.json",
    artifact: "test/e2e/evidence/browser-target-sources/firefox-stable.json",
  }),
  Safari: Object.freeze({
    id: "apple-security-releases-safari",
    url: "https://support.apple.com/en-us/100100",
    artifact: "test/e2e/evidence/browser-target-sources/safari-stable.json",
  }),
});

export const browserMappings = Object.freeze({
  "Chrome/current": Object.freeze({ product: "Chrome", slot: "current", environment: "windows-chrome-current", sourceArtifact: sourceConfigurations.Chrome.artifact, capture: "test/e2e/evidence/browser-matrix/chrome-current-capture.json", smoke: "test/e2e/evidence/browser-matrix/chrome-current.json", unavailable: null }),
  "Chrome/previous": Object.freeze({ product: "Chrome", slot: "previous", environment: "windows-chrome-previous", sourceArtifact: sourceConfigurations.Chrome.artifact, capture: "test/e2e/evidence/browser-matrix/chrome-previous-capture.json", smoke: "test/e2e/evidence/browser-matrix/chrome-previous.json", unavailable: null }),
  "Edge/current": Object.freeze({ product: "Edge", slot: "current", environment: "windows-edge-current", sourceArtifact: sourceConfigurations.Edge.artifact, capture: "test/e2e/evidence/browser-matrix/edge-current-capture.json", smoke: "test/e2e/evidence/browser-matrix/edge-current.json", unavailable: null }),
  "Edge/previous": Object.freeze({ product: "Edge", slot: "previous", environment: "windows-edge-previous", sourceArtifact: sourceConfigurations.Edge.artifact, capture: "test/e2e/evidence/browser-matrix/edge-previous-capture.json", smoke: "test/e2e/evidence/browser-matrix/edge-previous.json", unavailable: null }),
  "Firefox/current": Object.freeze({ product: "Firefox", slot: "current", environment: "windows-firefox-current", sourceArtifact: sourceConfigurations.Firefox.artifact, capture: "test/e2e/evidence/browser-matrix/firefox-current-capture.json", smoke: "test/e2e/evidence/browser-matrix/firefox-current.json", unavailable: null }),
  "Firefox/previous": Object.freeze({ product: "Firefox", slot: "previous", environment: "windows-firefox-previous", sourceArtifact: sourceConfigurations.Firefox.artifact, capture: "test/e2e/evidence/browser-matrix/firefox-previous-capture.json", smoke: "test/e2e/evidence/browser-matrix/firefox-previous.json", unavailable: null }),
  "Safari/current": Object.freeze({ product: "Safari", slot: "current", environment: "macos-safari-current", sourceArtifact: sourceConfigurations.Safari.artifact, capture: "test/e2e/evidence/browser-matrix/safari-current-capture.json", smoke: "test/e2e/evidence/browser-matrix/safari-current.json", unavailable: "test/e2e/evidence/browser-matrix/safari-current-runner-unavailable.json" }),
  "Safari/previous": Object.freeze({ product: "Safari", slot: "previous", environment: "macos-safari-previous", sourceArtifact: sourceConfigurations.Safari.artifact, capture: "test/e2e/evidence/browser-matrix/safari-previous-capture.json", smoke: "test/e2e/evidence/browser-matrix/safari-previous.json", unavailable: "test/e2e/evidence/browser-matrix/safari-previous-runner-unavailable.json" }),
});

export const engineMappings = Object.freeze({
  chromium: Object.freeze({ report: "test/e2e/evidence/engine/chromium-report.json", observation: "test/e2e/evidence/engine/chromium-version-observation.json", receipt: "test/e2e/evidence/engine/chromium-receipt.json" }),
  firefox: Object.freeze({ report: "test/e2e/evidence/engine/firefox-report.json", observation: "test/e2e/evidence/engine/firefox-version-observation.json", receipt: "test/e2e/evidence/engine/firefox-receipt.json" }),
  webkit: Object.freeze({ report: "test/e2e/evidence/engine/webkit-report.json", observation: "test/e2e/evidence/engine/webkit-version-observation.json", receipt: "test/e2e/evidence/engine/webkit-receipt.json" }),
});

export const matrixPath = "test/e2e/browser-matrix.json";
export const matrixLockPath = "test/e2e/browser-matrix.json.lock";
export const accessibilityPath = "test/e2e/accessibility-manual.json";
export const accessibilityLockPath = "test/e2e/accessibility-manual.json.lock";

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value, keys, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} has unknown or missing keys`);
  }
  return value;
}

function string(value, name, nonempty = false) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) fail(`${name} must be${nonempty ? " a nonempty" : ""} string`);
  return value;
}

function safeInteger(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be a safe integer`);
  return value;
}

function equal(value, expected, name) {
  if (value !== expected) fail(`${name} must equal ${JSON.stringify(expected)}`);
  return value;
}

function json(value, name) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${name} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function absolute(repoRoot, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    fail("Artifact path must be a nonempty in-tree POSIX relative path");
  }
  const output = resolve(repoRoot, path);
  const back = relative(repoRoot, output);
  if (back.startsWith("..") || isAbsolute(back)) fail("Artifact path escapes repository root");
  return output;
}

function pathFromAbsolute(repoRoot, path) {
  const normalized = relative(repoRoot, path).split(sep).join("/");
  absolute(repoRoot, normalized);
  return normalized;
}

async function readBytes(repoRoot, path, options = {}) {
  const checkpoint = options.checkpoint ?? (() => options.signal?.throwIfAborted());
  checkpoint();
  const bytes = await (options.readFileImpl ?? readFile)(
    absolute(repoRoot, path),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  checkpoint();
  return bytes;
}

async function readJson(repoRoot, path, name = path, options = {}) {
  return json((await readBytes(repoRoot, path, options)).toString("utf8"), name);
}

export async function writeAtomic(path, contents, options = {}) {
  const operations = options.operations ?? { mkdir, writeFile, rename, rm };
  const checkpoint = options.checkpoint ?? (() => options.signal?.throwIfAborted());
  let temporary;
  let committed = false;
  try {
    checkpoint();
    await operations.mkdir(dirname(path), { recursive: true });
    checkpoint();
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await operations.writeFile(temporary, contents, {
      encoding: typeof contents === "string" ? "utf8" : undefined,
      flag: "wx",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    checkpoint();
    if (options.signal === undefined) await operations.rename(temporary, path);
    else (operations.renameSync ?? renameSync)(temporary, path);
    committed = true;
    checkpoint();
  } catch (error) {
    if (committed) {
      (operations.rmSync ?? rmSync)(path, { force: true });
    } else if (temporary !== undefined) {
      await operations.rm(temporary, { force: true });
    }
    throw error;
  }
}

async function stage(path, contents, options = {}) {
  const checkpoint = options.checkpoint ?? (() => options.signal?.throwIfAborted());
  let temporary;
  try {
    checkpoint();
    await mkdir(dirname(path), { recursive: true });
    checkpoint();
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, contents, { encoding: typeof contents === "string" ? "utf8" : undefined, flag: "wx", ...(options.signal === undefined ? {} : { signal: options.signal }) });
    checkpoint();
    return { path, temporary };
  } catch (error) {
    if (temporary !== undefined) await rm(temporary, { force: true });
    throw error;
  }
}

async function discardStages(stages) {
  await Promise.all(stages.map(({ temporary }) => rm(temporary, { force: true })));
}

export async function withLock(repoRoot, relativeLockPath, action) {
  const lock = absolute(repoRoot, relativeLockPath);
  await mkdir(dirname(lock), { recursive: true });
  let handle;
  try {
    handle = await open(lock, "wx");
  } catch (error) {
    fail(`Evidence lock is held: ${relativeLockPath}`);
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

export function validateReleaseDate(value) {
  string(value, "releaseDate");
  if (!datePattern.test(value)) fail("releaseDate must be Gregorian YYYY-MM-DD");
  const midnight = `${value}T00:00:00.000Z`;
  const instant = Date.parse(midnight);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== midnight) fail("releaseDate is not Gregorian");
  return { value, midnight, instant };
}

export function canonicalTimestamp(value, name = "timestamp") {
  string(value, name);
  if (!timestampPattern.test(value)) fail(`${name} must be canonical RFC3339 UTC`);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) fail(`${name} is not a canonical instant`);
  return { value, instant };
}

function chromeSourceTimestamp(value, name) {
  string(value, name);
  const match = chromeSourceTimestampPattern.exec(value);
  if (match === null) fail(`${name} must be a UTC Google Timestamp with 0, 3, 6, or 9 fractional digits`);
  const [, date, time, fraction] = match;
  const base = canonicalTimestamp(`${date}T${time}.000Z`, name);
  const milliseconds = (fraction ?? "").slice(0, 3).padEnd(3, "0");
  const sourceInstant = BigInt(base.instant) * 1_000_000n + BigInt((fraction ?? "").padEnd(9, "0") || "0");
  return { value: `${date}T${time}.${milliseconds}Z`, sourceInstant };
}

function timestampFromClock(value, name) {
  if (!Number.isFinite(value)) fail(`${name} clock must return a finite number`);
  return new Date(value).toISOString();
}

export function contextFor(releaseDate, commandNow) {
  const date = validateReleaseDate(releaseDate);
  const now = canonicalTimestamp(commandNow, "command clock");
  const start = date.instant - 7 * 86_400_000;
  const end = date.instant + 86_400_000;
  if (now.instant < start || now.instant >= end) fail("Operation clock is outside release evidence freshness interval");
  return Object.freeze({ releaseDate: date.value, releaseInstant: date.instant, commandNow: now.value, commandNowInstant: now.instant, start, end, remaining: end - now.instant });
}

export function captureContext(releaseDate, clock = Date.now) {
  const commandNow = timestampFromClock(clock(), "operation");
  return contextFor(releaseDate, commandNow);
}

export function assertEvidenceTimestamp(value, name, context, allowHistorical = false) {
  const timestamp = canonicalTimestamp(value, name);
  if (allowHistorical) {
    if (timestamp.instant > context.commandNowInstant) fail(`${name} is later than operation clock`);
    return timestamp;
  }
  if (timestamp.instant < context.start || timestamp.instant >= context.end || timestamp.instant > context.commandNowInstant) {
    fail(`${name} is outside freshness interval or later than operation clock`);
  }
  return timestamp;
}

function assertReleasedAt(value, retrievedAt, name) {
  const released = canonicalTimestamp(value, name);
  const retrieved = canonicalTimestamp(retrievedAt, "retrievedAt");
  if (released.instant > retrieved.instant) fail(`${name} is later than retrievedAt`);
  return released;
}

function version(value, name) {
  string(value, name);
  if (!versionPattern.test(value)) fail(`${name} must be numeric dotted version`);
  return value;
}

function versionMajor(value, name) {
  version(value, name);
  const major = Number(value.split(".")[0]);
  return safeInteger(major, `${name} major`, 1);
}

function compareVersionTuple(left, right) {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0n) - (rightParts[index] ?? 0n);
    if (difference < 0n) return -1;
    if (difference > 0n) return 1;
  }
  return 0;
}

function mappingFor(product, slot, environment) {
  if (!productNames.includes(product) || !slots.includes(slot)) fail("Unknown branded browser tuple");
  const mapping = browserMappings[`${product}/${slot}`];
  if (mapping === undefined) fail("Closed branded mapping does not contain tuple");
  if (environment !== undefined) equal(environment, mapping.environment, "environment");
  return mapping;
}

function engineMapping(project) {
  if (!Object.hasOwn(engineMappings, project)) fail("Unknown engine project");
  return engineMappings[project];
}

function artifactRef(value, name, expectedPath) {
  sameKeys(value, ["path", "sha256"], name);
  string(value.path, `${name}.path`, true);
  if (expectedPath !== undefined) equal(value.path, expectedPath, `${name}.path`);
  if (!hashPattern.test(string(value.sha256, `${name}.sha256`))) fail(`${name}.sha256 must be lowercase SHA-256`);
  return value;
}

function target(value, name, expected) {
  sameKeys(value, ["sourceArtifact", "sourceSha256", "exactVersion", "major"], name);
  string(value.sourceArtifact, `${name}.sourceArtifact`, true);
  if (expected?.sourceArtifact !== undefined) equal(value.sourceArtifact, expected.sourceArtifact, `${name}.sourceArtifact`);
  if (!hashPattern.test(string(value.sourceSha256, `${name}.sourceSha256`))) fail(`${name}.sourceSha256 must be lowercase SHA-256`);
  version(value.exactVersion, `${name}.exactVersion`);
  equal(value.major, versionMajor(value.exactVersion, `${name}.exactVersion`), `${name}.major`);
  if (expected !== undefined) {
    equal(value.sourceSha256, expected.sourceSha256, `${name}.sourceSha256`);
    equal(value.exactVersion, expected.exactVersion, `${name}.exactVersion`);
    equal(value.major, expected.major, `${name}.major`);
  }
  return value;
}

function sameTarget(left, right, name) {
  target(left, `${name}.left`);
  target(right, `${name}.right`);
  for (const key of ["sourceArtifact", "sourceSha256", "exactVersion", "major"]) equal(left[key], right[key], `${name}.${key}`);
}

function tuple(value, name, mapping) {
  equal(value.product, mapping.product, `${name}.product`);
  equal(value.slot, mapping.slot, `${name}.slot`);
  equal(value.environment, mapping.environment, `${name}.environment`);
}

function sourceRelease(value, name) {
  sameKeys(value, ["sourceReleaseIds", "exactVersion", "major", "releasedAt"], name);
  if (!Array.isArray(value.sourceReleaseIds) || value.sourceReleaseIds.length === 0) fail(`${name}.sourceReleaseIds must be nonempty`);
  const ids = value.sourceReleaseIds.map((entry, index) => string(entry, `${name}.sourceReleaseIds[${index}]`, true));
  if (ids.join("\u0000") !== [...ids].sort().join("\u0000") || new Set(ids).size !== ids.length) fail(`${name}.sourceReleaseIds must be sorted and unique`);
  version(value.exactVersion, `${name}.exactVersion`);
  equal(value.major, versionMajor(value.exactVersion, `${name}.exactVersion`), `${name}.major`);
  canonicalTimestamp(value.releasedAt, `${name}.releasedAt`);
  return value;
}

export function sourceArtifact(value, name, expectedProduct, expectedReleaseDate, context) {
  sameKeys(value, ["schemaVersion", "releaseDate", "product", "channel", "source", "retrievedAt", "releases"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  if (expectedReleaseDate !== undefined) equal(value.releaseDate, expectedReleaseDate, `${name}.releaseDate`);
  validateReleaseDate(value.releaseDate);
  equal(value.product, expectedProduct, `${name}.product`);
  equal(value.channel, "stable", `${name}.channel`);
  const config = sourceConfigurations[expectedProduct];
  sameKeys(value.source, ["id", "url", "responseCount", "responseSha256"], `${name}.source`);
  equal(value.source.id, config.id, `${name}.source.id`);
  equal(value.source.url, config.url, `${name}.source.url`);
  safeInteger(value.source.responseCount, `${name}.source.responseCount`, 1);
  if (!hashPattern.test(string(value.source.responseSha256, `${name}.source.responseSha256`))) fail(`${name}.source.responseSha256 must be lowercase SHA-256`);
  const retrieved = canonicalTimestamp(value.retrievedAt, `${name}.retrievedAt`);
  if (context !== undefined) assertEvidenceTimestamp(value.retrievedAt, `${name}.retrievedAt`, context);
  if (!Array.isArray(value.releases)) fail(`${name}.releases must be an array`);
  const exactVersions = new Set();
  const sourceIds = new Set();
  const majors = new Set();
  for (const [index, release] of value.releases.entries()) {
    sourceRelease(release, `${name}.releases[${index}]`);
    if (exactVersions.has(release.exactVersion)) fail(`${name}.releases repeats exact version`);
    exactVersions.add(release.exactVersion);
    majors.add(release.major);
    for (const id of release.sourceReleaseIds) {
      if (sourceIds.has(id)) fail(`${name}.releases repeats source release ID`);
      sourceIds.add(id);
    }
    if (Date.parse(release.releasedAt) > retrieved.instant) fail(`${name}.release is later than retrievedAt`);
  }
  if (majors.size < 3) fail(`${name}.releases needs at least three stable majors`);
  if (JSON.stringify(value.releases) !== JSON.stringify(sortReleases(value.releases))) fail(`${name}.releases are not in canonical order`);
  return value;
}

function sortReleases(records) {
  return [...records].sort((left, right) => {
    const byVersion = compareVersionTuple(right.exactVersion, left.exactVersion);
    if (byVersion !== 0) return byVersion;
    if (left.exactVersion !== right.exactVersion) return left.exactVersion.localeCompare(right.exactVersion);
    return left.releasedAt.localeCompare(right.releasedAt);
  });
}

function normalizeRecords(records, retrievedAt) {
  const seenVersions = new Set();
  const sourceIds = new Set();
  const output = [];
  for (const record of records) {
    const release = {
      sourceReleaseIds: [...record.sourceReleaseIds].sort(),
      exactVersion: record.exactVersion,
      major: versionMajor(record.exactVersion, "release exactVersion"),
      releasedAt: record.releasedAt,
    };
    sourceRelease(release, "normalized release");
    assertReleasedAt(release.releasedAt, retrievedAt, "normalized releasedAt");
    if (seenVersions.has(release.exactVersion)) fail("Vendor adapter produced duplicate exact version");
    seenVersions.add(release.exactVersion);
    for (const id of release.sourceReleaseIds) {
      if (sourceIds.has(id)) fail("Vendor adapter produced duplicate source release ID");
      sourceIds.add(id);
    }
    output.push(release);
  }
  if (new Set(output.map((release) => release.major)).size < 3) fail("Vendor adapter returned fewer than three stable majors");
  return sortReleases(output);
}

export function normalizeChromePayloads(payloads, retrievedAt) {
  if (!Array.isArray(payloads) || payloads.length === 0) fail("Chrome responses are missing");
  const byVersion = new Map();
  const releaseIdentity = new Map();
  for (const payload of payloads) {
    if (!isObject(payload) || Object.keys(payload).some((key) => key !== "releases" && key !== "nextPageToken")) fail("Chrome response has unexpected shape");
    if (!Array.isArray(payload.releases)) fail("Chrome response releases must be an array");
    if (payload.nextPageToken !== undefined && (typeof payload.nextPageToken !== "string" || payload.nextPageToken.length === 0)) fail("Chrome nextPageToken must be nonempty string");
    for (const release of payload.releases) {
      if (!isObject(release)) fail("Chrome release must be object");
      if (release.fraction !== 1) continue;
      const exactVersion = version(release.version, "Chrome release.version");
      const sourceId = string(release.name, "Chrome release.name", true);
      if (!isObject(release.serving)) fail("Chrome release.serving must be object");
      const timestamp = chromeSourceTimestamp(release.serving.startTime, "Chrome release.serving.startTime");
      const existingIdentity = releaseIdentity.get(sourceId);
      if (existingIdentity !== undefined && (existingIdentity.exactVersion !== exactVersion || existingIdentity.sourceInstant !== timestamp.sourceInstant)) {
        fail("Chrome repeated release ID conflicts");
      }
      releaseIdentity.set(sourceId, { exactVersion, sourceInstant: timestamp.sourceInstant });
      const group = byVersion.get(exactVersion) ?? { ids: new Set(), timestamps: [] };
      group.ids.add(sourceId);
      group.timestamps.push(timestamp);
      byVersion.set(exactVersion, group);
    }
  }
  const records = [];
  for (const [exactVersion, group] of byVersion) {
    records.push({
      sourceReleaseIds: [...group.ids],
      exactVersion,
      releasedAt: group.timestamps.reduce((earliest, timestamp) => timestamp.sourceInstant < earliest.sourceInstant ? timestamp : earliest).value,
    });
  }
  return normalizeRecords(records, retrievedAt);
}

export function normalizeEdgePayload(payload, retrievedAt) {
  if (!Array.isArray(payload)) fail("Edge response must be an array");
  const stable = payload.filter((product) => isObject(product) && product.Product === "Stable");
  if (stable.length !== 1) fail("Edge response must contain one Stable product");
  const releases = stable[0].Releases;
  if (!Array.isArray(releases)) fail("Edge stable product releases are missing");
  const records = [];
  for (const release of releases) {
    if (!isObject(release)) fail("Edge release must be object");
    if (release.Platform !== "Windows" || release.Architecture !== "x64") continue;
    const exactVersion = version(release.ProductVersion, "Edge ProductVersion");
    const sourceReleaseId = String(release.ReleaseId);
    if (sourceReleaseId.length === 0 || sourceReleaseId === "undefined" || sourceReleaseId === "null") fail("Edge ReleaseId is missing");
    const published = string(release.PublishedTime, "Edge PublishedTime");
    if (!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(published)) fail("Edge PublishedTime must be timezone-free local timestamp");
    const releasedAt = canonicalTimestamp(`${published}.000Z`, "Edge PublishedTime").value;
    records.push({ sourceReleaseIds: [sourceReleaseId], exactVersion, releasedAt });
  }
  return normalizeRecords(records, retrievedAt);
}

export function normalizeFirefoxPayload(payload, retrievedAt) {
  if (!isObject(payload)) fail("Firefox response must be object");
  const records = [];
  for (const [exactVersion, releasedOn] of Object.entries(payload)) {
    if (!versionPattern.test(exactVersion)) continue;
    if (typeof releasedOn !== "string" || !datePattern.test(releasedOn)) continue;
    const midnight = `${releasedOn}T00:00:00.000Z`;
    try {
      canonicalTimestamp(midnight, "Firefox release date");
    } catch {
      continue;
    }
    records.push({ sourceReleaseIds: [exactVersion], exactVersion, releasedAt: midnight });
  }
  return normalizeRecords(records, retrievedAt);
}

function asciiLower(value) {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function decodeCellText(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "&") {
      output += character;
      continue;
    }
    const semicolon = value.indexOf(";", index + 1);
    if (semicolon < 0) fail("Safari candidate table has unterminated character reference");
    const entity = value.slice(index + 1, semicolon);
    const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    if (Object.hasOwn(named, entity)) {
      output += named[entity];
    } else if (/^#\d+$/u.test(entity) || /^#x[0-9a-fA-F]+$/u.test(entity)) {
      const scalar = Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10);
      if (!Number.isInteger(scalar) || scalar < 0 || scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
        fail("Safari candidate table has invalid numeric character reference");
      }
      output += String.fromCodePoint(scalar);
    } else {
      fail("Safari candidate table has unknown character reference");
    }
    index = semicolon;
  }
  return output;
}

function normalizeSafariCell(value) {
  return value.replace(/[\u0009\u000a\u000c\u000d  ]+/gu, " ").trim();
}

function parseHtmlTag(source, offset) {
  if (source.startsWith("<!--", offset)) {
    const end = source.indexOf("-->", offset + 4);
    if (end < 0) fail("Safari HTML has unterminated comment");
    return { kind: "comment", end: end + 3 };
  }
  if (source.startsWith("<!", offset) || source.startsWith("<?", offset)) {
    const end = source.indexOf(">", offset + 2);
    if (end < 0) fail("Safari HTML has unterminated declaration");
    return { kind: "declaration", end: end + 1 };
  }
  let index = offset + 1;
  let closing = false;
  if (source[index] === "/") {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (/[A-Za-z0-9:-]/u.test(source[index] ?? "")) index += 1;
  if (index === nameStart) fail("Safari HTML has malformed tag name");
  const name = asciiLower(source.slice(nameStart, index));
  let quote = null;
  let selfClosing = false;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "<") fail("Safari HTML has malformed tag");
    if (character === ">") {
      let cursor = index - 1;
      while (cursor >= offset && /[\u0009\u000a\u000c\u000d ]/u.test(source[cursor])) cursor -= 1;
      selfClosing = source[cursor] === "/";
      if (closing && selfClosing) fail("Safari HTML end tag cannot self-close");
      return { kind: "tag", name, closing, selfClosing, end: index + 1 };
    }
  }
  fail("Safari HTML has unterminated tag");
}

function safariTables(html) {
  const stack = [];
  const tables = [];
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let currentTable = null;
  let position = 0;

  function cellText(value) {
    if (currentTable?.cell !== null && currentTable?.cell !== undefined) currentTable.cell.text += decodeCellText(value);
  }

  while (position < html.length) {
    const nextTag = html.indexOf("<", position);
    if (nextTag < 0) {
      cellText(html.slice(position));
      position = html.length;
      break;
    }
    cellText(html.slice(position, nextTag));
    const tag = parseHtmlTag(html, nextTag);
    position = tag.end;
    if (tag.kind !== "tag") continue;
    if (currentTable !== null && ["script", "style", "template"].includes(tag.name)) fail("Safari candidate table contains prohibited element");
    if (!tag.closing) {
      const parent = stack.at(-1);
      if (tag.name === "table") {
        if (currentTable !== null) fail("Safari candidate table contains nested table");
        currentTable = { rows: [], row: null, cell: null, stackDepth: stack.length };
        tables.push(currentTable);
      } else if (tag.name === "tr" && currentTable !== null && (parent?.name === "table" || (parent?.table === currentTable && ["thead", "tbody"].includes(parent.name)))) {
        if (currentTable.row !== null) fail("Safari table has nested row");
        currentTable.row = { cells: [] };
      } else if ((tag.name === "th" || tag.name === "td") && currentTable !== null && parent?.name === "tr" && parent.table === currentTable) {
        if (currentTable.row === null || currentTable.cell !== null) fail("Safari table cell is malformed");
        currentTable.cell = { kind: tag.name, text: "" };
      }
      if (tag.name === "br" && currentTable?.cell !== null && currentTable?.cell !== undefined) currentTable.cell.text += " ";
      if (!voids.has(tag.name) && !tag.selfClosing) stack.push({ name: tag.name, table: currentTable });
      continue;
    }
    const top = stack.pop();
    if (top === undefined || top.name !== tag.name) fail("Safari HTML has malformed or unbalanced tags");
    const table = top.table;
    if (tag.name === "th" || tag.name === "td") {
      if (table !== null && table.cell !== null && table.cell !== undefined && table.cell.kind === tag.name) {
        table.row.cells.push({ kind: table.cell.kind, text: normalizeSafariCell(table.cell.text) });
        table.cell = null;
      }
    } else if (tag.name === "tr") {
      if (table !== null) {
        if (table.cell !== null || table.row === null) fail("Safari table row is malformed");
        table.rows.push(table.row);
        table.row = null;
      }
    } else if (tag.name === "table") {
      if (table !== currentTable || table.row !== null || table.cell !== null) fail("Safari table is malformed");
      currentTable = null;
    }
    continue;
  }
  if (stack.length !== 0 || currentTable !== null) fail("Safari HTML has unbalanced tags");

  for (const table of tables) {
    const originalRows = table.rows;
    table.rows = [];
    for (const row of originalRows) table.rows.push(row);
  }

  return tables;
}

export function normalizeSafariPayload(bytes, retrievedAt) {
  let html;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`Safari response is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidates = safariTables(html).filter((table) => {
    const header = table.rows[0];
    return header !== undefined && header.cells.length === 3 && header.cells.every((cell) => cell.kind === "th") && header.cells.map((cell) => cell.text).join("\u0000") === "Name and information link\u0000Available for\u0000Release date";
  });
  if (candidates.length !== 1) fail("Safari response must contain exactly one normalized release header table");
  const byVersion = new Map();
  for (const row of candidates[0].rows.slice(1)) {
    if (row.cells.length !== 3 || row.cells.some((cell) => cell.kind !== "th" && cell.kind !== "td")) continue;
    const exactVersionMatch = /^Safari ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})$/u.exec(row.cells[0].text);
    if (exactVersionMatch === null) continue;
    const date = row.cells[2].text;
    const dateMatch = /^(0[1-9]|[12]\d|3[01]) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/u.exec(date);
    if (dateMatch === null) fail("Safari release date has invalid format");
    const [, day, month, year] = dateMatch;
    const monthNumber = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month) + 1;
    const releasedAt = `${year}-${String(monthNumber).padStart(2, "0")}-${day}T00:00:00.000Z`;
    try {
      canonicalTimestamp(releasedAt, "Safari release date");
    } catch {
      fail("Safari release date is not Gregorian");
    }
    const exactVersion = exactVersionMatch[1];
    const sourceReleaseId = `safari:${exactVersion}@${releasedAt}`;
    const existing = byVersion.get(exactVersion);
    if (existing !== undefined && existing.releasedAt !== releasedAt) fail("Safari duplicate version has conflicting release date");
    if (existing !== undefined && existing.sourceReleaseIds[0] !== sourceReleaseId) fail("Safari composite source ID conflicts");
    byVersion.set(exactVersion, { sourceReleaseIds: [sourceReleaseId], exactVersion, releasedAt });
  }
  return normalizeRecords([...byVersion.values()], retrievedAt);
}

function bodyHash(bodies) {
  return sha256(Buffer.concat(bodies.flatMap((body, index) => index === 0 ? [body] : [Buffer.from("\n"), body])));
}

async function deadlineOperation(context, action, options = {}) {
  const delay = options.deadlineMilliseconds ?? context.remaining;
  if (delay <= 0) fail("Evidence operation deadline expired");
  const monotonicClock = options.monotonicClock ?? (() => performance.now());
  const expiresAt = monotonicClock() + delay;
  const controller = new AbortController();
  let expired = false;
  const deadlineError = new Error("Evidence operation deadline expired");
  const expire = () => {
    if (expired) return;
    expired = true;
    controller.abort(deadlineError);
  };
  const checkpoint = () => {
    if (expired || controller.signal.aborted || monotonicClock() >= expiresAt) {
      expire();
      throw deadlineError;
    }
  };
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      expire();
      reject(deadlineError);
    }, delay);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => action(controller.signal, checkpoint)),
      timeoutPromise,
    ]);
    checkpoint();
    return result;
  } catch (error) {
    if (expired || error?.name === "AbortError" || error === deadlineError) fail("Evidence operation deadline expired");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchResponse(fetchImpl, url, signal) {
  const response = await fetchImpl(url, { redirect: "error", signal });
  if (!response || response.status !== 200) fail(`Official vendor source did not return HTTP 200: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function acquireVendor(product, context, fetchImpl, signal) {
  const config = sourceConfigurations[product];
  if (product !== "Chrome") {
    const body = await fetchResponse(fetchImpl, config.url, signal);
    const payload = product === "Safari" ? undefined : json(body.toString("utf8"), `${product} response`);
    const releases = product === "Edge"
      ? normalizeEdgePayload(payload, context.commandNow)
      : product === "Firefox"
        ? normalizeFirefoxPayload(payload, context.commandNow)
        : normalizeSafariPayload(body, context.commandNow);
    return { bodies: [body], releases };
  }
  const bodies = [];
  const payloads = [];
  let url = config.url;
  const tokens = new Set();
  while (true) {
    let body;
    let staleTerminalToken = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetchImpl(url, { redirect: "error", signal });
      const result = { status: response?.status, body: response?.status === 200 || response?.status === 400 ? Buffer.from(await response.arrayBuffer()) : undefined };
      if (result.status === 200) {
        body = result.body;
        break;
      }
      let retryable = false;
      try {
        const error = JSON.parse(result.body.toString("utf8"));
        retryable = isObject(error) && Object.keys(error).length === 1 && isObject(error.error) && Object.keys(error.error).length === 3 && error.error.code === 400 && error.error.message === "Request contains an invalid argument." && error.error.status === "INVALID_ARGUMENT";
      } catch {}
      if (url === config.url || result.status !== 400 || !retryable) fail(`Official vendor source did not return HTTP 200: ${url}`);
      if (attempt === 5) {
        const previousPayload = payloads.at(-1);
        if (Array.isArray(previousPayload?.releases) && previousPayload.releases.length < 1000) {
          staleTerminalToken = true;
          break;
        }
        fail(`Official vendor source did not return HTTP 200: ${url}`);
      }
    }
    if (staleTerminalToken) break;
    const payload = json(body.toString("utf8"), "Chrome response");
    bodies.push(body);
    payloads.push(payload);
    if (payload.nextPageToken === undefined) break;
    if (typeof payload.nextPageToken !== "string" || payload.nextPageToken.length === 0 || tokens.has(payload.nextPageToken)) fail("Chrome pagination token is invalid or repeated");
    tokens.add(payload.nextPageToken);
    url = `${config.url}&page_token=${encodeURIComponent(payload.nextPageToken)}`;
  }
  return { bodies, releases: normalizeChromePayloads(payloads, context.commandNow) };
}

function makeSourceArtifact(product, releaseDate, retrievedAt, bodies, releases) {
  const config = sourceConfigurations[product];
  const artifact = {
    schemaVersion: 1,
    releaseDate,
    product,
    channel: "stable",
    source: { id: config.id, url: config.url, responseCount: bodies.length, responseSha256: bodyHash(bodies) },
    retrievedAt,
    releases,
  };
  sourceArtifact(artifact, `${product} source artifact`, product, releaseDate);
  return artifact;
}

export function deriveTargets(artifact, sourceArtifactPath, sourceSha256) {
  sourceArtifact(artifact, "source artifact", artifact.product, artifact.releaseDate);
  if (!hashPattern.test(sourceSha256)) fail("Source artifact hash is invalid");
  const eligible = artifact.releases.filter((release) => Date.parse(release.releasedAt) <= Date.parse(artifact.retrievedAt));
  const majors = [...new Set(eligible.map((release) => release.major))].sort((left, right) => right - left);
  if (majors.length < 2) fail("Source artifact has fewer than two eligible stable majors");
  const choose = (major) => {
    const candidates = eligible.filter((release) => release.major === major);
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
      const tupleOrder = compareVersionTuple(candidate.exactVersion, best.exactVersion);
      if (tupleOrder > 0 || (tupleOrder === 0 && Date.parse(candidate.releasedAt) > Date.parse(best.releasedAt))) best = candidate;
      if (tupleOrder === 0 && Date.parse(candidate.releasedAt) === Date.parse(best.releasedAt) && candidate.exactVersion !== best.exactVersion) {
        fail("Selected vendor version tuple is ambiguous");
      }
    }
    return { major: best.major, exactVersion: best.exactVersion, sourceArtifact: sourceArtifactPath, sourceSha256 };
  };
  return Object.freeze({ current: choose(majors[0]), previous: choose(majors[1]) });
}

function targetEntry(product, slot, derived) {
  return { product, slot, major: derived.major, exactVersion: derived.exactVersion, sourceArtifact: derived.sourceArtifact, sourceSha256: derived.sourceSha256 };
}

export function browserMatrix(value, name, expectedReleaseDate) {
  sameKeys(value, ["schemaVersion", "releaseDate", "targets", "rows", "engineCoverage"], name);
  equal(value.schemaVersion, 4, `${name}.schemaVersion`);
  validateReleaseDate(value.releaseDate);
  if (expectedReleaseDate !== undefined) equal(value.releaseDate, expectedReleaseDate, `${name}.releaseDate`);
  if (!Array.isArray(value.targets) || !Array.isArray(value.rows) || !Array.isArray(value.engineCoverage)) fail(`${name} arrays are invalid`);
  return value;
}

export function matrixTarget(value, name, mapping, derived) {
  sameKeys(value, ["product", "slot", "major", "exactVersion", "sourceArtifact", "sourceSha256"], name);
  equal(value.product, mapping.product, `${name}.product`);
  equal(value.slot, mapping.slot, `${name}.slot`);
  equal(value.major, value.exactVersion === undefined ? NaN : versionMajor(value.exactVersion, `${name}.exactVersion`), `${name}.major`);
  equal(value.sourceArtifact, mapping.sourceArtifact, `${name}.sourceArtifact`);
  if (!hashPattern.test(string(value.sourceSha256, `${name}.sourceSha256`))) fail(`${name}.sourceSha256 must be hash`);
  if (derived !== undefined) {
    equal(value.major, derived.major, `${name}.major`);
    equal(value.exactVersion, derived.exactVersion, `${name}.exactVersion`);
    equal(value.sourceArtifact, derived.sourceArtifact, `${name}.sourceArtifact`);
    equal(value.sourceSha256, derived.sourceSha256, `${name}.sourceSha256`);
  }
  return value;
}

function findMatrixTarget(matrix, mapping) {
  const matching = matrix.targets.filter((entry) => entry.product === mapping.product && entry.slot === mapping.slot);
  if (matching.length !== 1) fail(`Matrix must contain exactly one target for ${mapping.product}/${mapping.slot}`);
  return matching[0];
}

function allMatrixTargets(matrix, derivedByProduct) {
  if (matrix.targets.length !== 8) fail("Matrix must contain exactly eight branded targets");
  for (const mapping of Object.values(browserMappings)) {
    matrixTarget(findMatrixTarget(matrix, mapping), `matrix target ${mapping.product}/${mapping.slot}`, mapping, derivedByProduct[mapping.product][mapping.slot]);
  }
}

function windowsPathKey(value, name) {
  string(value, name, true);
  if (!win32.isAbsolute(value) || win32.parse(value).root.length <= 1) fail(`${name} must be a fully qualified absolute Windows path`);
  return win32.normalize(value).toLowerCase();
}

function binaryProvenance(value, name, product, expectedExecutable, expectedVersion) {
  sameKeys(value, ["extractionMethod", "path", "productName", "productVersion", "authenticodeStatus", "publisher", "bytes", "sha256"], name);
  equal(value.extractionMethod, windowsMetadataExtractionMethod, `${name}.extractionMethod`);
  const pathKey = windowsPathKey(value.path, `${name}.path`);
  if (expectedExecutable !== undefined) equal(pathKey, windowsPathKey(expectedExecutable, "browser executable"), `${name}.path`);
  const identity = windowsBrowserIdentities[product];
  if (identity === undefined) fail(`${name} is only valid for Windows Chrome or Edge`);
  equal(value.productName, identity.productName, `${name}.productName`);
  version(value.productVersion, `${name}.productVersion`);
  if (expectedVersion !== undefined) equal(value.productVersion, expectedVersion, `${name}.productVersion`);
  equal(value.authenticodeStatus, "Valid", `${name}.authenticodeStatus`);
  equal(value.publisher, identity.publisher, `${name}.publisher`);
  safeInteger(value.bytes, `${name}.bytes`, 1);
  if (!hashPattern.test(string(value.sha256, `${name}.sha256`))) fail(`${name}.sha256 must be lowercase SHA-256`);
  return value;
}

export function captureReceipt(value, name, mapping, expectedTarget, context, expectedExecutable) {
  const windowsCapture = Object.hasOwn(windowsBrowserIdentities, mapping.product);
  sameKeys(value, ["schemaVersion", "releaseDate", "product", "slot", "environment", "capturedAt", "target", windowsCapture ? "binaryProvenance" : "rawVersionOutput", "observed"], name);
  equal(value.schemaVersion, windowsCapture ? 2 : 1, `${name}.schemaVersion`);
  tuple(value, name, mapping);
  validateReleaseDate(value.releaseDate);
  if (context !== undefined) {
    equal(value.releaseDate, context.releaseDate, `${name}.releaseDate`);
    assertEvidenceTimestamp(value.capturedAt, `${name}.capturedAt`, context);
  } else canonicalTimestamp(value.capturedAt, `${name}.capturedAt`);
  target(value.target, `${name}.target`, expectedTarget);
  sameKeys(value.observed, ["exactVersion", "major"], `${name}.observed`);
  version(value.observed.exactVersion, `${name}.observed.exactVersion`);
  equal(value.observed.major, versionMajor(value.observed.exactVersion, `${name}.observed.exactVersion`), `${name}.observed.major`);
  if (windowsCapture) {
    binaryProvenance(value.binaryProvenance, `${name}.binaryProvenance`, mapping.product, expectedExecutable, value.observed.exactVersion);
  } else {
    sameKeys(value.rawVersionOutput, ["stdout", "stderr"], `${name}.rawVersionOutput`);
    string(value.rawVersionOutput.stdout, `${name}.rawVersionOutput.stdout`);
    string(value.rawVersionOutput.stderr, `${name}.rawVersionOutput.stderr`);
    const rawVersion = parseVersionOutput(mapping.product, value.rawVersionOutput);
    equal(value.observed.exactVersion, rawVersion, `${name}.observed.exactVersion`);
    equal(value.observed.major, versionMajor(rawVersion, "raw version"), `${name}.observed.major`);
  }
  if (expectedTarget !== undefined) {
    equal(value.observed.exactVersion, expectedTarget.exactVersion, `${name}.observed.exactVersion`);
    equal(value.observed.major, expectedTarget.major, `${name}.observed.major`);
  }
  return value;
}

export function smokeReceipt(value, name, mapping, expectedTarget, expectedCapture, captureHash, context) {
  sameKeys(value, ["schemaVersion", "releaseDate", "product", "slot", "environment", "capturedAt", "testedAt", "captureReceipt", "target", "observed", "tester", "checks"], name);
  equal(value.schemaVersion, 2, `${name}.schemaVersion`);
  tuple(value, name, mapping);
  validateReleaseDate(value.releaseDate);
  if (context !== undefined) {
    equal(value.releaseDate, context.releaseDate, `${name}.releaseDate`);
    assertEvidenceTimestamp(value.capturedAt, `${name}.capturedAt`, context);
    assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context);
  } else {
    canonicalTimestamp(value.capturedAt, `${name}.capturedAt`);
    canonicalTimestamp(value.testedAt, `${name}.testedAt`);
  }
  if (Date.parse(value.testedAt) < Date.parse(value.capturedAt)) fail(`${name}.testedAt is earlier than capturedAt`);
  artifactRef(value.captureReceipt, `${name}.captureReceipt`, mapping.capture);
  if (captureHash !== undefined) equal(value.captureReceipt.sha256, captureHash, `${name}.captureReceipt.sha256`);
  target(value.target, `${name}.target`, expectedTarget);
  sameKeys(value.observed, ["exactVersion", "major"], `${name}.observed`);
  version(value.observed.exactVersion, `${name}.observed.exactVersion`);
  equal(value.observed.major, versionMajor(value.observed.exactVersion, `${name}.observed.exactVersion`), `${name}.observed.major`);
  if (expectedCapture !== undefined) {
    equal(value.capturedAt, expectedCapture.capturedAt, `${name}.capturedAt`);
    sameTarget(value.target, expectedCapture.target, `${name}.target`);
    equal(value.observed.exactVersion, expectedCapture.observed.exactVersion, `${name}.observed.exactVersion`);
    equal(value.observed.major, expectedCapture.observed.major, `${name}.observed.major`);
  }
  string(value.tester, `${name}.tester`, true);
  if (!Array.isArray(value.checks) || value.checks.length !== browserCheckIds.length) fail(`${name}.checks must have six checks`);
  const checkIds = new Set();
  for (const [index, check] of value.checks.entries()) {
    sameKeys(check, ["id", "status", "notes"], `${name}.checks[${index}]`);
    if (!browserCheckIds.includes(check.id) || checkIds.has(check.id)) fail(`${name}.checks must have each check ID exactly once`);
    checkIds.add(check.id);
    if (!["passed", "failed"].includes(check.status)) fail(`${name}.checks status is invalid`);
    string(check.notes, `${name}.checks[${index}].notes`);
  }
  return value;
}

export function unavailableReceipt(value, name, mapping, expectedTarget, context) {
  sameKeys(value, ["schemaVersion", "releaseDate", "product", "slot", "environment", "testedAt", "reporter", "target", "failure", "notes"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  tuple(value, name, mapping);
  equal(value.product, "Safari", `${name}.product`);
  validateReleaseDate(value.releaseDate);
  if (context !== undefined) {
    equal(value.releaseDate, context.releaseDate, `${name}.releaseDate`);
    assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context);
  } else canonicalTimestamp(value.testedAt, `${name}.testedAt`);
  string(value.reporter, `${name}.reporter`, true);
  string(value.notes, `${name}.notes`, true);
  equal(value.failure, "runner-not-provisioned", `${name}.failure`);
  target(value.target, `${name}.target`, expectedTarget);
  return value;
}

function splitNonemptyLines(value) {
  return value.split(/\r\n|\n/gu).map((line) => line.replace(/^[\u0009\u000a\u000c\u000d ]+|[\u0009\u000a\u000c\u000d ]+$/gu, "")).filter((line) => line.length > 0);
}

export function parseVersionOutput(product, raw) {
  sameKeys(raw, ["stdout", "stderr"], "raw version output");
  const patterns = {
    Chrome: /^Google Chrome ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})$/u,
    Edge: /^Microsoft Edge ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})$/u,
    Firefox: /^Mozilla Firefox ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})$/u,
    Safari: /^Included with Safari ((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3})(?: \([^\r\n]*\))?$/u,
  };
  const output = [...splitNonemptyLines(raw.stdout), ...splitNonemptyLines(raw.stderr)];
  if (output.length !== 1) fail(`${product} version output must contain exactly one nonempty line`);
  const match = patterns[product]?.exec(output[0]);
  if (match === null || match === undefined) fail(`${product} version output does not identify exact branded binary`);
  return version(match[1], `${product} observed version`);
}

function rowForPass(mapping, capturePath, captureHash, smokePath, smokeHash, capture, smoke) {
  return {
    product: mapping.product,
    slot: mapping.slot,
    environment: mapping.environment,
    targetMajor: capture.target.major,
    observedVersion: capture.observed.exactVersion,
    mode: "manual-branded",
    status: "passed",
    capturedAt: capture.capturedAt,
    testedAt: smoke.testedAt,
    captureReceipt: { path: capturePath, sha256: captureHash },
    smokeReceipt: { path: smokePath, sha256: smokeHash },
  };
}

function rowForUnavailable(mapping, receiptPath, receiptHash, receipt) {
  return {
    product: mapping.product,
    slot: mapping.slot,
    environment: mapping.environment,
    targetMajor: receipt.target.major,
    observedVersion: null,
    mode: "manual-branded",
    status: "not-available",
    testedAt: receipt.testedAt,
    captureReceipt: null,
    smokeReceipt: null,
    unavailableReceipt: { path: receiptPath, sha256: receiptHash },
  };
}

export function brandedRow(value, name, mapping, expectedTarget, context) {
  if (!isObject(value)) fail(`${name} must be an object`);
  if (value.status === "passed") {
    sameKeys(value, ["product", "slot", "environment", "targetMajor", "observedVersion", "mode", "status", "capturedAt", "testedAt", "captureReceipt", "smokeReceipt"], name);
    tuple(value, name, mapping);
    equal(value.mode, "manual-branded", `${name}.mode`);
    equal(value.status, "passed", `${name}.status`);
    equal(value.targetMajor, expectedTarget.major, `${name}.targetMajor`);
    equal(value.observedVersion, expectedTarget.exactVersion, `${name}.observedVersion`);
    assertEvidenceTimestamp(value.capturedAt, `${name}.capturedAt`, context);
    assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context);
    if (Date.parse(value.testedAt) < Date.parse(value.capturedAt)) fail(`${name}.testedAt is earlier than capturedAt`);
    artifactRef(value.captureReceipt, `${name}.captureReceipt`, mapping.capture);
    artifactRef(value.smokeReceipt, `${name}.smokeReceipt`, mapping.smoke);
    return value;
  }
  if (value.status === "not-available") {
    sameKeys(value, ["product", "slot", "environment", "targetMajor", "observedVersion", "mode", "status", "testedAt", "captureReceipt", "smokeReceipt", "unavailableReceipt"], name);
    tuple(value, name, mapping);
    equal(value.product, "Safari", `${name}.product`);
    equal(value.mode, "manual-branded", `${name}.mode`);
    equal(value.targetMajor, expectedTarget.major, `${name}.targetMajor`);
    equal(value.observedVersion, null, `${name}.observedVersion`);
    assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context);
    equal(value.captureReceipt, null, `${name}.captureReceipt`);
    equal(value.smokeReceipt, null, `${name}.smokeReceipt`);
    artifactRef(value.unavailableReceipt, `${name}.unavailableReceipt`, mapping.unavailable);
    return value;
  }
  fail(`${name}.status is invalid`);
}

export function manualReceipt(value, name, expectedReleaseDate, expectedCategory, context) {
  sameKeys(value, ["schemaVersion", "releaseDate", "category", "status", "testedAt", "tester", "environment", "notes"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  validateReleaseDate(value.releaseDate);
  if (expectedReleaseDate !== undefined) equal(value.releaseDate, expectedReleaseDate, `${name}.releaseDate`);
  if (expectedCategory !== undefined) equal(value.category, expectedCategory, `${name}.category`);
  if (!accessibilityCategories.includes(value.category)) fail(`${name}.category is invalid`);
  if (!["passed", "failed"].includes(value.status)) fail(`${name}.status is invalid`);
  if (context !== undefined) assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context); else canonicalTimestamp(value.testedAt, `${name}.testedAt`);
  string(value.tester, `${name}.tester`, true);
  sameKeys(value.environment, ["os", "osVersion", "browser", "browserVersion", "tool", "toolVersion", "device"], `${name}.environment`);
  for (const [key, environmentValue] of Object.entries(value.environment)) string(environmentValue, `${name}.environment.${key}`, true);
  string(value.notes, `${name}.notes`, true);
  return value;
}

export function accessibilityAggregate(value, name, releaseDate) {
  sameKeys(value, ["schemaVersion", "releaseDate", "rows"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  validateReleaseDate(value.releaseDate);
  if (releaseDate !== undefined) equal(value.releaseDate, releaseDate, `${name}.releaseDate`);
  if (!Array.isArray(value.rows)) fail(`${name}.rows must be an array`);
  const seen = new Set();
  for (const [index, row] of value.rows.entries()) {
    sameKeys(row, ["category", "status", "testedAt", "tester", "environment", "notes", "evidence"], `${name}.rows[${index}]`);
    const { evidence, ...receiptRow } = row;
    const copied = { schemaVersion: 1, releaseDate: value.releaseDate, ...receiptRow };
    manualReceipt(copied, `${name}.rows[${index}]`, value.releaseDate, undefined);
    if (seen.has(row.category)) fail(`${name}.rows duplicates category`);
    seen.add(row.category);
    string(row.evidence, `${name}.rows[${index}].evidence`, true);
  }
  return value;
}

function engineObservation(value, name, releaseDate, project, context, runToken) {
  sameKeys(value, ["releaseDate", "testedAt", "runToken", "project", "exactVersion"], name);
  validateReleaseDate(value.releaseDate);
  if (releaseDate !== undefined) equal(value.releaseDate, releaseDate, `${name}.releaseDate`);
  if (project !== undefined) equal(value.project, project, `${name}.project`);
  if (!Object.hasOwn(engineMappings, value.project)) fail(`${name}.project is invalid`);
  if (context !== undefined) assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context); else canonicalTimestamp(value.testedAt, `${name}.testedAt`);
  if (!hashPattern.test(string(value.runToken, `${name}.runToken`))) fail(`${name}.runToken must be a hexadecimal token`);
  if (runToken !== undefined) equal(value.runToken, runToken, `${name}.runToken`);
  version(value.exactVersion, `${name}.exactVersion`);
  return value;
}

export function engineObservationArtifact(value, name, releaseDate, project, context, runToken) {
  sameKeys(value, ["schemaVersion", "observations"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  if (!Array.isArray(value.observations) || value.observations.length !== 1) fail(`${name}.observations must have exactly one item`);
  engineObservation(value.observations[0], `${name}.observations[0]`, releaseDate, project, context, runToken);
  return value;
}

function flattenReporterSuites(suites, output) {
  if (!Array.isArray(suites)) fail("Engine reporter suites must be array");
  for (const suite of suites) {
    if (!isObject(suite)) fail("Engine reporter suite must be object");
    if (suite.specs !== undefined) {
      if (!Array.isArray(suite.specs)) fail("Engine reporter specs must be array");
      for (const spec of suite.specs) {
        if (!isObject(spec) || !Array.isArray(spec.tests) || typeof spec.file !== "string") fail("Engine reporter spec is malformed");
        for (const test of spec.tests) output.push({ spec, test });
      }
    }
    if (suite.suites !== undefined) flattenReporterSuites(suite.suites, output);
  }
}

export function validateEngineReporter(value, project, releaseDate, testedAt, runToken, repoRoot = root) {
  if (!isObject(value)) fail("Engine reporter must be object");
  if (!isObject(value.config) || !Array.isArray(value.config.projects)) fail("Engine reporter config.projects is missing");
  if (value.config.projects.filter((entry) => isObject(entry) && entry.name === project).length !== 1) fail("Engine reporter has wrong project configuration");
  if (!Array.isArray(value.errors) || value.errors.length !== 0) fail("Engine reporter has errors");
  if (!isObject(value.stats)) fail("Engine reporter stats is missing");
  const flattened = [];
  flattenReporterSuites(value.suites, flattened);
  if (flattened.length === 0) fail("Engine reporter has no tests");
  equal(value.stats.expected, flattened.length, "Engine reporter stats.expected");
  for (const key of ["skipped", "unexpected", "flaky"]) equal(value.stats[key], 0, `Engine reporter stats.${key}`);
  const files = new Set();
  let sentinel = null;
  for (const { spec, test } of flattened) {
    const reportedFile = String(spec.file);
    const file = (isAbsolute(reportedFile) ? relative(repoRoot, reportedFile) : reportedFile).split(sep).join("/");
    if (file.startsWith("../") || !engineSuiteFiles.includes(file)) fail("Engine reporter executed unapproved spec file");
    files.add(file);
    equal(test.projectName, project, "Engine reporter test projectName");
    equal(test.expectedStatus, "passed", "Engine reporter expectedStatus");
    equal(test.status, "expected", "Engine reporter status");
    if (!Array.isArray(test.results) || test.results.length !== 1) fail("Engine reporter test must have one result");
    const result = test.results[0];
    equal(result.retry, 0, "Engine reporter result retry");
    equal(result.status, "passed", "Engine reporter result status");
    if (result.error !== undefined && result.error !== null) fail("Engine reporter result has error");
    if (!Array.isArray(result.errors) || result.errors.length !== 0) fail("Engine reporter result errors must be empty");
    const annotations = Array.isArray(test.annotations) ? test.annotations.filter((annotation) => isObject(annotation) && annotation.type === "cfpb-engine-observation") : [];
    if (spec.title === "records browser.version() for record-engine") {
      if (sentinel !== null) fail("Engine reporter has duplicate sentinel");
      if (annotations.length !== 1) fail("Engine reporter sentinel annotation is missing or duplicate");
      const description = json(string(annotations[0].description, "Engine reporter sentinel annotation"), "Engine reporter sentinel annotation");
      engineObservation(description, "Engine reporter sentinel observation", releaseDate, project, undefined, runToken);
      equal(description.testedAt, testedAt, "Engine reporter sentinel testedAt");
      sentinel = description;
    } else if (annotations.length !== 0) {
      fail("Engine reporter non-sentinel test has engine annotation");
    }
  }
  if (files.size !== engineSuiteFiles.length || engineSuiteFiles.some((file) => !files.has(file))) fail("Engine reporter file set is incomplete");
  if (sentinel === null) fail("Engine reporter sentinel is missing");
  return { flattened, sentinel };
}

export function engineReceipt(value, name, project, releaseDate, context, expectedReportHash, expectedObservationHash) {
  sameKeys(value, ["schemaVersion", "releaseDate", "runToken", "project", "exactVersion", "status", "testedAt", "suite", "reporterArtifact", "observationArtifact"], name);
  equal(value.schemaVersion, 1, `${name}.schemaVersion`);
  equal(value.project, project, `${name}.project`);
  equal(value.releaseDate, releaseDate, `${name}.releaseDate`);
  if (context !== undefined) assertEvidenceTimestamp(value.testedAt, `${name}.testedAt`, context); else canonicalTimestamp(value.testedAt, `${name}.testedAt`);
  if (!hashPattern.test(string(value.runToken, `${name}.runToken`))) fail(`${name}.runToken must be a token`);
  version(value.exactVersion, `${name}.exactVersion`);
  equal(value.status, "passed", `${name}.status`);
  sameKeys(value.suite, ["files", "total", "passed", "skipped", "unexpected", "flaky", "sentinel"], `${name}.suite`);
  if (!Array.isArray(value.suite.files) || value.suite.files.join("\u0000") !== engineSuiteFiles.join("\u0000")) fail(`${name}.suite.files is invalid`);
  safeInteger(value.suite.total, `${name}.suite.total`, 1);
  equal(value.suite.passed, value.suite.total, `${name}.suite.passed`);
  for (const count of ["skipped", "unexpected", "flaky"]) equal(value.suite[count], 0, `${name}.suite.${count}`);
  equal(value.suite.sentinel, "records browser.version() for record-engine", `${name}.suite.sentinel`);
  const mapping = engineMapping(project);
  artifactRef(value.reporterArtifact, `${name}.reporterArtifact`, mapping.report);
  artifactRef(value.observationArtifact, `${name}.observationArtifact`, mapping.observation);
  if (expectedReportHash !== undefined) equal(value.reporterArtifact.sha256, expectedReportHash, `${name}.reporterArtifact.sha256`);
  if (expectedObservationHash !== undefined) equal(value.observationArtifact.sha256, expectedObservationHash, `${name}.observationArtifact.sha256`);
  return value;
}

export function engineMatrixRow(value, name, project, receipt, receiptHash) {
  sameKeys(value, ["runToken", "project", "exactVersion", "status", "testedAt", "suite", "reporterArtifact", "observationArtifact", "receiptArtifact"], name);
  for (const key of ["runToken", "project", "exactVersion", "status", "testedAt", "suite", "reporterArtifact", "observationArtifact"]) {
    if (JSON.stringify(value[key]) !== JSON.stringify(receipt[key])) fail(`${name}.${key} differs from engine receipt`);
  }
  artifactRef(value.receiptArtifact, `${name}.receiptArtifact`, engineMapping(project).receipt);
  equal(value.receiptArtifact.sha256, receiptHash, `${name}.receiptArtifact.sha256`);
  return value;
}

function options(args, permitted) {
  const output = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!permitted.includes(flag) || Object.hasOwn(output, flag)) fail(`Unknown or duplicate option: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Option requires a value: ${flag}`);
    output[flag] = value;
    index += 1;
  }
  for (const flag of permitted) if (flag !== "--executable-env" && output[flag] === undefined) fail(`Missing required option: ${flag}`);
  return output;
}

async function loadSource(repoRoot, product, releaseDate, context, options = {}) {
  const config = sourceConfigurations[product];
  const bytes = await readBytes(repoRoot, config.artifact, options);
  const artifact = sourceArtifact(json(bytes.toString("utf8"), config.artifact), config.artifact, product, releaseDate, context);
  return { artifact, hash: sha256(bytes), bytes };
}

async function loadMatrix(repoRoot, releaseDate, options = {}) {
  return browserMatrix(await readJson(repoRoot, matrixPath, matrixPath, options), matrixPath, releaseDate);
}

async function derivedSources(repoRoot, releaseDate, context) {
  const output = {};
  for (const product of productNames) {
    const source = await loadSource(repoRoot, product, releaseDate, context);
    output[product] = deriveTargets(source.artifact, sourceConfigurations[product].artifact, source.hash);
  }
  return output;
}

function removeCampaignOutputs(repoRoot) {
  const paths = [
    ...Object.values(browserMappings).flatMap((mapping) => [mapping.capture, mapping.smoke, mapping.unavailable].filter(Boolean)),
    ...Object.values(engineMappings).flatMap((mapping) => [mapping.report, mapping.observation, mapping.receipt]),
  ];
  return Promise.all(paths.map((path) => rm(absolute(repoRoot, path), { force: true })));
}

export async function acquireTargets({ repoRoot = root, releaseDate, clock = Date.now, fetchImpl = fetch, deadlineMilliseconds, stageImpl = stage } = {}) {
  const context = captureContext(releaseDate, clock);
  return deadlineOperation(context, async (signal, checkpoint) => {
    const vendors = {};
    for (const product of productNames) vendors[product] = await acquireVendor(product, context, fetchImpl, signal);
    checkpoint();
    const sources = {};
    const sourceStage = [];
    const hashes = {};
    const removeStagedOnAbort = () => {
      for (const { temporary } of sourceStage) rmSync(temporary, { force: true });
    };
    signal.addEventListener("abort", removeStagedOnAbort, { once: true });
    try {
      for (const product of productNames) {
        sources[product] = makeSourceArtifact(product, context.releaseDate, context.commandNow, vendors[product].bodies, vendors[product].releases);
        const body = jsonText(sources[product]);
        hashes[product] = sha256(Buffer.from(body));
        sourceStage.push(await stageImpl(absolute(repoRoot, sourceConfigurations[product].artifact), body, { signal, checkpoint }));
        checkpoint();
      }
      const derived = Object.fromEntries(productNames.map((product) => [product, deriveTargets(sources[product], sourceConfigurations[product].artifact, hashes[product])]));
      const matrix = {
        schemaVersion: 4,
        releaseDate: context.releaseDate,
        targets: Object.values(browserMappings).map((mapping) => targetEntry(mapping.product, mapping.slot, derived[mapping.product][mapping.slot])),
        rows: [],
        engineCoverage: [],
      };
      browserMatrix(matrix, "new browser matrix", context.releaseDate);
      const accessibility = { schemaVersion: 1, releaseDate: context.releaseDate, rows: [] };
      accessibilityAggregate(accessibility, "new accessibility aggregate", context.releaseDate);
      sourceStage.push(await stageImpl(absolute(repoRoot, matrixPath), jsonText(matrix), { signal, checkpoint }));
      checkpoint();
      sourceStage.push(await stageImpl(absolute(repoRoot, accessibilityPath), jsonText(accessibility), { signal, checkpoint }));
      checkpoint();
      await withLock(repoRoot, matrixLockPath, async () => {
        checkpoint();
        for (const staged of sourceStage) {
          checkpoint();
          await rename(staged.temporary, staged.path);
        }
        checkpoint();
        await removeCampaignOutputs(repoRoot);
      });
      checkpoint();
      return matrix;
    } catch (error) {
      await discardStages(sourceStage);
      throw error;
    } finally {
      signal.removeEventListener("abort", removeStagedOnAbort);
    }
  }, { deadlineMilliseconds });
}

function targetForMatrix(matrix, mapping) {
  return findMatrixTarget(matrix, mapping);
}

function assertMatrixTargetAgainstSource(matrixTargetValue, mapping, sourceDerived) {
  matrixTarget(matrixTargetValue, "matrix target", mapping, sourceDerived[mapping.slot]);
  return matrixTargetValue;
}

async function spawnOutput(executable, args, context, spawnImpl = spawn, options = {}) {
  const run = (signal) => new Promise((resolvePromise, reject) => {
    signal.throwIfAborted();
    let child;
    try {
      child = spawnImpl(executable, args, {
        shell: false,
        signal,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.windowsHide === true ? { windowsHide: true } : {}),
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`${options.failureLabel ?? "Branded browser version command"} failed: ${code}`));
      else resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (options.stdin !== undefined) {
      try {
        if (typeof child.stdin?.end !== "function") fail("Metadata command stdin is unavailable");
        child.stdin.end(options.stdin);
      } catch (error) {
        reject(error);
      }
    }
  });
  return options.signal === undefined
    ? deadlineOperation(context, run, { deadlineMilliseconds: options.deadlineMilliseconds })
    : run(options.signal);
}

function fatalUtf8(bytes, name) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${name} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function windowsPowerShellExecutable() {
  if (process.platform !== "win32") return "powershell.exe";
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  string(systemRoot, "Windows system root", true);
  return resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function captureWindowsBinaryProvenance(product, executable, context, spawnImpl, signal) {
  windowsPathKey(executable, "browser executable");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    if (normalized === windowsMetadataPathEnvironment.toLowerCase() || normalized === "psmodulepath") delete environment[key];
  }
  environment[windowsMetadataPathEnvironment] = executable;
  const raw = await spawnOutput(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    context,
    spawnImpl,
    { env: environment, stdin: `${windowsMetadataScript}\n`, windowsHide: true, failureLabel: "Windows browser metadata command", signal },
  );
  const stdout = fatalUtf8(raw.stdout, "Windows metadata stdout");
  const stderr = fatalUtf8(raw.stderr, "Windows metadata stderr");
  if (splitNonemptyLines(stderr).length !== 0) fail("Windows metadata command wrote stderr");
  const lines = splitNonemptyLines(stdout);
  if (lines.length !== 1) fail("Windows metadata command must return exactly one JSON line");
  const metadata = json(lines[0], "Windows metadata command output");
  sameKeys(metadata, ["path", "productName", "productVersion", "authenticodeStatus", "publisher", "bytes", "sha256"], "Windows metadata command output");
  const provenance = { extractionMethod: windowsMetadataExtractionMethod, ...metadata };
  return binaryProvenance(provenance, "Windows binary provenance", product, executable);
}

async function launchDetached(executable, args, signal, spawnImpl = spawn) {
  await new Promise((resolvePromise, reject) => {
    signal.throwIfAborted();
    let child;
    try {
      child = spawnImpl(executable, args, { shell: false, detached: true, stdio: "ignore", signal });
    } catch (error) {
      reject(error);
      return;
    }
    if (typeof child.once !== "function") {
      child.unref?.();
      resolvePromise();
      return;
    }
    let settled = false;
    let graceTimer;
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else {
        child.unref?.();
        resolvePromise();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", finish);
    child.once("close", (code) => finish(new Error(`Branded browser exited before launch settled: ${code}`)));
    child.once("spawn", () => {
      graceTimer = setTimeout(() => finish(), 1_000);
    });
  });
}

async function captureBrowserForPlatform(options = {}) {
  const repoRoot = options.repoRoot ?? root;
  const mapping = mappingFor(options.product, options.slot, options.environment);
  return withLock(repoRoot, `${mapping.capture}.lock`, () => captureBrowserLocked(options));
}

async function captureBrowserLocked({ repoRoot = root, releaseDate, product, slot, environment, executableEnv, clock = Date.now, spawnImpl = spawn, deadlineMilliseconds, platform, profileRoot = resolve(tmpdir(), "cfpb-browser-evidence"), readFileImpl = readFile, writeReceiptImpl = writeAtomic } = {}) {
  const context = captureContext(releaseDate, clock);
  const mapping = mappingFor(product, slot, environment);
  if (product === "Safari") fail("Use capture-safari for Safari");
  if (platform !== "win32") fail(`${product} capture requires win32`);
  string(executableEnv, "executable environment variable", true);
  const executable = process.env[executableEnv];
  string(executable, `${executableEnv}`, true);
  const path = absolute(repoRoot, mapping.capture);
  let committed = false;
  try {
    const result = await deadlineOperation(context, async (signal, checkpoint) => {
      const operation = { signal, checkpoint, readFileImpl };
      const matrix = await loadMatrix(repoRoot, context.releaseDate, operation);
      const source = await loadSource(repoRoot, product, context.releaseDate, context, operation);
      const derived = deriveTargets(source.artifact, mapping.sourceArtifact, source.hash);
      const targetValue = targetForMatrix(matrix, mapping);
      assertMatrixTargetAgainstSource(targetValue, mapping, derived);
      for (const output of [mapping.capture, mapping.smoke, mapping.unavailable].filter(Boolean)) if (existsSync(absolute(repoRoot, output))) fail("Mapped branded output already exists");
      const windowsCapture = Object.hasOwn(windowsBrowserIdentities, product);
      let rawVersionOutput;
      let binaryProvenanceValue;
      let observedVersion;
      if (windowsCapture) {
        binaryProvenanceValue = await captureWindowsBinaryProvenance(product, executable, context, spawnImpl, signal);
        checkpoint();
        observedVersion = binaryProvenanceValue.productVersion;
      } else {
        const raw = await spawnOutput(executable, ["--version"], context, spawnImpl, { signal });
        checkpoint();
        rawVersionOutput = { stdout: fatalUtf8(raw.stdout, "version stdout"), stderr: fatalUtf8(raw.stderr, "version stderr") };
        observedVersion = parseVersionOutput(product, rawVersionOutput);
      }
      equal(observedVersion, targetValue.exactVersion, "observed branded version");
      const receipt = {
        schemaVersion: windowsCapture ? 2 : 1,
        releaseDate: context.releaseDate,
        product,
        slot,
        environment: mapping.environment,
        capturedAt: context.commandNow,
        target: { sourceArtifact: targetValue.sourceArtifact, sourceSha256: targetValue.sourceSha256, exactVersion: targetValue.exactVersion, major: targetValue.major },
        ...(windowsCapture ? { binaryProvenance: binaryProvenanceValue } : { rawVersionOutput }),
        observed: { exactVersion: observedVersion, major: versionMajor(observedVersion, "observed branded version") },
      };
      captureReceipt(receipt, "new branded capture", mapping, targetValue, context, windowsCapture ? executable : undefined);
      const profilePath = resolve(profileRoot, mapping.environment, windowsCapture ? binaryProvenanceValue.sha256 : observedVersion);
      await mkdir(dirname(profilePath), { recursive: true });
      const launchArgs = windowsCapture
        ? [`--user-data-dir=${profilePath}`, "--no-first-run", "--no-default-browser-check", "http://127.0.0.1:8787/"]
        : ["-wait-for-browser", "-no-remote", "-profile", profilePath, "http://127.0.0.1:8787/"];
      await launchDetached(executable, launchArgs, signal, spawnImpl);
      checkpoint();
      const bytes = Buffer.from(jsonText(receipt));
      await writeReceiptImpl(path, bytes, { signal, checkpoint });
      committed = true;
      checkpoint();
      return { receipt, hash: sha256(bytes) };
    }, { deadlineMilliseconds });
    process.stdout.write(`${mapping.capture} ${result.hash}\n`);
    return result.receipt;
  } catch (error) {
    if (committed) await rm(path, { force: true });
    throw error;
  }
}

export async function captureBrowser(options = {}) {
  return captureBrowserForPlatform({ ...options, platform: process.platform });
}

async function captureSafariForPlatform(options = {}) {
  const repoRoot = options.repoRoot ?? root;
  const mapping = mappingFor("Safari", options.slot, options.environment);
  return withLock(repoRoot, `${mapping.capture}.lock`, () => captureSafariLocked(options));
}

async function captureSafariLocked({ repoRoot = root, releaseDate, slot, environment, clock = Date.now, spawnImpl = spawn, deadlineMilliseconds, platform, readFileImpl = readFile, writeReceiptImpl = writeAtomic } = {}) {
  const context = captureContext(releaseDate, clock);
  const mapping = mappingFor("Safari", slot, environment);
  if (platform !== "darwin") fail("Safari capture requires darwin");
  const path = absolute(repoRoot, mapping.capture);
  let committed = false;
  try {
    const result = await deadlineOperation(context, async (signal, checkpoint) => {
      const operation = { signal, checkpoint, readFileImpl };
      const matrix = await loadMatrix(repoRoot, context.releaseDate, operation);
      const source = await loadSource(repoRoot, "Safari", context.releaseDate, context, operation);
      const derived = deriveTargets(source.artifact, mapping.sourceArtifact, source.hash);
      const targetValue = targetForMatrix(matrix, mapping);
      assertMatrixTargetAgainstSource(targetValue, mapping, derived);
      for (const output of [mapping.capture, mapping.smoke, mapping.unavailable].filter(Boolean)) if (existsSync(absolute(repoRoot, output))) fail("Mapped Safari output already exists");
      const raw = await spawnOutput("/usr/bin/safaridriver", ["--version"], context, spawnImpl, { signal });
      checkpoint();
      const rawVersionOutput = { stdout: fatalUtf8(raw.stdout, "Safari version stdout"), stderr: fatalUtf8(raw.stderr, "Safari version stderr") };
      const observedVersion = parseVersionOutput("Safari", rawVersionOutput);
      equal(observedVersion, targetValue.exactVersion, "observed Safari version");
      const receipt = {
        schemaVersion: 1,
        releaseDate: context.releaseDate,
        product: "Safari",
        slot,
        environment: mapping.environment,
        capturedAt: context.commandNow,
        target: { sourceArtifact: targetValue.sourceArtifact, sourceSha256: targetValue.sourceSha256, exactVersion: targetValue.exactVersion, major: targetValue.major },
        rawVersionOutput,
        observed: { exactVersion: observedVersion, major: versionMajor(observedVersion, "observed Safari version") },
      };
      captureReceipt(receipt, "new Safari capture", mapping, targetValue, context);
      await spawnOutput("/usr/bin/open", ["-a", "Safari", "http://127.0.0.1:8787/"], context, spawnImpl, { signal, failureLabel: "Safari launcher command" });
      checkpoint();
      const bytes = Buffer.from(jsonText(receipt));
      await writeReceiptImpl(path, bytes, { signal, checkpoint });
      committed = true;
      checkpoint();
      return { receipt, hash: sha256(bytes) };
    }, { deadlineMilliseconds });
    process.stdout.write(`${mapping.capture} ${result.hash}\n`);
    return result.receipt;
  } catch (error) {
    if (committed) await rm(path, { force: true });
    throw error;
  }
}

export async function captureSafari(options = {}) {
  return captureSafariForPlatform({ ...options, platform: process.platform });
}

export async function recordPass({ repoRoot = root, releaseDate, product, slot, environment, evidence, clock = Date.now } = {}) {
  const context = captureContext(releaseDate, clock);
  const mapping = mappingFor(product, slot, environment);
  equal(evidence, mapping.smoke, "smoke evidence path");
  return withLock(repoRoot, matrixLockPath, async () => {
    const matrix = await loadMatrix(repoRoot, context.releaseDate);
    const source = await loadSource(repoRoot, product, context.releaseDate, context);
    const derived = deriveTargets(source.artifact, mapping.sourceArtifact, source.hash);
    const targetValue = targetForMatrix(matrix, mapping);
    assertMatrixTargetAgainstSource(targetValue, mapping, derived);
    if (matrix.rows.some((row) => row.product === product && row.slot === slot)) fail("Matrix branded row is immutable");
    const captureBytes = await readBytes(repoRoot, mapping.capture);
    const capture = captureReceipt(json(captureBytes.toString("utf8"), mapping.capture), mapping.capture, mapping, targetValue, context);
    const smokeBytes = await readBytes(repoRoot, mapping.smoke);
    const smoke = smokeReceipt(json(smokeBytes.toString("utf8"), mapping.smoke), mapping.smoke, mapping, targetValue, capture, sha256(captureBytes), context);
    if (smoke.checks.some((check) => check.status !== "passed")) fail("Manual branded smoke has failed check");
    const row = rowForPass(mapping, mapping.capture, sha256(captureBytes), mapping.smoke, sha256(smokeBytes), capture, smoke);
    brandedRow(row, "new branded row", mapping, targetValue, context);
    matrix.rows.push(row);
    await writeAtomic(absolute(repoRoot, matrixPath), jsonText(matrix));
    return row;
  });
}

export async function recordSafariUnavailable({ repoRoot = root, releaseDate, slot, environment, evidence, clock = Date.now } = {}) {
  const context = captureContext(releaseDate, clock);
  const mapping = mappingFor("Safari", slot, environment);
  equal(evidence, mapping.unavailable, "Safari unavailable evidence path");
  return withLock(repoRoot, matrixLockPath, async () => {
    const matrix = await loadMatrix(repoRoot, context.releaseDate);
    const source = await loadSource(repoRoot, "Safari", context.releaseDate, context);
    const derived = deriveTargets(source.artifact, mapping.sourceArtifact, source.hash);
    const targetValue = targetForMatrix(matrix, mapping);
    assertMatrixTargetAgainstSource(targetValue, mapping, derived);
    if (matrix.rows.some((row) => row.product === "Safari" && row.slot === slot)) fail("Matrix Safari row is immutable");
    for (const path of [mapping.capture, mapping.smoke]) if (existsSync(absolute(repoRoot, path))) fail("Safari unavailable cannot coexist with capture or smoke receipt");
    const bytes = await readBytes(repoRoot, mapping.unavailable);
    const receipt = unavailableReceipt(json(bytes.toString("utf8"), mapping.unavailable), mapping.unavailable, mapping, targetValue, context);
    const row = rowForUnavailable(mapping, mapping.unavailable, sha256(bytes), receipt);
    brandedRow(row, "new Safari unavailable row", mapping, targetValue, context);
    matrix.rows.push(row);
    await writeAtomic(absolute(repoRoot, matrixPath), jsonText(matrix));
    return row;
  });
}

async function spawnEngine(repoRoot, project, context, runToken, spawnImpl = spawn) {
  const mapping = engineMapping(project);
  const report = absolute(repoRoot, mapping.report);
  const observation = absolute(repoRoot, mapping.observation);
  await mkdir(dirname(report), { recursive: true });
  await rm(report, { force: true });
  await rm(observation, { force: true });
  const values = {
    PLAYWRIGHT_JSON_OUTPUT_FILE: report,
    CFPB_ENGINE_OBSERVATION_PATH: observation,
    CFPB_ENGINE_RUN_TOKEN: runToken,
    CFPB_ENGINE_PROJECT: project,
    CFPB_RELEASE_DATE: context.releaseDate,
    CFPB_ENGINE_TESTED_AT: context.commandNow,
  };
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "PLAYWRIGHT_JSON_OUTPUT_FILE" || key === "CFPB_RELEASE_DATE" || key.startsWith("CFPB_ENGINE_")) delete environment[key];
  }
  Object.assign(environment, values);
  const args = [
    resolve(repoRoot, "node_modules/@playwright/test/cli.js"), "test",
    ...engineSuiteFiles,
    `--project=${project}`, "--reporter=json", "--workers=1", "--retries=0",
  ];
  await deadlineOperation(context, (signal) => new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawnImpl(process.execPath, args, { shell: false, signal, cwd: repoRoot, stdio: "inherit", env: environment });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`Engine Playwright process failed: ${code}`)));
  }));
  return { report, observation };
}

export async function recordEngine({ repoRoot = root, releaseDate, project, clock = Date.now, spawnImpl = spawn } = {}) {
  const context = captureContext(releaseDate, clock);
  const mapping = engineMapping(project);
  return withLock(repoRoot, matrixLockPath, async () => {
    const matrix = await loadMatrix(repoRoot, context.releaseDate);
    if (matrix.engineCoverage.some((row) => row.project === project) || existsSync(absolute(repoRoot, mapping.receipt))) fail("Engine receipt or matrix row is immutable");
    const runToken = randomBytes(32).toString("hex");
    const { report, observation } = await spawnEngine(repoRoot, project, context, runToken, spawnImpl);
    if (!existsSync(report) || !existsSync(observation)) fail("Engine run did not produce both fresh required artifacts");
    const reportBytes = await readFile(report);
    const observationBytes = await readFile(observation);
    const reportValue = json(reportBytes.toString("utf8"), mapping.report);
    const reporter = validateEngineReporter(reportValue, project, context.releaseDate, context.commandNow, runToken, repoRoot);
    const observationValue = engineObservationArtifact(json(observationBytes.toString("utf8"), mapping.observation), mapping.observation, context.releaseDate, project, context, runToken);
    const observationValueOne = observationValue.observations[0];
    if (JSON.stringify(reporter.sentinel) !== JSON.stringify(observationValueOne)) fail("Engine reporter annotation differs from observation artifact");
    const reportHash = sha256(reportBytes);
    const observationHash = sha256(observationBytes);
    const receipt = {
      schemaVersion: 1,
      releaseDate: context.releaseDate,
      runToken,
      project,
      exactVersion: observationValueOne.exactVersion,
      status: "passed",
      testedAt: context.commandNow,
      suite: { files: [...engineSuiteFiles], total: reporter.flattened.length, passed: reporter.flattened.length, skipped: 0, unexpected: 0, flaky: 0, sentinel: "records browser.version() for record-engine" },
      reporterArtifact: { path: mapping.report, sha256: reportHash },
      observationArtifact: { path: mapping.observation, sha256: observationHash },
    };
    engineReceipt(receipt, "new engine receipt", project, context.releaseDate, context, reportHash, observationHash);
    const receiptBytes = Buffer.from(jsonText(receipt));
    const receiptHash = sha256(receiptBytes);
    const row = { ...receipt };
    delete row.schemaVersion;
    delete row.releaseDate;
    row.receiptArtifact = { path: mapping.receipt, sha256: receiptHash };
    engineMatrixRow(row, "new engine matrix row", project, receipt, receiptHash);
    matrix.engineCoverage.push(row);
    const stagedReceipt = await stage(absolute(repoRoot, mapping.receipt), receiptBytes);
    const stagedMatrix = await stage(absolute(repoRoot, matrixPath), jsonText(matrix));
    try {
      await rename(stagedReceipt.temporary, stagedReceipt.path);
      try {
        await rename(stagedMatrix.temporary, stagedMatrix.path);
      } catch (error) {
        await rm(stagedReceipt.path, { force: true });
        throw error;
      }
    } finally {
      await discardStages([stagedReceipt, stagedMatrix]);
    }
    return row;
  });
}

export async function recordAccessibility({ repoRoot = root, releaseDate, category, evidence, clock = Date.now } = {}) {
  const context = captureContext(releaseDate, clock);
  if (!accessibilityCategories.includes(category)) fail("Unknown manual accessibility category");
  const absoluteEvidence = absolute(repoRoot, evidence);
  if (!evidence.startsWith("test/e2e/evidence/accessibility/") || !existsSync(absoluteEvidence)) fail("Manual accessibility evidence must be an existing in-tree accessibility receipt");
  return withLock(repoRoot, accessibilityLockPath, async () => {
    const aggregate = accessibilityAggregate(await readJson(repoRoot, accessibilityPath), accessibilityPath, context.releaseDate);
    const receipt = manualReceipt(await readJson(repoRoot, evidence), evidence, context.releaseDate, category, context);
    const row = { ...receipt, evidence };
    delete row.schemaVersion;
    delete row.releaseDate;
    aggregate.rows = aggregate.rows.filter((entry) => entry.category !== category);
    aggregate.rows.push(row);
    aggregate.rows.sort((left, right) => accessibilityCategories.indexOf(left.category) - accessibilityCategories.indexOf(right.category));
    accessibilityAggregate(aggregate, "updated accessibility aggregate", context.releaseDate);
    await writeAtomic(absolute(repoRoot, accessibilityPath), jsonText(aggregate));
    return row;
  });
}

function syntheticSource(product, releaseDate, retrievedAt) {
  const config = sourceConfigurations[product];
  const releases = [120, 117, 111].map((major, index) => ({
    sourceReleaseIds: [`${product.toLowerCase()}-${major}`],
    exactVersion: `${major}.${index + 1}.0`,
    major,
    releasedAt: `${releaseDate}T0${index + 1}:00:00.000Z`,
  }));
  const body = Buffer.from(`${product}-fixture`);
  return makeSourceArtifact(product, releaseDate, retrievedAt, [body], releases);
}

function syntheticRawVersion(product, exactVersion) {
  const lines = { Chrome: `Google Chrome ${exactVersion}\n`, Edge: `Microsoft Edge ${exactVersion}\n`, Firefox: `Mozilla Firefox ${exactVersion}\n`, Safari: `Included with Safari ${exactVersion}\n` };
  return { stdout: lines[product], stderr: "" };
}

function syntheticBinaryProvenance(mapping, exactVersion) {
  const identity = windowsBrowserIdentities[mapping.product];
  const executableName = mapping.product === "Chrome" ? "chrome.exe" : "msedge.exe";
  return {
    extractionMethod: windowsMetadataExtractionMethod,
    path: `C:\\Synthetic Browsers\\${mapping.product}\\${mapping.slot}\\${executableName}`,
    productName: identity.productName,
    productVersion: exactVersion,
    authenticodeStatus: "Valid",
    publisher: identity.publisher,
    bytes: 1_000_000 + mapping.environment.length,
    sha256: sha256(Buffer.from(`${mapping.product}/${mapping.slot}/${exactVersion}`)),
  };
}

function syntheticReporter(project, observation) {
  const specs = engineSuiteFiles.map((file, index) => ({
    file,
    title: index === engineSuiteFiles.length - 1 ? "records browser.version() for record-engine" : `fixture ${index}`,
    tests: [{
      projectName: project,
      expectedStatus: "passed",
      status: "expected",
      results: [{ retry: 0, status: "passed", errors: [] }],
      annotations: index === engineSuiteFiles.length - 1 ? [{ type: "cfpb-engine-observation", description: JSON.stringify(observation) }] : [],
    }],
  }));
  return { config: { projects: [{ name: project }] }, errors: [], stats: { expected: specs.length, skipped: 0, unexpected: 0, flaky: 0 }, suites: [{ specs }] };
}

export async function createSyntheticCampaign(repoRoot, releaseDate = "2026-09-13", commandNow = "2026-09-13T12:00:00.000Z") {
  const context = contextFor(releaseDate, commandNow);
  const sources = {};
  const sourceHashes = {};
  for (const product of productNames) {
    sources[product] = syntheticSource(product, releaseDate, commandNow);
    const bytes = Buffer.from(jsonText(sources[product]));
    sourceHashes[product] = sha256(bytes);
    await writeAtomic(absolute(repoRoot, sourceConfigurations[product].artifact), bytes);
  }
  const derived = Object.fromEntries(productNames.map((product) => [product, deriveTargets(sources[product], sourceConfigurations[product].artifact, sourceHashes[product])]));
  const matrix = {
    schemaVersion: 4,
    releaseDate,
    targets: Object.values(browserMappings).map((mapping) => targetEntry(mapping.product, mapping.slot, derived[mapping.product][mapping.slot])),
    rows: [],
    engineCoverage: [],
  };
  for (const mapping of Object.values(browserMappings)) {
    const targetValue = findMatrixTarget(matrix, mapping);
    const windowsCapture = Object.hasOwn(windowsBrowserIdentities, mapping.product);
    const capture = {
      schemaVersion: windowsCapture ? 2 : 1, releaseDate, product: mapping.product, slot: mapping.slot, environment: mapping.environment, capturedAt: commandNow,
      target: { sourceArtifact: targetValue.sourceArtifact, sourceSha256: targetValue.sourceSha256, exactVersion: targetValue.exactVersion, major: targetValue.major },
      ...(windowsCapture ? { binaryProvenance: syntheticBinaryProvenance(mapping, targetValue.exactVersion) } : { rawVersionOutput: syntheticRawVersion(mapping.product, targetValue.exactVersion) }),
      observed: { exactVersion: targetValue.exactVersion, major: targetValue.major },
    };
    captureReceipt(capture, "synthetic capture", mapping, targetValue, context);
    const captureBytes = Buffer.from(jsonText(capture));
    await writeAtomic(absolute(repoRoot, mapping.capture), captureBytes);
    const checks = browserCheckIds.map((id) => ({ id, status: "passed", notes: "fixture" }));
    const smoke = {
      schemaVersion: 2, releaseDate, product: mapping.product, slot: mapping.slot, environment: mapping.environment, capturedAt: commandNow, testedAt: commandNow,
      captureReceipt: { path: mapping.capture, sha256: sha256(captureBytes) },
      target: capture.target, observed: capture.observed, tester: "fixture", checks,
    };
    const smokeBytes = Buffer.from(jsonText(smoke));
    await writeAtomic(absolute(repoRoot, mapping.smoke), smokeBytes);
    matrix.rows.push(rowForPass(mapping, mapping.capture, sha256(captureBytes), mapping.smoke, sha256(smokeBytes), capture, smoke));
  }
  for (const project of Object.keys(engineMappings)) {
    const mapping = engineMapping(project);
    const runToken = "a".repeat(64);
    const observation = { releaseDate, testedAt: commandNow, runToken, project, exactVersion: "120.1.0" };
    const reportBytes = Buffer.from(jsonText(syntheticReporter(project, observation)));
    const observationBytes = Buffer.from(jsonText({ schemaVersion: 1, observations: [observation] }));
    await writeAtomic(absolute(repoRoot, mapping.report), reportBytes);
    await writeAtomic(absolute(repoRoot, mapping.observation), observationBytes);
    const receipt = {
      schemaVersion: 1, releaseDate, runToken, project, exactVersion: observation.exactVersion, status: "passed", testedAt: commandNow,
      suite: { files: [...engineSuiteFiles], total: 5, passed: 5, skipped: 0, unexpected: 0, flaky: 0, sentinel: "records browser.version() for record-engine" },
      reporterArtifact: { path: mapping.report, sha256: sha256(reportBytes) }, observationArtifact: { path: mapping.observation, sha256: sha256(observationBytes) },
    };
    const receiptBytes = Buffer.from(jsonText(receipt));
    await writeAtomic(absolute(repoRoot, mapping.receipt), receiptBytes);
    const row = { ...receipt };
    delete row.schemaVersion;
    delete row.releaseDate;
    row.receiptArtifact = { path: mapping.receipt, sha256: sha256(receiptBytes) };
    matrix.engineCoverage.push(row);
  }
  await writeAtomic(absolute(repoRoot, matrixPath), jsonText(matrix));
  const aggregate = { schemaVersion: 1, releaseDate, rows: [] };
  for (const category of accessibilityCategories) {
    const evidence = `test/e2e/evidence/accessibility/${category}.json`;
    const receipt = {
      schemaVersion: 1, releaseDate, category, status: "passed", testedAt: commandNow, tester: "fixture",
      environment: { os: "fixture", osVersion: "1", browser: "fixture", browserVersion: "1", tool: "fixture", toolVersion: "1", device: "fixture" }, notes: "fixture",
    };
    await writeAtomic(absolute(repoRoot, evidence), jsonText(receipt));
    const row = { ...receipt, evidence };
    delete row.schemaVersion;
    delete row.releaseDate;
    aggregate.rows.push(row);
  }
  await writeAtomic(absolute(repoRoot, accessibilityPath), jsonText(aggregate));
  return { context, matrix, derived };
}

async function expectThrows(action, name) {
  try {
    await action();
  } catch {
    return;
  }
  fail(`Self-test expected rejection: ${name}`);
}

async function expectThrowsMessage(action, expected, name) {
  try {
    await action();
  } catch (error) {
    equal(error instanceof Error ? error.message : String(error), expected, name);
    return;
  }
  fail(`Self-test expected rejection: ${name}`);
}

function engineChildStub(mode) {
  return (_executable, args, options) => {
    if (!args.includes("--workers=1") || !args.includes("--retries=0")) fail("Engine producer did not pin one worker and zero retries");
    const child = new EventEmitter();
    queueMicrotask(async () => {
      try {
        if (mode !== "missing") {
          const observation = {
            releaseDate: options.env.CFPB_RELEASE_DATE,
            testedAt: options.env.CFPB_ENGINE_TESTED_AT,
            runToken: options.env.CFPB_ENGINE_RUN_TOKEN,
            project: options.env.CFPB_ENGINE_PROJECT,
            exactVersion: mode === "version-mismatch" ? "121.0" : "120.1.0",
          };
          const reporterObservation = mode === "token-mismatch" ? { ...observation, runToken: `b${observation.runToken.slice(1)}` } : observation;
          const report = syntheticReporter(observation.project, reporterObservation);
          if (mode === "failed-report") {
            report.suites[0].specs[0].tests[0].results[0].status = "failed";
            report.stats.unexpected = 1;
          }
          await writeFile(options.env.PLAYWRIGHT_JSON_OUTPUT_FILE, jsonText(report), "utf8");
          await writeFile(options.env.CFPB_ENGINE_OBSERVATION_PATH, jsonText({ schemaVersion: 1, observations: [observation] }), "utf8");
        }
        child.emit("close", 0);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
}

function windowsMetadataFixture(fixture, productVersion) {
  return {
    path: fixture.executable,
    productName: fixture.productName,
    productVersion,
    authenticodeStatus: "Valid",
    publisher: fixture.publisher,
    bytes: fixture.bytes,
    sha256: fixture.sha256,
  };
}

const expectedWindowsMetadataScript = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  `$LiteralPath = [Environment]::GetEnvironmentVariable('${windowsMetadataPathEnvironment}')`,
  "if ([string]::IsNullOrWhiteSpace($LiteralPath)) { throw 'Browser executable path is missing' }",
  "$file = Get-Item -LiteralPath $LiteralPath",
  "if ($file.PSIsContainer) { throw 'Browser executable path is not a file' }",
  "$signature = Get-AuthenticodeSignature -LiteralPath $LiteralPath",
  "$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($file.FullName)",
  "[PSCustomObject]@{ path = $file.FullName; productName = $version.ProductName; productVersion = $version.ProductVersion; authenticodeStatus = [string]$signature.Status; publisher = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }; bytes = [long]$file.Length; sha256 = (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress",
].join("; ");

function windowsCaptureChildStub({ executable, environment, metadata, profileRoot, metadataExitCode = 0, metadataDelayMilliseconds = 0, launchError = null, launchExitCode = null, launchExitDelayMilliseconds = 0 }) {
  let calls = 0;
  let unrefs = 0;
  let metadataSignal;
  let launchSignal;
  const expectedMetadataArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"];
  const expectedLaunchArgs = [
    `--user-data-dir=${resolve(profileRoot, environment, metadata?.sha256 ?? "missing")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "http://127.0.0.1:8787/",
  ];
  const spawnStub = (command, args, options) => {
    calls += 1;
    if (calls === 1) {
      if (!/(?:^|[\\/])powershell\.exe$/iu.test(command)) fail("Windows branded capture did not query PE metadata with Windows PowerShell");
      if (JSON.stringify(args) !== JSON.stringify(expectedMetadataArgs)) fail("Windows metadata command arguments are not fixed");
      if (options.shell !== false || options.windowsHide !== true || options.signal === undefined) fail("Windows metadata command spawn options are invalid");
      metadataSignal = options.signal;
      equal(options.env.CFPB_BROWSER_EXECUTABLE_LITERAL, executable, "Windows metadata literal path environment");
      if (Object.keys(options.env).some((key) => key.toLowerCase() === "psmodulepath")) fail("Windows metadata command inherited PSModulePath");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        end(script) {
          if (typeof script !== "string" || script.includes(executable)) fail("Windows metadata command interpolated the executable path");
          equal(script, `${expectedWindowsMetadataScript}\n`, "Windows metadata stdin script");
          const complete = () => {
            if (metadata !== undefined) child.stdout.emit("data", Buffer.from(`${typeof metadata === "string" ? metadata : JSON.stringify(metadata)}\r\n`));
            child.emit("close", metadataExitCode);
          };
          if (metadataDelayMilliseconds === 0) {
            queueMicrotask(complete);
          } else {
            const timer = setTimeout(complete, metadataDelayMilliseconds);
            options.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
            }, { once: true });
          }
        },
      };
      return child;
    }
    if (calls === 2) {
      equal(command, executable, "isolated Windows browser launch executable");
      if (JSON.stringify(args) !== JSON.stringify(expectedLaunchArgs)) fail("isolated Windows browser launch arguments are invalid");
      if (options.shell !== false || options.detached !== true || options.stdio !== "ignore" || options.signal === undefined) fail("isolated Windows browser launch options are invalid");
      launchSignal = options.signal;
      const child = new EventEmitter();
      child.unref = () => { unrefs += 1; };
      queueMicrotask(() => {
        child.emit(launchError === null ? "spawn" : "error", launchError);
        if (launchError === null && launchExitCode !== null) {
          setTimeout(() => child.emit("close", launchExitCode), launchExitDelayMilliseconds);
        }
      });
      return child;
    }
    fail("Windows branded capture spawned an unexpected process");
  };
  spawnStub.assertCalls = (expected, expectedUnrefs = expected === 2 && launchError === null && launchExitCode === null ? 1 : 0) => {
    equal(calls, expected, "Windows branded capture process count");
    equal(unrefs, expectedUnrefs, "Windows branded capture unref count");
  };
  spawnStub.assertMetadataAborted = () => equal(metadataSignal?.aborted, true, "Windows metadata command shares the capture deadline signal");
  spawnStub.assertLaunchAborted = () => equal(launchSignal?.aborted, true, "Windows browser launch shares the capture deadline signal");
  return spawnStub;
}

function firefoxCaptureChildStub({ executable, exactVersion, environment, profileRoot, versionDelayMilliseconds = 0, launchExitCode = null }) {
  let calls = 0;
  let unrefs = 0;
  let versionSignal;
  let launchSignal;
  const spawnStub = (command, args, options) => {
    calls += 1;
    if (calls === 1) {
      equal(command, executable, "Firefox version executable");
      if (JSON.stringify(args) !== JSON.stringify(["--version"]) || options.shell !== false || options.signal === undefined) fail("Firefox version command changed");
      versionSignal = options.signal;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const complete = () => {
        child.stdout.emit("data", Buffer.from(`Mozilla Firefox ${exactVersion}\n`));
        child.emit("close", 0);
      };
      if (versionDelayMilliseconds === 0) {
        queueMicrotask(complete);
      } else {
        const timer = setTimeout(complete, versionDelayMilliseconds);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }
      return child;
    }
    if (calls === 2) {
      equal(command, executable, "Firefox launch executable");
      const expectedArgs = [
        "-wait-for-browser",
        "-no-remote",
        "-profile",
        resolve(profileRoot, environment, exactVersion),
        "http://127.0.0.1:8787/",
      ];
      if (JSON.stringify(args) !== JSON.stringify(expectedArgs) || options.shell !== false || options.detached !== true || options.stdio !== "ignore" || options.signal === undefined) fail("Firefox launch is not isolated by exact version");
      launchSignal = options.signal;
      const child = new EventEmitter();
      child.unref = () => { unrefs += 1; };
      queueMicrotask(() => {
        child.emit("spawn");
        if (launchExitCode !== null) child.emit("close", launchExitCode);
      });
      return child;
    }
    fail("Firefox capture spawned an unexpected process");
  };
  spawnStub.assertCalls = (expected = 2, expectedUnrefs = expected === 2 ? 1 : 0) => {
    equal(calls, expected, "Firefox capture process count");
    equal(unrefs, expectedUnrefs, "Firefox capture unref count");
  };
  spawnStub.assertVersionAborted = () => equal(versionSignal?.aborted, true, "Firefox version command shares the capture deadline signal");
  spawnStub.assertLaunchAborted = () => equal(launchSignal?.aborted, true, "Firefox launch shares the capture deadline signal");
  return spawnStub;
}

function safariCaptureChildStub(exactVersion, launchDelayMilliseconds = 0) {
  let calls = 0;
  let launchSignal;
  const spawnStub = (command, args, options) => {
    calls += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (calls === 1) {
        equal(command, "/usr/bin/safaridriver", "Safari version executable");
        if (JSON.stringify(args) !== JSON.stringify(["--version"]) || options.shell !== false || options.signal === undefined) fail("Safari version command changed");
        child.stdout.emit("data", Buffer.from(`Included with Safari ${exactVersion}\n`));
      } else if (calls === 2) {
        equal(command, "/usr/bin/open", "Safari launcher executable");
        if (JSON.stringify(args) !== JSON.stringify(["-a", "Safari", "http://127.0.0.1:8787/"]) || options.shell !== false || options.signal === undefined) fail("Safari launcher command changed");
        launchSignal = options.signal;
        if (launchDelayMilliseconds > 0) {
          const timer = setTimeout(() => child.emit("close", 0), launchDelayMilliseconds);
          launchSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
          return;
        }
      } else {
        fail("Safari capture spawned an unexpected process");
      }
      child.emit("close", 0);
    });
    return child;
  };
  spawnStub.assertCalls = () => equal(calls, 2, "Safari capture process count");
  spawnStub.assertLaunchAborted = () => equal(launchSignal?.aborted, true, "Safari launcher shares the capture deadline signal");
  return spawnStub;
}

async function producerEngineSelfTest(repoRoot, oneCallClock) {
  await createSyntheticCampaign(repoRoot);
  const mapping = engineMappings.chromium;
  const matrix = json((await readFile(absolute(repoRoot, matrixPath))).toString("utf8"), "engine fixture matrix");
  matrix.engineCoverage = matrix.engineCoverage.filter((row) => row.project !== "chromium");
  await writeAtomic(absolute(repoRoot, matrixPath), jsonText(matrix));
  await rm(absolute(repoRoot, mapping.report), { force: true });
  await rm(absolute(repoRoot, mapping.observation), { force: true });
  await rm(absolute(repoRoot, mapping.receipt), { force: true });
  await recordEngine({ repoRoot, releaseDate: "2026-09-13", project: "chromium", clock: oneCallClock(), spawnImpl: engineChildStub("valid") });
  if (!existsSync(absolute(repoRoot, mapping.receipt))) fail("Engine producer did not create mapped receipt");

  await createSyntheticCampaign(repoRoot);
  const staleMatrix = json((await readFile(absolute(repoRoot, matrixPath))).toString("utf8"), "stale engine fixture matrix");
  staleMatrix.engineCoverage = staleMatrix.engineCoverage.filter((row) => row.project !== "chromium");
  await writeAtomic(absolute(repoRoot, matrixPath), jsonText(staleMatrix));
  await rm(absolute(repoRoot, mapping.receipt), { force: true });
  await writeAtomic(absolute(repoRoot, mapping.report), "stale-report");
  await writeAtomic(absolute(repoRoot, mapping.observation), "stale-observation");
  await expectThrows(() => recordEngine({ repoRoot, releaseDate: "2026-09-13", project: "chromium", clock: oneCallClock(), spawnImpl: engineChildStub("missing") }), "record-engine rejects stale outputs not created by run");
  if (existsSync(absolute(repoRoot, mapping.report)) || existsSync(absolute(repoRoot, mapping.observation))) fail("record-engine retained stale outputs");

  await createSyntheticCampaign(repoRoot);
  const policyMatrix = json((await readFile(absolute(repoRoot, matrixPath))).toString("utf8"), "engine policy fixture matrix");
  policyMatrix.engineCoverage = policyMatrix.engineCoverage.filter((row) => row.project !== "chromium");
  await writeAtomic(absolute(repoRoot, matrixPath), jsonText(policyMatrix));
  await rm(absolute(repoRoot, mapping.receipt), { force: true });
  await expectThrows(() => recordEngine({ repoRoot, releaseDate: "2026-09-13", project: "chromium", clock: oneCallClock(), spawnImpl: engineChildStub("failed-report") }), "record-engine rejects failed reporter test");
}

async function browserSelfTest() {
  const dir = await mkdtemp(resolve(tmpdir(), "cfpb-browser-evidence-"));
  const profileRoot = resolve(dir, "profiles");
  if (relative(dir, profileRoot) !== "profiles") fail("Self-test profiles must stay inside the disposable fixture");
  const oneCallClock = () => {
    let calls = 0;
    return () => {
      calls += 1;
      if (calls !== 1) fail("Operation read its injected clock more than once");
      return Date.parse("2026-09-13T12:00:00.000Z");
    };
  };
  try {
    await expectThrowsMessage(
      () => captureBrowserForPlatform({ repoRoot: resolve(dir, "wrong-firefox-platform"), releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: "windows-firefox-current", executableEnv: "CFPB_SELF_TEST_WRONG_PLATFORM", clock: oneCallClock(), platform: "linux", profileRoot }),
      "Firefox capture requires win32",
      "Firefox capture rejects a non-Windows runner",
    );
    await expectThrowsMessage(
      () => captureSafariForPlatform({ repoRoot: resolve(dir, "wrong-safari-platform"), releaseDate: "2026-09-13", slot: "current", environment: "macos-safari-current", clock: oneCallClock(), platform: "win32" }),
      "Safari capture requires darwin",
      "Safari capture rejects a non-macOS runner",
    );
    if (process.platform === "win32") {
      const executableEnv = "CFPB_SELF_TEST_PUBLIC_PLATFORM_EXECUTABLE";
      const previous = process.env[executableEnv];
      delete process.env[executableEnv];
      try {
        await expectThrowsMessage(
          () => captureBrowser({ repoRoot: resolve(dir, "public-platform-browser"), releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: "windows-firefox-current", executableEnv, clock: oneCallClock(), platform: "linux" }),
          `${executableEnv} must be a nonempty string`,
          "Public browser capture ignores a spoofed platform",
        );
        await expectThrowsMessage(
          () => captureSafari({ repoRoot: resolve(dir, "public-platform-safari"), releaseDate: "2026-09-13", slot: "current", environment: "macos-safari-current", clock: oneCallClock(), platform: "darwin" }),
          "Safari capture requires darwin",
          "Public Safari capture ignores a spoofed platform",
        );
      } finally {
        if (previous === undefined) delete process.env[executableEnv]; else process.env[executableEnv] = previous;
      }
    } else {
      await expectThrowsMessage(
        () => captureBrowser({ repoRoot: resolve(dir, "public-platform-browser"), releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: "windows-firefox-current", executableEnv: "CFPB_SELF_TEST_PUBLIC_PLATFORM_EXECUTABLE", clock: oneCallClock(), platform: "win32" }),
        "Firefox capture requires win32",
        "Public browser capture uses the actual non-Windows platform",
      );
      if (process.platform !== "darwin") {
        await expectThrowsMessage(
          () => captureSafari({ repoRoot: resolve(dir, "public-platform-safari"), releaseDate: "2026-09-13", slot: "current", environment: "macos-safari-current", clock: oneCallClock(), platform: "darwin" }),
          "Safari capture requires darwin",
          "Public Safari capture uses the actual non-macOS platform",
        );
      } else {
        const repoRoot = resolve(dir, "public-platform-safari-darwin");
        const campaign = await createSyntheticCampaign(repoRoot);
        const mapping = browserMappings["Safari/current"];
        for (const path of [mapping.capture, mapping.smoke, mapping.unavailable]) await rm(absolute(repoRoot, path), { force: true });
        const spawnImpl = safariCaptureChildStub(campaign.derived.Safari.current.exactVersion);
        await captureSafari({ repoRoot, releaseDate: "2026-09-13", slot: "current", environment: mapping.environment, clock: oneCallClock(), spawnImpl, platform: "win32" });
        spawnImpl.assertCalls();
      }
    }

    const deadlineContext = contextFor("2026-09-13", "2026-09-13T12:00:00.000Z");
    await expectThrowsMessage(
      () => Promise.race([
        deadlineOperation(deadlineContext, () => new Promise(() => {}), { deadlineMilliseconds: 10 }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("deadlineOperation remained pending")), 200)),
      ]),
      "Evidence operation deadline expired",
      "Evidence deadline rejects an action that never settles",
    );
    await expectThrowsMessage(
      () => deadlineOperation(deadlineContext, async () => {
        const blockedUntil = performance.now() + 30;
        while (performance.now() < blockedUntil) {}
      }, { deadlineMilliseconds: 5 }),
      "Evidence operation deadline expired",
      "Evidence deadline detects event-loop blocking from elapsed monotonic time",
    );

    const delayedReadPath = resolve(dir, "deadline-read.txt");
    await writeFile(delayedReadPath, "fixture");
    await expectThrowsMessage(
      () => deadlineOperation(deadlineContext, (signal, checkpoint) => readBytes(dir, "deadline-read.txt", {
        signal,
        checkpoint,
        readFileImpl: async (path, options) => {
          equal(options?.signal, signal, "deadline read signal");
          const blockedUntil = performance.now() + 30;
          while (performance.now() < blockedUntil) {}
          return readFile(path, options);
        },
      }), { deadlineMilliseconds: 5 }),
      "Evidence operation deadline expired",
      "Evidence deadline spans a delayed filesystem read",
    );

    for (const capture of ["browser", "safari"]) {
      const repoRoot = resolve(dir, `capture-read-deadline-${capture}`);
      await createSyntheticCampaign(repoRoot);
      const product = capture === "browser" ? "Firefox" : "Safari";
      const mapping = browserMappings[`${product}/current`];
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      if (mapping.unavailable !== null) await rm(absolute(repoRoot, mapping.unavailable), { force: true });
      let readSignal;
      const delayedRead = async (path, options) => {
        readSignal = options?.signal;
        if (readSignal === undefined) fail(`${product} capture read has no AbortSignal`);
        await new Promise((_resolve, reject) => {
          if (readSignal.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          readSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
        return readFile(path, options);
      };
      const executableEnv = "CFPB_SELF_TEST_READ_DEADLINE_EXECUTABLE";
      if (capture === "browser") process.env[executableEnv] = "C:\\Pinned Browsers\\Firefox\\current\\firefox.exe";
      try {
        await expectThrowsMessage(
          () => capture === "browser"
            ? captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product, slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), platform: "win32", profileRoot, readFileImpl: delayedRead, deadlineMilliseconds: 20 })
            : captureSafariForPlatform({ repoRoot, releaseDate: "2026-09-13", slot: "current", environment: mapping.environment, clock: oneCallClock(), platform: "darwin", readFileImpl: delayedRead, deadlineMilliseconds: 20 }),
          "Evidence operation deadline expired",
          `${product} capture deadline aborts an in-flight read`,
        );
        equal(readSignal?.aborted, true, `${product} capture read shares the deadline signal`);
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, `${product} read deadline leaves no receipt`);
      } finally {
        if (capture === "browser") delete process.env[executableEnv];
      }
    }

    const delayedCommitPath = resolve(dir, "deadline-commit.json");
    await expectThrowsMessage(
      () => deadlineOperation(deadlineContext, (signal, checkpoint) => writeAtomic(delayedCommitPath, "fixture", {
        signal,
        checkpoint,
        operations: {
          mkdir,
          writeFile,
          rename: async (...args) => {
            await rename(...args);
            await new Promise(() => {});
          },
          renameSync: (...args) => {
            renameSync(...args);
            const blockedUntil = performance.now() + 30;
            while (performance.now() < blockedUntil) {}
          },
          rm,
          rmSync,
        },
      }), { deadlineMilliseconds: 5 }),
      "Evidence operation deadline expired",
      "Evidence deadline spans atomic receipt commit",
    );
    equal(existsSync(delayedCommitPath), false, "expired atomic receipt commit leaves no receipt");

    const windowsCaptureCases = [
      { product: "Chrome", slot: "current", executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", productName: "Google Chrome", publisher: "Google LLC", bytes: 3_456_789, sha256: "1".repeat(64) },
      { product: "Chrome", slot: "previous", executable: "C:\\Pinned Browsers\\Chrome\\previous\\chrome.exe", productName: "Google Chrome", publisher: "Google LLC", bytes: 3_456_788, sha256: "2".repeat(64) },
      { product: "Edge", slot: "current", executable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", productName: "Microsoft Edge", publisher: "Microsoft Corporation", bytes: 5_418_312, sha256: "3".repeat(64) },
      { product: "Edge", slot: "previous", executable: "C:\\Pinned Browsers\\Edge\\previous\\msedge.exe", productName: "Microsoft Edge", publisher: "Microsoft Corporation", bytes: 5_418_311, sha256: "4".repeat(64) },
    ];
    {
      const fixture = windowsCaptureCases[0];
      const barePowerShellStub = windowsCaptureChildStub({ executable: fixture.executable, environment: "windows-chrome-current", metadata: fixture, profileRoot });
      barePowerShellStub("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], {
        shell: false,
        windowsHide: true,
        signal: new AbortController().signal,
        env: { CFPB_BROWSER_EXECUTABLE_LITERAL: fixture.executable },
      });
      barePowerShellStub.assertCalls(1);
    }
    for (const [index, fixture] of windowsCaptureCases.entries()) {
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, `windows-capture-${index}`);
      const campaign = await createSyntheticCampaign(repoRoot);
      const exactVersion = campaign.derived[fixture.product][fixture.slot].exactVersion;
      const metadata = windowsMetadataFixture(fixture, exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = `CFPB_SELF_TEST_${fixture.product.toUpperCase()}_${fixture.slot.toUpperCase()}_EXECUTABLE`;
      const priorExecutable = process.env[executableEnv];
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, profileRoot });
        const receipt = await captureBrowserForPlatform({
          repoRoot,
          releaseDate: "2026-09-13",
          product: fixture.product,
          slot: fixture.slot,
          environment: mapping.environment,
          executableEnv,
          clock: oneCallClock(),
          spawnImpl,
          platform: "win32",
          profileRoot,
        });
        spawnImpl.assertCalls(2);
        equal(receipt.schemaVersion, 2, `${fixture.product}/${fixture.slot} Windows capture schema`);
        const expectedProvenance = { extractionMethod: "windows-powershell-authenticode-fileversion-v1", ...metadata };
        if (JSON.stringify(receipt.binaryProvenance) !== JSON.stringify(expectedProvenance)) fail(`${fixture.product}/${fixture.slot} Windows binary provenance differs from PE metadata`);
        if (Object.hasOwn(receipt, "rawVersionOutput")) fail(`${fixture.product}/${fixture.slot} Windows capture retained direct --version output`);
      } finally {
        if (priorExecutable === undefined) delete process.env[executableEnv]; else process.env[executableEnv] = priorExecutable;
      }
    }

    const rejectedWindowsMetadata = [
      ["unsigned binary", (metadata) => { metadata.authenticodeStatus = "NotSigned"; }, 0],
      ["wrong publisher", (metadata) => { metadata.publisher = "Wrong Publisher"; }, 0],
      ["wrong product", (metadata) => { metadata.productName = "Wrong Product"; }, 0],
      ["malformed metadata", (metadata) => { delete metadata.bytes; }, 0],
      ["path mismatch", (metadata) => { metadata.path = "C:\\Other\\chrome.exe"; }, 0],
      ["unexpected version", (metadata) => { metadata.productVersion = "121.0.0.0"; }, 0],
      ["uppercase SHA-256", (metadata) => { metadata.sha256 = "A".repeat(64); }, 0],
      ["nonzero metadata command", () => {}, 7],
    ];
    for (const [index, [name, mutateMetadata, metadataExitCode]] of rejectedWindowsMetadata.entries()) {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, `windows-capture-rejected-${index}`);
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived[fixture.product][fixture.slot].exactVersion);
      mutateMetadata(metadata);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = `CFPB_SELF_TEST_REJECTED_${index}_EXECUTABLE`;
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata: metadataExitCode === 0 ? metadata : undefined, metadataExitCode, profileRoot });
        await expectThrows(() => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: fixture.product, slot: fixture.slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot }), `Windows capture rejects ${name}`);
        spawnImpl.assertCalls(1);
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, `Windows capture ${name} leaves no receipt`);
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, "windows-capture-metadata-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived[fixture.product][fixture.slot].exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_METADATA_DEADLINE_EXECUTABLE";
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, metadataDelayMilliseconds: 200, profileRoot });
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: fixture.product, slot: fixture.slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot, deadlineMilliseconds: 20 }),
          "Evidence operation deadline expired",
          "Windows capture deadline aborts the metadata command",
        );
        spawnImpl.assertCalls(1);
        spawnImpl.assertMetadataAborted();
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Windows metadata deadline leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, "windows-capture-launch-failure");
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived[fixture.product][fixture.slot].exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_LAUNCH_FAILURE_EXECUTABLE";
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, profileRoot, launchError: new Error("synthetic isolated launch failure") });
        await expectThrows(() => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: fixture.product, slot: fixture.slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot }), "Windows capture launch failure leaves no receipt");
        spawnImpl.assertCalls(2);
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Windows capture launch failure leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, "windows-capture-immediate-exit");
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived[fixture.product][fixture.slot].exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_IMMEDIATE_EXIT_EXECUTABLE";
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, profileRoot, launchExitCode: 0, launchExitDelayMilliseconds: 900 });
        await expectThrows(() => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: fixture.product, slot: fixture.slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot }), "Windows capture rejects a browser that exits during launch");
        spawnImpl.assertCalls(2);
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Windows capture immediate exit leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings[`${fixture.product}/${fixture.slot}`];
      const repoRoot = resolve(dir, "windows-capture-shared-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived[fixture.product][fixture.slot].exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_SHARED_DEADLINE_EXECUTABLE";
      process.env[executableEnv] = fixture.executable;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, profileRoot });
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: fixture.product, slot: fixture.slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot, deadlineMilliseconds: 300 }),
          "Evidence operation deadline expired",
          "Windows capture deadline spans metadata and launch settling",
        );
        spawnImpl.assertCalls(2, 0);
        spawnImpl.assertLaunchAborted();
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Windows capture deadline leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const fixture = windowsCaptureCases[0];
      const mapping = browserMappings["Chrome/current"];
      const repoRoot = resolve(dir, "windows-capture-commit-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      const metadata = windowsMetadataFixture(fixture, campaign.derived.Chrome.current.exactVersion);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_WINDOWS_COMMIT_DEADLINE_EXECUTABLE";
      process.env[executableEnv] = fixture.executable;
      let writeSignal;
      let writeCalls = 0;
      try {
        const spawnImpl = windowsCaptureChildStub({ executable: fixture.executable, environment: mapping.environment, metadata, profileRoot });
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Chrome", slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot, deadlineMilliseconds: 2_500,
            writeReceiptImpl: (_path, _bytes, options) => {
              writeCalls += 1;
              writeSignal = options.signal;
              return new Promise((_resolvePromise, reject) => writeSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
            },
          }),
          "Evidence operation deadline expired",
          "Windows capture deadline aborts an in-flight receipt commit",
        );
        spawnImpl.assertCalls(2);
        equal(writeCalls, 1, "Windows capture reaches the receipt commit");
        equal(writeSignal?.aborted, true, "Windows receipt commit shares the capture deadline signal");
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Windows receipt commit timeout leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const slot = "current";
      const mapping = browserMappings[`Firefox/${slot}`];
      const repoRoot = resolve(dir, "firefox-version-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      const exactVersion = campaign.derived.Firefox[slot].exactVersion;
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_FIREFOX_VERSION_DEADLINE_EXECUTABLE";
      const executable = "C:\\Pinned Browsers\\Firefox\\deadline\\firefox.exe";
      process.env[executableEnv] = executable;
      try {
        const spawnImpl = firefoxCaptureChildStub({ executable, exactVersion, environment: mapping.environment, profileRoot, versionDelayMilliseconds: 200 });
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot, deadlineMilliseconds: 20 }),
          "Evidence operation deadline expired",
          "Firefox capture deadline aborts the version command",
        );
        spawnImpl.assertCalls(1);
        spawnImpl.assertVersionAborted();
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Firefox version deadline leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const mapping = browserMappings["Firefox/current"];
      const repoRoot = resolve(dir, "firefox-launch-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_FIREFOX_LAUNCH_DEADLINE_EXECUTABLE";
      const executable = "C:\\Pinned Browsers\\Firefox\\current\\firefox.exe";
      process.env[executableEnv] = executable;
      try {
        const spawnImpl = firefoxCaptureChildStub({ executable, exactVersion: campaign.derived.Firefox.current.exactVersion, environment: mapping.environment, profileRoot });
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot, deadlineMilliseconds: 300 }),
          "Evidence operation deadline expired",
          "Firefox capture deadline aborts the browser launch",
        );
        spawnImpl.assertCalls(2, 0);
        spawnImpl.assertLaunchAborted();
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Firefox launch deadline leaves no receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const mapping = browserMappings["Firefox/current"];
      const repoRoot = resolve(dir, "firefox-concurrent-capture");
      const campaign = await createSyntheticCampaign(repoRoot);
      const exactVersion = campaign.derived.Firefox.current.exactVersion;
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_CONCURRENT_CAPTURE_EXECUTABLE";
      const executable = "C:\\Pinned Browsers\\Firefox\\current\\firefox.exe";
      process.env[executableEnv] = executable;
      const firstSpawn = firefoxCaptureChildStub({ executable, exactVersion, environment: mapping.environment, profileRoot, versionDelayMilliseconds: 200 });
      const secondSpawn = firefoxCaptureChildStub({ executable, exactVersion, environment: mapping.environment, profileRoot });
      let versionStarted;
      const enteredVersion = new Promise((resolvePromise) => { versionStarted = resolvePromise; });
      const first = captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl: (...args) => {
        const child = firstSpawn(...args);
        if (args[1][0] === "--version") versionStarted();
        return child;
      }, platform: "win32", profileRoot, deadlineMilliseconds: 2_000 });
      try {
        await enteredVersion;
        await expectThrowsMessage(
          () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl: secondSpawn, platform: "win32", profileRoot, deadlineMilliseconds: 2_000 }),
          `Evidence lock is held: ${mapping.capture}.lock`,
          "Concurrent capture cannot overwrite another capture's receipt",
        );
        secondSpawn.assertCalls(0);
        await first;
        equal(existsSync(absolute(repoRoot, mapping.capture)), true, "concurrent capture preserves the first receipt");
      } finally {
        await Promise.allSettled([first]);
        delete process.env[executableEnv];
      }
    }

    for (const slot of slots) {
      const mapping = browserMappings[`Firefox/${slot}`];
      const repoRoot = resolve(dir, `firefox-capture-${slot}`);
      const campaign = await createSyntheticCampaign(repoRoot);
      const exactVersion = campaign.derived.Firefox[slot].exactVersion;
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = `CFPB_SELF_TEST_FIREFOX_${slot.toUpperCase()}_EXECUTABLE`;
      const executable = `C:\\Pinned Browsers\\Firefox\\${slot}\\firefox.exe`;
      process.env[executableEnv] = executable;
      try {
        const spawnImpl = firefoxCaptureChildStub({ executable, exactVersion, environment: mapping.environment, profileRoot });
        const receipt = await captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot, environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot });
        spawnImpl.assertCalls();
        equal(receipt.schemaVersion, 1, `Firefox/${slot} direct version capture schema`);
        if (JSON.stringify(receipt.rawVersionOutput) !== JSON.stringify(syntheticRawVersion("Firefox", exactVersion))) fail(`Firefox/${slot} direct version output changed`);
        if (Object.hasOwn(receipt, "binaryProvenance")) fail(`Firefox/${slot} capture inherited Windows binary provenance`);
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const mapping = browserMappings["Firefox/current"];
      const repoRoot = resolve(dir, "firefox-launch-early-exit");
      const campaign = await createSyntheticCampaign(repoRoot);
      await rm(absolute(repoRoot, mapping.capture), { force: true });
      await rm(absolute(repoRoot, mapping.smoke), { force: true });
      const executableEnv = "CFPB_SELF_TEST_FIREFOX_EARLY_EXIT_EXECUTABLE";
      const executable = "C:\\Pinned Browsers\\Firefox\\current\\firefox.exe";
      process.env[executableEnv] = executable;
      try {
        const spawnImpl = firefoxCaptureChildStub({ executable, exactVersion: campaign.derived.Firefox.current.exactVersion, environment: mapping.environment, profileRoot, launchExitCode: 0 });
        const capture = () => captureBrowserForPlatform({ repoRoot, releaseDate: "2026-09-13", product: "Firefox", slot: "current", environment: mapping.environment, executableEnv, clock: oneCallClock(), spawnImpl, platform: "win32", profileRoot });
        await expectThrows(capture, "Firefox launch that exits before settle is rejected");
        spawnImpl.assertCalls(2, 0);
        equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Firefox early-exit cannot write a receipt");
      } finally {
        delete process.env[executableEnv];
      }
    }

    {
      const mapping = browserMappings["Safari/current"];
      const repoRoot = resolve(dir, "safari-capture");
      const campaign = await createSyntheticCampaign(repoRoot);
      const exactVersion = campaign.derived.Safari.current.exactVersion;
      for (const path of [mapping.capture, mapping.smoke, mapping.unavailable]) await rm(absolute(repoRoot, path), { force: true });
      const spawnImpl = safariCaptureChildStub(exactVersion);
      const receipt = await captureSafariForPlatform({ repoRoot, releaseDate: "2026-09-13", slot: "current", environment: mapping.environment, clock: oneCallClock(), spawnImpl, platform: "darwin" });
      spawnImpl.assertCalls();
      equal(receipt.schemaVersion, 1, "Safari launcher success capture schema");
      equal(existsSync(absolute(repoRoot, mapping.capture)), true, "Safari launcher success writes capture receipt");
    }

    {
      const mapping = browserMappings["Safari/current"];
      const repoRoot = resolve(dir, "safari-launch-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      for (const path of [mapping.capture, mapping.smoke, mapping.unavailable]) await rm(absolute(repoRoot, path), { force: true });
      const spawnImpl = safariCaptureChildStub(campaign.derived.Safari.current.exactVersion, 1_500);
      await expectThrowsMessage(
        () => captureSafariForPlatform({ repoRoot, releaseDate: "2026-09-13", slot: "current", environment: mapping.environment, clock: oneCallClock(), spawnImpl, platform: "darwin", deadlineMilliseconds: 300 }),
        "Evidence operation deadline expired",
        "Safari capture deadline aborts the launcher",
      );
      spawnImpl.assertCalls();
      spawnImpl.assertLaunchAborted();
      equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Safari launch deadline leaves no receipt");
    }

    {
      const mapping = browserMappings["Safari/current"];
      const repoRoot = resolve(dir, "safari-capture-commit-deadline");
      const campaign = await createSyntheticCampaign(repoRoot);
      for (const path of [mapping.capture, mapping.smoke, mapping.unavailable]) await rm(absolute(repoRoot, path), { force: true });
      let writeSignal;
      let writeCalls = 0;
      await expectThrowsMessage(
        () => captureSafariForPlatform({ repoRoot, releaseDate: "2026-09-13", slot: "current", environment: mapping.environment, clock: oneCallClock(), spawnImpl: safariCaptureChildStub(campaign.derived.Safari.current.exactVersion), platform: "darwin", deadlineMilliseconds: 300,
          writeReceiptImpl: (path, contents, options) => writeAtomic(path, contents, { ...options, operations: {
            mkdir,
            writeFile: (_temporary, _contents, writeOptions) => {
              writeCalls += 1;
              writeSignal = writeOptions.signal;
              return new Promise((_resolvePromise, reject) => writeSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
            },
            renameSync,
            rm,
            rmSync,
          } }),
        }),
        "Evidence operation deadline expired",
        "Safari capture deadline aborts an in-flight receipt write",
      );
      equal(writeCalls, 1, "Safari capture reaches the receipt commit");
      equal(writeSignal?.aborted, true, "Safari receipt write shares the capture deadline signal");
      equal(existsSync(absolute(repoRoot, mapping.capture)), false, "Safari receipt write timeout leaves no receipt");
    }

    const retrievedAt = "2026-09-13T12:00:00.000Z";
    const chromeGoogleTimestampCases = [
      { source: "2026-09-10T01:02:03Z", canonical: "2026-09-10T01:02:03.000Z" },
      { source: "2026-09-10T01:02:04.123Z", canonical: "2026-09-10T01:02:04.123Z" },
      { source: "2026-09-10T01:02:05.662121Z", canonical: "2026-09-10T01:02:05.662Z" },
      { source: "2026-09-10T01:02:06.987654321Z", canonical: "2026-09-10T01:02:06.987Z" },
    ];
    for (const { source, canonical } of chromeGoogleTimestampCases) {
      equal(chromeSourceTimestamp(source, "Chrome Google Timestamp").value, canonical, `Chrome Google Timestamp canonicalizes ${source}`);
    }
    const earlierChromeSource = chromeSourceTimestamp("2026-09-10T01:02:07.123001Z", "Chrome earlier source timestamp");
    const laterChromeSource = chromeSourceTimestamp("2026-09-10T01:02:07.123999999Z", "Chrome later source timestamp");
    equal(earlierChromeSource.value, laterChromeSource.value, "Chrome source timestamps truncate to the same artifact millisecond");
    if (earlierChromeSource.sourceInstant >= laterChromeSource.sourceInstant) fail("Chrome source timestamps retain precision for earliest selection");
    for (const timestamp of ["2026-09-10T01:02:03.12Z", "2026-09-10T01:02:03.1234Z", "2026-09-10T01:02:03.123+00:00", "2026-02-29T01:02:03Z"]) {
      await expectThrows(() => Promise.resolve(chromeSourceTimestamp(timestamp, "Chrome invalid Google Timestamp")), `Chrome rejects invalid Google Timestamp ${timestamp}`);
    }
    await expectThrows(() => Promise.resolve(normalizeChromePayloads([{ releases: [
      { fraction: 1, name: "chrome-duplicate-precision", version: "120.0", serving: { startTime: "2026-09-10T01:02:05.662121Z" } },
      { fraction: 1, name: "chrome-duplicate-precision", version: "120.0", serving: { startTime: "2026-09-10T01:02:05.662122Z" } },
      { fraction: 1, name: "chrome-117", version: "117.0", serving: { startTime: "2026-09-09T00:00:00Z" } },
      { fraction: 1, name: "chrome-111", version: "111.0", serving: { startTime: "2026-09-08T00:00:00Z" } },
    ] }], retrievedAt)), "Chrome repeated release ID conflicts at source precision");
    const chromeContinuationUrl = `${sourceConfigurations.Chrome.url}&page_token=continuation%20token`;
    const chromeTerminalUrl = `${sourceConfigurations.Chrome.url}&page_token=terminal%20token`;
    const chromeFirstBody = JSON.stringify({ releases: [
      { fraction: 1, name: "chrome-120", version: "120.0", serving: { startTime: "2026-09-10T00:00:00.000Z" } },
    ], nextPageToken: "continuation token" });
    const chromeContinuationBody = JSON.stringify({ releases: [
      { fraction: 1, name: "chrome-117", version: "117.0", serving: { startTime: "2026-09-09T00:00:00.000Z" } },
      { fraction: 1, name: "chrome-111", version: "111.0", serving: { startTime: "2026-09-08T00:00:00.000Z" } },
    ] });
    const chromeDeadlineFirstBody = JSON.stringify({ releases: [
      { fraction: 1, name: "chrome-120", version: "120.0", serving: { startTime: "2026-09-10T00:00:00.000Z" } },
      { fraction: 1, name: "chrome-117", version: "117.0", serving: { startTime: "2026-09-09T00:00:00.000Z" } },
      { fraction: 1, name: "chrome-111", version: "111.0", serving: { startTime: "2026-09-08T00:00:00.000Z" } },
    ], nextPageToken: "continuation token" });
    const chromeFullReleases = Array.from({ length: 1000 }, (_, index) => {
      const major = [120, 117, 111][index % 3];
      return { fraction: 1, name: `chrome-full-${index}`, version: `${major}.${Math.floor(index / 3)}.0`, serving: { startTime: "2026-09-10T00:00:00.000Z" } };
    });
    const chromeFullFirstBody = JSON.stringify({ releases: chromeFullReleases, nextPageToken: "continuation token" });
    const chromeTerminalBody = JSON.stringify({ releases: [
      { fraction: 1, name: "chrome-terminal-110", version: "110.0", serving: { startTime: "2026-09-09T00:00:00.000Z" } },
      { fraction: 1, name: "chrome-terminal-109", version: "109.0", serving: { startTime: "2026-09-08T00:00:00.000Z" } },
      { fraction: 1, name: "chrome-terminal-108", version: "108.0", serving: { startTime: "2026-09-07T00:00:00.000Z" } },
    ], nextPageToken: "terminal token" });
    const retryableChromeError = JSON.stringify({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } });
    const differentChromeError = JSON.stringify({ error: { code: 400, message: "A different error.", status: "INVALID_ARGUMENT" } });
    const vendorResponses = [
      [sourceConfigurations.Edge.url, JSON.stringify([{ Product: "Stable", Releases: [
        { Platform: "Windows", Architecture: "x64", ReleaseId: 120, ProductVersion: "120.0", PublishedTime: "2026-09-10T00:00:00" },
        { Platform: "Windows", Architecture: "x64", ReleaseId: 117, ProductVersion: "117.0", PublishedTime: "2026-09-09T00:00:00" },
        { Platform: "Windows", Architecture: "x64", ReleaseId: 111, ProductVersion: "111.0", PublishedTime: "2026-09-08T00:00:00" },
      ] }])],
      [sourceConfigurations.Firefox.url, JSON.stringify({ "120.0": "2026-09-10", "117.0": "2026-09-09", "111.0": "2026-09-08" })],
      [sourceConfigurations.Safari.url, "<table><tr><th>Name and information link</th><th>Available for</th><th>Release date</th></tr><tr><td>Safari 120.0</td><td>x</td><td>10 Sep 2026</td></tr><tr><td>Safari 117.0</td><td>x</td><td>09 Sep 2026</td></tr><tr><td>Safari 111.0</td><td>x</td><td>08 Sep 2026</td></tr></table>"],
    ];
    const queuedFetch = (responses, calls) => async (url) => {
      calls.push(url);
      const response = responses.get(url)?.shift();
      if (response === undefined) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { status: response.status, arrayBuffer: async () => Buffer.from(response.body) };
    };

    const staleTerminalRoot = resolve(dir, "chrome-stale-terminal");
    const staleTerminalCalls = [];
    let staleTerminalFailure;
    try {
      await acquireTargets({ repoRoot: staleTerminalRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
        [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFullFirstBody }]],
        [chromeContinuationUrl, [{ status: 200, body: chromeTerminalBody }]],
        [chromeTerminalUrl, Array.from({ length: 6 }, () => ({ status: 400, body: retryableChromeError }))],
        ...vendorResponses.map(([url, body]) => [url, [{ status: 200, body }]]),
      ]), staleTerminalCalls) });
    } catch (error) {
      staleTerminalFailure = error;
    }
    if (staleTerminalFailure !== undefined) {
      equal(staleTerminalCalls.filter((url) => url === chromeTerminalUrl).length, 6, "Chrome stale terminal token has six physical attempts before failure");
      equal(existsSync(staleTerminalRoot), false, "Chrome stale terminal failure performs no writes");
      throw staleTerminalFailure;
    }
    const staleTerminalChrome = await readJson(staleTerminalRoot, sourceConfigurations.Chrome.artifact);
    equal(staleTerminalCalls.filter((url) => url === chromeTerminalUrl).length, 6, "Chrome stale terminal token has six physical attempts");
    equal(staleTerminalChrome.source.responseCount, 2, "Chrome stale terminal token preserves successful pages once");
    equal(staleTerminalChrome.source.responseSha256, sha256(Buffer.concat([Buffer.from(chromeFullFirstBody), Buffer.from("\n"), Buffer.from(chromeTerminalBody)])), "Chrome stale terminal token preserves successful page hash");

    const expiredChromeRoot = resolve(dir, "chrome-pagination-deadline");
    const expiredChromeCalls = [];
    await expectThrows(() => acquireTargets({
      repoRoot: expiredChromeRoot,
      releaseDate: "2026-09-13",
      clock: oneCallClock(),
      deadlineMilliseconds: 25,
      fetchImpl: async (url, { signal }) => {
        expiredChromeCalls.push(url);
        if (url === sourceConfigurations.Chrome.url) return { status: 200, arrayBuffer: async () => Buffer.from(chromeDeadlineFirstBody) };
        if (url === chromeContinuationUrl) {
          return new Promise((resolvePromise, reject) => {
            const timeout = setTimeout(() => resolvePromise({ status: 400, arrayBuffer: async () => Buffer.from(retryableChromeError) }), 20);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            }, { once: true });
          });
        }
        const vendorResponse = vendorResponses.find(([candidate]) => candidate === url);
        if (vendorResponse !== undefined) return { status: 200, arrayBuffer: async () => Buffer.from(vendorResponse[1]) };
        return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      },
    }), "Chrome pagination deadline spans retries");
    equal(existsSync(expiredChromeRoot), false, "Chrome pagination deadline performs no writes");

    const expiredLaterVendorRoot = resolve(dir, "later-vendor-deadline");
    const delayedVendorResponse = (body, signal) => new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => resolvePromise({ status: 200, arrayBuffer: async () => Buffer.from(body) }), 200);
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    });
    let expiredLaterVendorFailure;
    try {
      await acquireTargets({
        repoRoot: expiredLaterVendorRoot,
        releaseDate: "2026-09-13",
        clock: oneCallClock(),
        deadlineMilliseconds: 300,
        fetchImpl: async (url, { signal }) => {
          if (url === sourceConfigurations.Chrome.url) return delayedVendorResponse(chromeFirstBody, signal);
          if (url === chromeContinuationUrl) return { status: 200, arrayBuffer: async () => Buffer.from(chromeContinuationBody) };
          if (url === sourceConfigurations.Edge.url) return delayedVendorResponse(vendorResponses[0][1], signal);
          const vendorResponse = vendorResponses.find(([candidate]) => candidate === url);
          if (vendorResponse !== undefined) return { status: 200, arrayBuffer: async () => Buffer.from(vendorResponse[1]) };
          return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        },
      });
    } catch (error) {
      expiredLaterVendorFailure = error;
    }
    if (expiredLaterVendorFailure === undefined) fail("Self-test expected rejection: Acquire targets deadline spans later vendors");
    equal(expiredLaterVendorFailure instanceof Error ? expiredLaterVendorFailure.message : String(expiredLaterVendorFailure), "Evidence operation deadline expired", "Acquire targets deadline spans later vendors");
    equal(existsSync(expiredLaterVendorRoot), false, "Acquire targets deadline across vendors performs no writes");

    const delayedStageRoot = resolve(dir, "acquisition-staging-deadline");
    await createSyntheticCampaign(delayedStageRoot);
    const campaignPaths = [...productNames.map((product) => sourceConfigurations[product].artifact), matrixPath, accessibilityPath];
    const oldCampaignBytes = await Promise.all(campaignPaths.map((path) => readFile(absolute(delayedStageRoot, path))));
    let stagingStarted = false;
    await expectThrowsMessage(() => acquireTargets({
      repoRoot: delayedStageRoot,
      releaseDate: "2026-09-13",
      clock: oneCallClock(),
      deadlineMilliseconds: 200,
      fetchImpl: queuedFetch(new Map([
        [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFirstBody }]],
        [chromeContinuationUrl, [{ status: 200, body: chromeContinuationBody }]],
        ...vendorResponses.map(([url, body]) => [url, [{ status: 200, body }]]),
      ]), []),
      stageImpl: async (path, contents, operation) => {
        stagingStarted = true;
        const signal = operation?.signal;
        if (signal === undefined) fail("Acquisition staging has no shared deadline signal");
        await new Promise((resolvePromise) => {
          if (signal.aborted) resolvePromise();
          else signal.addEventListener("abort", resolvePromise, { once: true });
        });
        return stage(path, contents, operation);
      },
    }), "Evidence operation deadline expired", "Acquire targets deadline spans asynchronous staging");
    equal(stagingStarted, true, "Acquisition reached post-fetch staging before deadline");
    for (const [index, path] of campaignPaths.entries()) {
      equal(Buffer.compare(await readFile(absolute(delayedStageRoot, path)), oldCampaignBytes[index]), 0, `${path} unchanged after staging deadline`);
    }
    for (const path of [
      ...Object.values(browserMappings).flatMap((mapping) => [mapping.capture, mapping.smoke]),
      ...Object.values(engineMappings).flatMap((mapping) => [mapping.report, mapping.observation, mapping.receipt]),
    ]) equal(existsSync(absolute(delayedStageRoot, path)), true, `${path} retained after staging deadline`);

    const stagedThenBlockedRoot = resolve(dir, "acquisition-staged-then-blocked");
    let firstTemporary;
    let laterStageBlocked = false;
    let watchdog;
    try {
      await expectThrowsMessage(() => Promise.race([
        acquireTargets({
          repoRoot: stagedThenBlockedRoot,
          releaseDate: "2026-09-13",
          clock: oneCallClock(),
          deadlineMilliseconds: 200,
          fetchImpl: queuedFetch(new Map([
            [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFirstBody }]],
            [chromeContinuationUrl, [{ status: 200, body: chromeContinuationBody }]],
            ...vendorResponses.map(([url, body]) => [url, [{ status: 200, body }]]),
          ]), []),
          stageImpl: async (path, contents, operation) => {
            if (firstTemporary === undefined) {
              const staged = await stage(path, contents, operation);
              firstTemporary = staged.temporary;
              return staged;
            }
            laterStageBlocked = true;
            equal(existsSync(firstTemporary), true, "First source scratch exists when later staging blocks");
            return new Promise(() => {});
          },
        }),
        new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("acquireTargets remained pending")), 1000); }),
      ]), "Evidence operation deadline expired", "Acquire targets deadline rejects blocked later staging");
    } finally {
      clearTimeout(watchdog);
    }
    equal(laterStageBlocked, true, "Acquisition reached later staging after first source was staged");
    equal(existsSync(firstTemporary), false, "Acquisition deadline removes earlier source scratch before rejection");
    equal(existsSync(absolute(stagedThenBlockedRoot, sourceConfigurations.Chrome.artifact)), false, "Acquisition deadline does not commit staged source");

    const acquisitionRoot = resolve(dir, "acquisition");
    const acquisitionCalls = [];
    await acquireTargets({ repoRoot: acquisitionRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFirstBody }]],
      [chromeContinuationUrl, [
        { status: 400, body: retryableChromeError },
        { status: 400, body: retryableChromeError },
        { status: 200, body: chromeContinuationBody },
      ]],
      ...vendorResponses.map(([url, body]) => [url, [{ status: 200, body }]]),
    ]), acquisitionCalls) });
    for (const product of productNames) {
      const artifact = await readJson(acquisitionRoot, sourceConfigurations[product].artifact);
      equal(artifact.retrievedAt, retrievedAt, `${product} acquisition timestamp`);
    }
    const acquiredChrome = await readJson(acquisitionRoot, sourceConfigurations.Chrome.artifact);
    equal(acquisitionCalls.filter((url) => url === chromeContinuationUrl).length, 3, "Chrome continuation retries exact URL");
    equal(acquiredChrome.source.responseCount, 2, "Chrome retryable failures are excluded from response count");
    equal(acquiredChrome.source.responseSha256, "4ad02dbc8acdae5900950d5e361c41739e8810fb983058abaa2c6796d895a2db", "Chrome retryable failures are excluded from response hash");

    const exhaustedRoot = resolve(dir, "chrome-retry-exhausted");
    const exhaustionCalls = [];
    await expectThrows(() => acquireTargets({ repoRoot: exhaustedRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFullFirstBody }]],
      [chromeContinuationUrl, Array.from({ length: 6 }, () => ({ status: 400, body: retryableChromeError }))],
    ]), exhaustionCalls) }), "Chrome full-page retry exhaustion makes no writes");
    equal(exhaustionCalls.filter((url) => url === chromeContinuationUrl).length, 6, "Chrome full-page continuation stops after six physical attempts");
    equal(existsSync(exhaustedRoot), false, "Chrome full-page retry exhaustion performs no writes");

    const differentErrorRoot = resolve(dir, "chrome-continuation-different-error");
    const differentErrorCalls = [];
    await expectThrows(() => acquireTargets({ repoRoot: differentErrorRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFullFirstBody }]],
      [chromeContinuationUrl, [{ status: 200, body: chromeTerminalBody }]],
      [chromeTerminalUrl, [{ status: 400, body: differentChromeError }]],
    ]), differentErrorCalls) }), "Chrome different terminal error makes no writes");
    equal(differentErrorCalls.filter((url) => url === chromeTerminalUrl).length, 1, "Chrome different terminal error is not retried");
    equal(existsSync(differentErrorRoot), false, "Chrome different terminal error performs no writes");

    const non400Root = resolve(dir, "chrome-continuation-non-400");
    const non400Calls = [];
    await expectThrows(() => acquireTargets({ repoRoot: non400Root, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFirstBody }]],
      [chromeContinuationUrl, [{ status: 500, body: "server failure" }]],
    ]), non400Calls) }), "Chrome non-400 continuation fails without retry");
    equal(non400Calls.filter((url) => url === chromeContinuationUrl).length, 1, "Chrome non-400 continuation is not retried");
    equal(existsSync(non400Root), false, "Chrome non-400 continuation performs no writes");

    const repeatedTokenRoot = resolve(dir, "chrome-repeated-token");
    await expectThrows(() => acquireTargets({ repoRoot: repeatedTokenRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFullFirstBody }]],
      [chromeContinuationUrl, [{ status: 200, body: JSON.stringify({ releases: [], nextPageToken: "continuation token" }) }]],
    ]), []) }), "Chrome repeated token makes no writes");
    equal(existsSync(repeatedTokenRoot), false, "Chrome repeated token performs no writes");

    const validationRoot = resolve(dir, "chrome-validation-error");
    await expectThrows(() => acquireTargets({ repoRoot: validationRoot, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: queuedFetch(new Map([
      [sourceConfigurations.Chrome.url, [{ status: 200, body: chromeFirstBody }]],
      [chromeContinuationUrl, [{ status: 200, body: JSON.stringify({ releases: [{ fraction: 1, name: "chrome-invalid", version: "invalid", serving: { startTime: "2026-09-09T00:00:00.000Z" } }] }) }]],
      ...vendorResponses.map(([url, body]) => [url, [{ status: 200, body }]]),
    ]), []) }), "Chrome validation error makes no writes");
    equal(existsSync(validationRoot), false, "Chrome validation error performs no writes");
    const chrome = normalizeChromePayloads([{ releases: [
      { fraction: 1, name: "a", version: "120.0", serving: { startTime: "2026-09-10T00:00:00.000Z" } },
      { fraction: 1, name: "b", version: "120.0", serving: { startTime: "2026-09-09T00:00:00.000Z" } },
      { fraction: 1, name: "c", version: "117.0", serving: { startTime: "2026-09-08T00:00:00.000Z" } },
      { fraction: 1, name: "d", version: "111.0", serving: { startTime: "2026-09-07T00:00:00.000Z" } },
      { fraction: 0, name: "ignored", version: "999.0", serving: { startTime: "2026-09-10T00:00:00.000Z" } },
    ] }], retrievedAt);
    equal(chrome.find((entry) => entry.exactVersion === "120.0").sourceReleaseIds.join(","), "a,b", "Chrome duplicate grouping");
    const edge = normalizeEdgePayload([{ Product: "Stable", Releases: [
      { Platform: "Windows", Architecture: "x64", ReleaseId: 1, ProductVersion: "120.0", PublishedTime: "2026-09-10T01:02:03" },
      { Platform: "Windows", Architecture: "x64", ReleaseId: 2, ProductVersion: "117.0", PublishedTime: "2026-09-09T01:02:03" },
      { Platform: "Windows", Architecture: "x64", ReleaseId: 3, ProductVersion: "111.0", PublishedTime: "2026-09-08T01:02:03" },
    ] }], retrievedAt);
    equal(edge[0].releasedAt, "2026-09-10T01:02:03.000Z", "Edge timezone normalization");
    const firefox = normalizeFirefoxPayload({ "120.0": "2026-09-10", "117.0": "2026-09-09", "111.0": "2026-09-08", ESR: "2026-09-01" }, retrievedAt);
    equal(firefox[0].releasedAt, "2026-09-10T00:00:00.000Z", "Firefox UTC midnight normalization");
    const safari = normalizeSafariPayload(Buffer.from(`<!doctype html><table><thead><tr><th>Name <span>and</span> information&nbsp;link</th><th>Available for</th><th>Release date</th></tr></thead><tbody><tr><td>Safari 120.0</td><td>x &amp; &#65; &#x41;</td><td>10 Sep 2026</td></tr><tr><td>Safari 120.0</td><td>x</td><td>10 Sep 2026</td></tr><tr><td>Safari 117.0</td><td>x</td><td>09 Sep 2026</td></tr><tr><td>Safari 111.0</td><td>x</td><td>08 Sep 2026</td></tr></tbody></table>`), retrievedAt);
    equal(safari.length, 3, "Safari duplicate collapse");
    await expectThrows(() => Promise.resolve(normalizeSafariPayload(Buffer.from(`<table><tr><th>Name and information link</th><th>Available for</th><th>Release date</th></tr><tr><td>Safari 120.0</td><td>x</td><td>10 Sep 2026</td></tr><tr><td>Safari 120.0</td><td>x</td><td>11 Sep 2026</td></tr></table>`), retrievedAt)), "Safari conflicting duplicate dates");
    const selection = deriveTargets({ ...syntheticSource("Chrome", "2026-09-13", retrievedAt), releases: [
      { sourceReleaseIds: ["x"], exactVersion: "120.0", major: 120, releasedAt: "2026-09-10T00:00:00.000Z" },
      { sourceReleaseIds: ["y"], exactVersion: "117.0", major: 117, releasedAt: "2026-09-09T00:00:00.000Z" },
      { sourceReleaseIds: ["z"], exactVersion: "111.0", major: 111, releasedAt: "2026-09-08T00:00:00.000Z" },
    ] }, sourceConfigurations.Chrome.artifact, "b".repeat(64));
    equal(selection.previous.major, 117, "Nonadjacent previous major selection");
    const before = existsSync(absolute(dir, matrixPath));
    await expectThrows(() => acquireTargets({ repoRoot: dir, releaseDate: "2026-09-13", clock: oneCallClock(), fetchImpl: async () => ({ status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) }), "campaign fetch failure has no write");
    equal(existsSync(absolute(dir, matrixPath)), before, "campaign failure leaves matrix absent");
    await expectThrows(() => acquireTargets({ repoRoot: dir, releaseDate: "2026-09-13", clock: oneCallClock(), deadlineMilliseconds: 1, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) }), "deadline leaves no campaign writes");
    await expectThrows(() => Promise.resolve(mappingFor("Chrome", "current", "windows-edge-current")), "closed mapping rejects wrong environment");
    await createSyntheticCampaign(dir);
    const futureMatrixPath = absolute(dir, matrixPath);
    const futureMatrix = json((await readFile(futureMatrixPath)).toString("utf8"), "future matrix");
    futureMatrix.rows = futureMatrix.rows.filter((row) => row.product !== "Chrome" || row.slot !== "current");
    await writeAtomic(futureMatrixPath, jsonText(futureMatrix));
    const futureSmokePath = absolute(dir, browserMappings["Chrome/current"].smoke);
    const futureSmoke = json((await readFile(futureSmokePath)).toString("utf8"), "future smoke");
    futureSmoke.testedAt = "2026-09-13T12:00:00.001Z";
    await writeAtomic(futureSmokePath, jsonText(futureSmoke));
    await expectThrows(() => recordPass({ repoRoot: dir, releaseDate: "2026-09-13", product: "Chrome", slot: "current", environment: "windows-chrome-current", evidence: browserMappings["Chrome/current"].smoke, clock: oneCallClock() }), "record-pass rejects timestamp later than operation clock");
    const futureAccessibilityPath = absolute(dir, "test/e2e/evidence/accessibility/screen-reader.json");
    const futureAccessibility = json((await readFile(futureAccessibilityPath)).toString("utf8"), "future accessibility receipt");
    futureAccessibility.testedAt = "2026-09-13T12:00:00.001Z";
    await writeAtomic(futureAccessibilityPath, jsonText(futureAccessibility));
    await expectThrows(() => recordAccessibility({ repoRoot: dir, releaseDate: "2026-09-13", category: "screen-reader", evidence: "test/e2e/evidence/accessibility/screen-reader.json", clock: oneCallClock() }), "record-accessibility rejects timestamp later than operation clock");
    await producerEngineSelfTest(resolve(dir, "engine"), oneCallClock);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "self-test" && args.length === 0) return browserSelfTest();
  if (command === "acquire-targets") {
    const input = options(args, ["--release-date"]);
    await acquireTargets({ releaseDate: input["--release-date"] });
    return;
  }
  if (command === "capture") {
    const input = options(args, ["--release-date", "--product", "--slot", "--environment", "--executable-env"]);
    if (input["--executable-env"] === undefined) fail("Missing required option: --executable-env");
    await captureBrowser({ releaseDate: input["--release-date"], product: input["--product"], slot: input["--slot"], environment: input["--environment"], executableEnv: input["--executable-env"] });
    return;
  }
  if (command === "capture-safari") {
    const input = options(args, ["--release-date", "--slot", "--environment"]);
    await captureSafari({ releaseDate: input["--release-date"], slot: input["--slot"], environment: input["--environment"] });
    return;
  }
  if (command === "record-pass") {
    const input = options(args, ["--release-date", "--product", "--slot", "--environment", "--evidence"]);
    await recordPass({ releaseDate: input["--release-date"], product: input["--product"], slot: input["--slot"], environment: input["--environment"], evidence: input["--evidence"] });
    return;
  }
  if (command === "record-safari-unavailable") {
    const input = options(args, ["--release-date", "--slot", "--environment", "--evidence"]);
    await recordSafariUnavailable({ releaseDate: input["--release-date"], slot: input["--slot"], environment: input["--environment"], evidence: input["--evidence"] });
    return;
  }
  if (command === "record-engine") {
    const input = options(args, ["--release-date", "--project"]);
    await recordEngine({ releaseDate: input["--release-date"], project: input["--project"] });
    return;
  }
  if (command === "record-accessibility") {
    const input = options(args, ["--release-date", "--category", "--evidence"]);
    await recordAccessibility({ releaseDate: input["--release-date"], category: input["--category"], evidence: input["--evidence"] });
    return;
  }
  fail("Usage: browser-evidence.mjs self-test | acquire-targets | capture | capture-safari | record-pass | record-safari-unavailable | record-engine | record-accessibility");
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
