import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

type EngineVersionObservation = {
  releaseDate: string;
  testedAt: string;
  runToken: string;
  project: "chromium" | "firefox" | "webkit";
  exactVersion: string;
};

const observationPaths = {
  chromium: "test/e2e/evidence/engine/chromium-version-observation.json",
  firefox: "test/e2e/evidence/engine/firefox-version-observation.json",
  webkit: "test/e2e/evidence/engine/webkit-version-observation.json",
} as const;
const runToken = process.env.CFPB_ENGINE_RUN_TOKEN;

if (runToken !== undefined) {
  test("records browser.version() for record-engine", async ({ browser }, testInfo) => {
    expect(runToken).toMatch(/^[0-9a-f]{64}$/);
    expect(testInfo.project.name).toBe(process.env.CFPB_ENGINE_PROJECT);
    expect(Object.hasOwn(observationPaths, testInfo.project.name)).toBe(true);
    const project = testInfo.project.name as keyof typeof observationPaths;
    const outputPath = process.env.CFPB_ENGINE_OBSERVATION_PATH ?? "";
    expect(resolve(outputPath)).toBe(resolve(observationPaths[project]));
    const exactVersion = browser.version();
    expect(exactVersion).toMatch(/^(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/);
    const observation = {
      releaseDate: process.env.CFPB_RELEASE_DATE ?? "",
      testedAt: process.env.CFPB_ENGINE_TESTED_AT ?? "",
      runToken,
      project,
      exactVersion,
    } satisfies EngineVersionObservation;
    const body = `${JSON.stringify({ schemaVersion: 1, observations: [observation] })}\n`;
    const temporary = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx" });
    await rename(temporary, outputPath);
    testInfo.annotations.push({
      type: "cfpb-engine-observation",
      description: JSON.stringify(observation),
    });
  });
}
