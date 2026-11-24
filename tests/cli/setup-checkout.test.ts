import { expect, test, vi } from "vitest";
import { readNodeVersion } from "../../src/cli/checkout-toolchain.ts";
import { runCheckoutSetup } from "../../src/cli/setup-checkout.ts";

const install = ["install", "--frozen-lockfile"];
const build = ["run", "build"];
const doctor = ["src/cli/pulse.ts", "doctor"];
const init = ["src/cli/pulse.ts", "init"];

function fakeHost({ interactive = true, bunVersion = "1.4.4", node = "22.17.0", codes = [0, 0, 1, 0] }: {
  interactive?: boolean;
  bunVersion?: string;
  node?: string | null;
  codes?: readonly number[];
} = {}) {
  const results = codes.values();

  return {
    interactive, bunVersion, nodeVersion: vi.fn(async () => node), error: vi.fn(),
    run: vi.fn(async (_args: readonly string[]) => results.next().value ?? 0),
  };
}

test.each([0, 1])("setup runs the checkout steps in order when Doctor exits %i", async (code) => {
  const host = fakeHost({ codes: [0, 0, code, 0] });
  expect(await runCheckoutSetup(host)).toBe(0);
  expect(host.run.mock.calls.map(([args]) => args)).toEqual([install, build, doctor, init]);
  expect(host.error).not.toHaveBeenCalled();
});

test.each([
  [[17], [install], 17],
  [[0, 18], [install, build], 18],
  [[0, 0, 2], [install, build, doctor], 2],
  [[0, 0, 1, 130], [install, build, doctor, init], 130],
] as const)("setup stops or returns the failure for child statuses %j", async (codes, calls, exitCode) => {
  const host = fakeHost({ codes });
  expect(await runCheckoutSetup(host)).toBe(exitCode);
  expect(host.run.mock.calls.map(([args]) => args)).toEqual(calls);
});

test.each([null, "18.19.1", "22.16.9", "22.17.0-rc.1"])("setup refuses Node.js %s before installing anything", async (node) => {
  const host = fakeHost({ node });
  expect(await runCheckoutSetup(host)).toBe(1);
  expect(host.run).not.toHaveBeenCalled();
  expect(host.error).toHaveBeenCalledWith(expect.stringContaining("put it on PATH"));
});

test("reads version output from the chosen executable", async () => {
  expect(await readNodeVersion(process.execPath)).toBe(Bun.version);
  expect(await readNodeVersion(null)).toBeNull();
});

test("setup accepts a later stable Node.js", async () => {
  expect(await runCheckoutSetup(fakeHost({ node: "26.13.1" }))).toBe(0);
});

test.each([
  [{ interactive: false }, "in a terminal"],
  [{ bunVersion: "1.4.3" }, "Bun 1.4.4"],
] as const)("setup refuses %j before probing Node.js or installing anything", async (options, fix) => {
  const host = fakeHost(options);
  expect(await runCheckoutSetup(host)).toBe(1);
  expect(host.nodeVersion).not.toHaveBeenCalled();
  expect(host.run).not.toHaveBeenCalled();
  expect(host.error).toHaveBeenCalledWith(expect.stringContaining(fix));
});
