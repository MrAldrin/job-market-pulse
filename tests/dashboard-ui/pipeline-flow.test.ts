import { readFileSync } from "node:fs";
import { Either } from "effect";
import { expect, test } from "vitest";
import { decodeSnapshotBytes, type SnapshotV4 } from "../../src/lib/contracts/snapshot.ts";
import { capturedPipelineSteps } from "../../src/lib/pipeline-flow.ts";
import { examplePersonalInputs, exampleSettings } from "../snapshot/settings-fixture.ts";

const base = Either.getOrThrow(decodeSnapshotBytes(readFileSync("contracts/fixtures/snapshot.example.json")));
const coreSteps = ["source", "locations", "filters", "screen", "judge", "snapshot"];

test("only captured enablement adds optional steps", () => {
  const v4: SnapshotV4 = {
    ...base, schema_version: 4, personal_inputs: examplePersonalInputs, settings: exampleSettings,
  };

  expect(capturedPipelineSteps(base)).toEqual(coreSteps);
  expect(capturedPipelineSteps({ ...base, schema_version: 2, market_history: null })).toEqual(coreSteps);
  expect(capturedPipelineSteps({ ...base, schema_version: 3, settings: { ...exampleSettings, notifications_enabled: true } })).toEqual([...coreSteps, "alerts"]);
  expect(capturedPipelineSteps(v4)).toEqual(coreSteps);
  expect(capturedPipelineSteps({ ...v4, settings: {
    ...v4.settings, rejudge: { levels: [], same_as_judge: false }, notifications_enabled: false,
  } })).toEqual(coreSteps);
  expect(capturedPipelineSteps({ ...v4, settings: {
    ...v4.settings, rejudge: { levels: ["strong"], same_as_judge: true }, notifications_enabled: true,
  } })).toEqual(["source", "locations", "filters", "screen", "judge", "rejudge", "snapshot", "alerts"]);
});
