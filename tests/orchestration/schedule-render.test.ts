import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderUnits, showSchedule, unitNames } from "../../src/lib/server/orchestration/schedule-render.ts";
import { scheduledCommand } from "../../src/lib/server/orchestration/schedule-environment.ts";
import { Schema } from "effect";
import { PeriodSchema } from "../../src/lib/server/profile/schedule-period.ts";

const root = "/tmp/pulse-port-oracle/basic-run/installation";
const command = ["/synthetic/bin/uv", "run", "--project", root, "python", "-m", "pulse.cli.pulse", "--profile", "invented", "run-scheduled"];
const fixture = (name: string) => readFileSync(`tests/oracle/basic-run/schedule/${name}`, "utf8");

describe.skipIf(process.platform === "win32")("systemd schedule rendering", () => {
  for (const number of [1, 2, 3]) {
    it(`matches legacy show and unit goldens ${number}, with only the TS launcher changed in the preview`, () => {
      const period = Schema.decodeUnknownSync(Schema.parseJson(PeriodSchema))(fixture(`period-${number}.json`));
      const input = { period, resolvedRoot: root, profileId: "invented", command };
      const tsCommand = scheduledCommand(root, input.profileId);

      expect(showSchedule(input, "2026-10-21T12:00:00Z")).toBe(fixture(`show-${number}.txt`));
      const legacyUnits = renderUnits(input);
      const tsUnits = renderUnits({ ...input, command: tsCommand });
      const names = unitNames(root, input.profileId);
      expect(Object.keys(tsUnits)).toEqual(names);

      for (const name of names) {
        const legacy = fixture(`period-${number}/${name}`);
        expect(legacyUnits[name]).toBe(legacy);
        const legacyLaunch = command.map((part) => JSON.stringify(part)).join(" ");
        const tsLaunch = tsCommand.map((part) => JSON.stringify(part)).join(" ");
        expect(tsUnits[name]).toBe(legacy.replace(`ExecStart=${legacyLaunch}`, () => `ExecStart=${tsLaunch}`));
      }
    });
  }

  it("matches the CLI show golden with its legacy argv", () => {
    const period = Schema.decodeUnknownSync(Schema.parseJson(PeriodSchema))(fixture("period-1.json"));
    const golden = Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ stdout: Schema.String })))(readFileSync("tests/oracle/basic-run/cli/operations/schedule-show.json", "utf8"));
    expect(`${showSchedule({ period, resolvedRoot: root, profileId: "invented", command }, "2026-10-21T12:00:00Z")}\n`).toBe(golden.stdout);
  });
  it("escapes unit arguments and rejects unsafe input", () => {
    const period = Schema.decodeUnknownSync(Schema.parseJson(PeriodSchema))(fixture("period-1.json"));
    const input = { period, resolvedRoot: '/tmp/a %$"', profileId: "person", command: ["/bin/test", 'a %$"\\'] };
    const units = renderUnits(input);
    expect(Object.values(units)[0]).toContain('"a %%$$\\"\\\\"');
    expect(() => renderUnits({ ...input, command: ["relative"] })).toThrow();
    expect(() => renderUnits({ ...input, command: ["/bin/test", "bad\n"] })).toThrow();
    expect(() => unitNames(root, "../bad")).toThrow();
  });
});
