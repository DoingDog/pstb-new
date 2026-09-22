import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  accessibilityAggregate,
  accessibilityCategories,
  accessibilityPath,
  browserMappings,
  browserMatrix,
  brandedRow,
  canonicalTimestamp,
  captureReceipt,
  contextFor,
  createSyntheticCampaign,
  deriveTargets,
  engineMappings,
  engineMatrixRow,
  engineObservationArtifact,
  engineReceipt,
  matrixPath,
  matrixTarget,
  manualReceipt,
  root,
  sha256,
  smokeReceipt,
  sourceArtifact,
  unavailableReceipt,
  validateEngineReporter,
} from "./browser-evidence.mjs";

function fail(message) {
  throw new Error(message);
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

function absolute(repoRoot, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
    fail("Evidence artifact path is not in-tree POSIX path");
  }
  const output = resolve(repoRoot, path);
  const check = relative(repoRoot, output);
  if (check.startsWith("..") || isAbsolute(check)) fail("Evidence artifact escapes repository root");
  return output;
}

async function bytes(repoRoot, path) {
  return readFile(absolute(repoRoot, path));
}

async function object(repoRoot, path) {
  return json((await bytes(repoRoot, path)).toString("utf8"), path);
}

function sourcePath(product) {
  const mapping = Object.values(browserMappings).find((entry) => entry.product === product);
  if (mapping === undefined) fail(`Missing source mapping for ${product}`);
  return mapping.sourceArtifact;
}

function tupleKey(mapping) {
  return `${mapping.product}/${mapping.slot}`;
}

function targetFor(matrix, mapping) {
  const matches = matrix.targets.filter((target) => target.product === mapping.product && target.slot === mapping.slot);
  if (matches.length !== 1) fail(`Matrix has not exactly one target for ${tupleKey(mapping)}`);
  return matches[0];
}

function rowFor(matrix, mapping) {
  const matches = matrix.rows.filter((row) => row?.product === mapping.product && row?.slot === mapping.slot);
  if (matches.length !== 1) fail(`Matrix has not exactly one row for ${tupleKey(mapping)}`);
  return matches[0];
}

function assertHash(reference, body, name) {
  if (reference.sha256 !== sha256(body)) fail(`${name} hash does not match artifact bytes`);
}

function clockTimestamp(clock) {
  const value = clock();
  if (!Number.isFinite(value)) fail("Verifier clock must return a finite timestamp");
  return new Date(value).toISOString();
}

async function sourcesAndTargets(repoRoot, matrix, context) {
  const output = {};
  for (const product of ["Chrome", "Edge", "Firefox", "Safari"]) {
    const path = sourcePath(product);
    const body = await bytes(repoRoot, path);
    const artifact = sourceArtifact(json(body.toString("utf8"), path), path, product, matrix.releaseDate, context);
    output[product] = {
      artifact,
      body,
      targets: deriveTargets(artifact, path, sha256(body)),
    };
  }
  return output;
}

function assertDerivedTargets(matrix, sources) {
  if (matrix.targets.length !== 8) fail("Matrix must have exactly eight derived targets");
  const unique = new Set();
  for (const mapping of Object.values(browserMappings)) {
    const target = targetFor(matrix, mapping);
    const key = tupleKey(mapping);
    if (unique.has(key)) fail("Matrix repeats branded target tuple");
    unique.add(key);
    matrixTarget(target, `matrix target ${key}`, mapping, sources[mapping.product].targets[mapping.slot]);
  }
}

async function verifyPassedRow(repoRoot, row, mapping, target, context) {
  const captureBody = await bytes(repoRoot, mapping.capture);
  assertHash(row.captureReceipt, captureBody, `${tupleKey(mapping)} capture receipt`);
  const capture = captureReceipt(json(captureBody.toString("utf8"), mapping.capture), mapping.capture, mapping, target, context);
  const smokeBody = await bytes(repoRoot, mapping.smoke);
  assertHash(row.smokeReceipt, smokeBody, `${tupleKey(mapping)} smoke receipt`);
  const smoke = smokeReceipt(json(smokeBody.toString("utf8"), mapping.smoke), mapping.smoke, mapping, target, capture, sha256(captureBody), context);
  if (row.capturedAt !== capture.capturedAt || row.testedAt !== smoke.testedAt) fail(`${tupleKey(mapping)} matrix chronology differs from immutable receipts`);
  if (row.targetMajor !== target.major || row.observedVersion !== target.exactVersion) fail(`${tupleKey(mapping)} matrix target fields differ from derived target`);
  if (smoke.checks.some((check) => check.status !== "passed")) fail(`${tupleKey(mapping)} smoke contains a failed check`);
  if (Date.parse(capture.capturedAt) > Date.parse(smoke.testedAt)) fail(`${tupleKey(mapping)} smoke chronology is reversed`);
}

async function verifyUnavailableRow(repoRoot, row, mapping, target, context) {
  if (mapping.product !== "Safari") fail("Only Safari may be unavailable");
  for (const path of [mapping.capture, mapping.smoke]) {
    if (existsSync(absolute(repoRoot, path))) fail(`${tupleKey(mapping)} unavailable row coexists with pass receipt`);
  }
  const body = await bytes(repoRoot, mapping.unavailable);
  assertHash(row.unavailableReceipt, body, `${tupleKey(mapping)} unavailable receipt`);
  const receipt = unavailableReceipt(json(body.toString("utf8"), mapping.unavailable), mapping.unavailable, mapping, target, context);
  if (row.testedAt !== receipt.testedAt || row.targetMajor !== target.major) fail(`${tupleKey(mapping)} unavailable row differs from receipt`);
}

async function verifyBrandedRows(repoRoot, matrix, sources, context) {
  if (matrix.rows.length !== 8) fail("Matrix must contain exactly eight branded rows");
  for (const mapping of Object.values(browserMappings)) {
    const target = targetFor(matrix, mapping);
    const row = rowFor(matrix, mapping);
    brandedRow(row, `matrix row ${tupleKey(mapping)}`, mapping, target, context);
    if (mapping.product !== "Safari" && row.status !== "passed") fail(`${tupleKey(mapping)} must be passed branded evidence`);
    if (row.status === "passed") await verifyPassedRow(repoRoot, row, mapping, target, context);
    else await verifyUnavailableRow(repoRoot, row, mapping, target, context);
  }
}

async function verifyEngineCoverage(repoRoot, matrix, context) {
  if (matrix.engineCoverage.length !== 3) fail("Matrix must contain exactly three engine coverage rows");
  const seen = new Set();
  for (const project of Object.keys(engineMappings)) {
    const rows = matrix.engineCoverage.filter((row) => row?.project === project);
    if (rows.length !== 1) fail(`Matrix has not exactly one engine row for ${project}`);
    if (seen.has(project)) fail("Matrix repeats engine project");
    seen.add(project);
    const mapping = engineMappings[project];
    const reportBody = await bytes(repoRoot, mapping.report);
    const observationBody = await bytes(repoRoot, mapping.observation);
    const receiptBody = await bytes(repoRoot, mapping.receipt);
    const receipt = engineReceipt(json(receiptBody.toString("utf8"), mapping.receipt), mapping.receipt, project, context.releaseDate, context, sha256(reportBody), sha256(observationBody));
    const report = validateEngineReporter(json(reportBody.toString("utf8"), mapping.report), project, context.releaseDate, receipt.testedAt, receipt.runToken, repoRoot);
    const observation = engineObservationArtifact(json(observationBody.toString("utf8"), mapping.observation), mapping.observation, context.releaseDate, project, context, receipt.runToken).observations[0];
    if (JSON.stringify(report.sentinel) !== JSON.stringify(observation)) fail(`${project} reporter annotation differs from observation artifact`);
    if (receipt.exactVersion !== observation.exactVersion || receipt.testedAt !== observation.testedAt || receipt.runToken !== observation.runToken) {
      fail(`${project} receipt differs from observation artifact`);
    }
    if (receipt.suite.total !== report.flattened.length || receipt.suite.passed !== report.flattened.length) fail(`${project} receipt test totals differ from reporter`);
    engineMatrixRow(rows[0], `matrix engine row ${project}`, project, receipt, sha256(receiptBody));
  }
}

async function verifyAccessibility(repoRoot, matrix, context) {
  const aggregate = accessibilityAggregate(await object(repoRoot, accessibilityPath), accessibilityPath, matrix.releaseDate);
  if (aggregate.releaseDate !== matrix.releaseDate) fail("Accessibility aggregate releaseDate differs from browser matrix");
  if (aggregate.rows.length !== accessibilityCategories.length) fail("Accessibility aggregate must contain all four categories");
  for (const category of accessibilityCategories) {
    const rows = aggregate.rows.filter((row) => row.category === category);
    if (rows.length !== 1) fail(`Accessibility aggregate has not exactly one ${category} row`);
    const row = rows[0];
    if (row.status !== "passed") fail(`Accessibility ${category} did not pass`);
    if (!row.evidence.startsWith("test/e2e/evidence/accessibility/")) fail(`Accessibility ${category} evidence is out of tree`);
    const receipt = manualReceipt(await object(repoRoot, row.evidence), row.evidence, matrix.releaseDate, category, context);
    for (const key of ["category", "status", "testedAt", "tester", "environment", "notes"]) {
      if (JSON.stringify(row[key]) !== JSON.stringify(receipt[key])) fail(`Accessibility ${category} aggregate differs from receipt`);
    }
  }
}

export async function verifyReleaseEvidence({ repoRoot = root, clock = Date.now } = {}) {
  const verifierNow = clockTimestamp(clock);
  const matrix = browserMatrix(await object(repoRoot, matrixPath), matrixPath);
  const context = contextFor(matrix.releaseDate, verifierNow);
  const sources = await sourcesAndTargets(repoRoot, matrix, context);
  assertDerivedTargets(matrix, sources);
  await verifyBrandedRows(repoRoot, matrix, sources, context);
  await verifyEngineCoverage(repoRoot, matrix, context);
  await verifyAccessibility(repoRoot, matrix, context);
  return matrix;
}

async function writeJson(repoRoot, path, value) {
  await writeFile(absolute(repoRoot, path), jsonText(value), "utf8");
}

async function mutate(repoRoot, path, change) {
  const value = await object(repoRoot, path);
  await change(value);
  await writeJson(repoRoot, path, value);
}

async function refreshReferenceHash(repoRoot, targetPath, referencePath, referenceKey) {
  const body = await bytes(repoRoot, targetPath);
  await mutate(repoRoot, referencePath, (value) => { value[referenceKey].sha256 = sha256(body); });
}

async function refreshChromeCaptureHashChain(repoRoot) {
  const mapping = browserMappings["Chrome/current"];
  await refreshReferenceHash(repoRoot, mapping.capture, mapping.smoke, "captureReceipt");
  const captureBody = await bytes(repoRoot, mapping.capture);
  const smokeBody = await bytes(repoRoot, mapping.smoke);
  await mutate(repoRoot, matrixPath, (matrix) => {
    const row = matrix.rows.find((entry) => entry.product === "Chrome" && entry.slot === "current");
    row.captureReceipt.sha256 = sha256(captureBody);
    row.smokeReceipt.sha256 = sha256(smokeBody);
  });
}

async function fresh(rootPath) {
  await rm(rootPath, { recursive: true, force: true });
  await createSyntheticCampaign(rootPath);
}

async function expectReject(action, name) {
  try {
    await action();
  } catch {
    return;
  }
  fail(`Verifier self-test expected rejection: ${name}`);
}

async function verifierSelfTest() {
  const directory = await mkdtemp(resolve(tmpdir(), "cfpb-release-evidence-"));
  const now = Date.parse("2026-09-13T12:00:00.000Z");
  const clock = () => now;
  const chrome = browserMappings["Chrome/current"];
  try {
    await createSyntheticCampaign(directory);
    await verifyReleaseEvidence({ repoRoot: directory, clock });

    for (const [name, change] of [
      ["wrong source product", (source) => { source.product = "Edge"; }],
      ["wrong source ID", (source) => { source.source.id = "wrong"; }],
      ["wrong source URL", (source) => { source.source.url = "https://invalid.example"; }],
      ["duplicate exact version", (source) => { source.releases.push({ ...source.releases[0], sourceReleaseIds: ["unique-repeat"] }); }],
      ["duplicate source ID", (source) => { source.releases[1].sourceReleaseIds = [...source.releases[0].sourceReleaseIds]; }],
      ["version major disagreement", (source) => { source.releases[0].major += 1; }],
      ["malformed release time", (source) => { source.releases[0].releasedAt = "not-a-time"; }],
      ["future release time", (source) => { source.releases[0].releasedAt = "2026-09-13T12:00:00.001Z"; }],
      ["fewer than three majors", (source) => { source.releases = source.releases.slice(0, 2); }],
    ]) {
      await fresh(directory);
      await mutate(directory, chrome.sourceArtifact, change);
      await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), name);
    }

    for (const [name, change] of [
      ["wrong target slot", (matrix) => { matrix.targets.find((entry) => entry.product === "Chrome" && entry.slot === "current").slot = "previous"; }],
      ["wrong target exact version", (matrix) => { matrix.targets.find((entry) => entry.product === "Chrome" && entry.slot === "current").exactVersion = "999.0"; }],
      ["wrong target source path", (matrix) => { matrix.targets.find((entry) => entry.product === "Chrome" && entry.slot === "current").sourceArtifact = "test/e2e/evidence/browser-target-sources/firefox-stable.json"; }],
      ["wrong target hash", (matrix) => { matrix.targets.find((entry) => entry.product === "Chrome" && entry.slot === "current").sourceSha256 = "0".repeat(64); }],
      ["aggregate release date disagreement", (matrix) => { matrix.releaseDate = "2026-09-14"; }],
    ]) {
      await fresh(directory);
      await mutate(directory, matrixPath, change);
      await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), name);
    }

    await fresh(directory);
    await mutate(directory, accessibilityPath, (aggregate) => { aggregate.rows[0].testedAt = "2026-09-04T12:00:00.000Z"; });
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "out-of-window timestamp");

    await fresh(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock: () => Date.parse("2026-09-05T12:00:00.000Z") }), "verifier clock outside interval");

    await fresh(directory);
    await mutate(directory, chrome.capture, (capture) => { capture.releaseDate = "2026-09-12"; });
    await refreshChromeCaptureHashChain(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "prior campaign capture releaseDate");

    await fresh(directory);
    await mutate(directory, chrome.capture, (capture) => { capture.slot = "previous"; });
    await refreshChromeCaptureHashChain(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "wrong capture branded tuple");

    await fresh(directory);
    await mutate(directory, chrome.smoke, (smoke) => { smoke.environment = "windows-chrome-previous"; });
    await refreshChromeCaptureHashChain(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "wrong smoke environment");

    await fresh(directory);
    await mutate(directory, matrixPath, (matrix) => { matrix.rows.find((row) => row.product === "Chrome" && row.slot === "current").captureReceipt.path = browserMappings["Chrome/previous"].capture; });
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "wrong matrix capture path");

    await fresh(directory);
    await mutate(directory, chrome.smoke, (smoke) => { smoke.testedAt = "2026-09-13T11:59:59.999Z"; });
    await refreshChromeCaptureHashChain(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "reversed capture smoke chronology");

    await fresh(directory);
    await mutate(directory, chrome.smoke, (smoke) => { smoke.testedAt = "2026-09-13T12:00:00.001Z"; });
    await refreshChromeCaptureHashChain(directory);
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "future timestamp after verifier clock");

    for (const [name, action] of [
      ["missing engine report", async () => rm(absolute(directory, engineMappings.chromium.report))],
      ["missing engine observation", async () => rm(absolute(directory, engineMappings.chromium.observation))],
      ["wrong engine project", async () => mutate(directory, engineMappings.chromium.report, (report) => { report.suites[0].specs[0].tests[0].projectName = "firefox"; })],
      ["wrong engine run token", async () => mutate(directory, engineMappings.chromium.report, (report) => { const annotation = report.suites[0].specs[4].tests[0].annotations[0]; const parsed = JSON.parse(annotation.description); parsed.runToken = `b${parsed.runToken.slice(1)}`; annotation.description = JSON.stringify(parsed); })],
      ["failed engine reporter test", async () => mutate(directory, engineMappings.chromium.report, (report) => { report.suites[0].specs[0].tests[0].results[0].status = "failed"; report.stats.unexpected = 1; })],
      ["duplicate engine observation", async () => mutate(directory, engineMappings.chromium.observation, (observation) => { observation.observations.push({ ...observation.observations[0] }); })],
      ["engine version disagreement", async () => mutate(directory, engineMappings.chromium.observation, (observation) => { observation.observations[0].exactVersion = "121.0"; })],
    ]) {
      await fresh(directory);
      await action();
      await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), name);
    }

    await fresh(directory);
    await mutate(directory, accessibilityPath, (aggregate) => { aggregate.rows[0].status = "failed"; });
    await expectReject(() => verifyReleaseEvidence({ repoRoot: directory, clock }), "failed manual accessibility category");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    await verifyReleaseEvidence();
    return;
  }
  if (args.length === 1 && args[0] === "--self-test") {
    await verifierSelfTest();
    return;
  }
  fail("Usage: verify-release-evidence.mjs [--self-test]");
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
