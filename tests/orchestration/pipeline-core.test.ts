import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  completedRecord, decodeRunRecord as decodeWire, enterStage, failedStage, maximumFailures, passedStage,
  resumeWait, retryWaitMillis, sanitizedTail, stageOutcome, startDisposition, startRecord,
  type RunRecord,
} from "../../src/lib/server/orchestration/pipeline-core.ts";

const now = "2026-10-20T10:00:00+00:00";
const initial = (): RunRecord => startRecord(null, { profileId: "invented", reviewerId: "judge", runId: "a".repeat(32), reset: false, now });

const decodeRunRecord = (record: RunRecord, profileId: string) => decodeWire({ ...record, failed_attempts: BigInt(record.failed_attempts) }, profileId);

const get = <A, E>(result: Either.Either<A, E>): A => {
  if (Either.isLeft(result)) throw result.left;

  return result.right;
};

describe("local pipeline state rules", () => {
  it("resumes the same run and reviewer, and refuses reset or changed reviewer until finished", () => {
    const previous = enterStage(initial(), "review");
    expect(startDisposition(previous, null, false)).toEqual({ status: "ready", reviewerId: "judge" });
    expect(startDisposition(previous, "other", false).status).toBe("resume_required");
    expect(startDisposition(previous, null, true).status).toBe("resume_required");
    expect(startRecord(previous, { profileId: "invented", reviewerId: "other", runId: "b".repeat(32), reset: false, now })).toEqual(previous);
  });

  it("keeps one run-wide budget across stages and succeeds without resetting the count", () => {
    let record = initial();

    for (const stage of ["sync-source", "resolve-locations", "review"] as const) {
      record = get(failedStage(enterStage(record, stage), { kind: "temporary", detail: "exit 75", tail: null }, now));
      expect(record.status).toBe("waiting");
      expect(get(resumeWait(record, now))).toBe(retryWaitMillis[record.failed_attempts - 1]);
      expect(Either.isRight(decodeRunRecord(record, "invented"))).toBe(true);
    }

    record = completedRecord(passedStage(enterStage(record, "snapshot")));
    expect(record.failed_attempts).toBe(3);
    expect(get(decodeRunRecord(record, "invented"))).toEqual(record);
  });

  it("exhausts on the fourth temporary failure, and requires explicit reset", () => {
    let record = enterStage(initial(), "review");

    for (let index = 0; index < maximumFailures; index++) {
      record = get(failedStage(enterStage(record, "review"), { kind: "temporary", detail: "timeout", tail: null }, now));
    }

    expect(record).toMatchObject({ status: "exhausted", failed_attempts: 4, next_attempt_at: null });
    expect(startDisposition(record, null, false)).toEqual({ status: "previous_stopped", exitCode: 1 });
    const reset = startRecord(record, { profileId: "invented", reviewerId: "judge", runId: "b".repeat(32), reset: true, now });
    expect(reset).toMatchObject({ run_id: "b".repeat(32), previous_run_id: record.run_id, reset_at: now, failed_attempts: 0 });
  });

  it("clamps saved waits, rejects more than five hours, and keeps microseconds", () => {
    const waiting = get(failedStage(enterStage(initial(), "review"), { kind: "temporary", detail: "exit 75", tail: null }, "2026-10-20T10:00:00.123456+00:00"));
    expect(waiting.next_attempt_at).toBe("2026-10-20T10:05:00.123456+00:00");
    expect(get(resumeWait({ ...waiting, next_attempt_at: "2026-10-20T12:00:00+00:00" }, now))).toBe(300_000);
    expect(Either.isLeft(resumeWait({ ...waiting, next_attempt_at: "2026-10-20T15:00:00.000001+00:00" }, now))).toBe(true);
    expect(get(resumeWait(waiting, "2026-10-20T11:00:00+00:00"))).toBe(0);
  });

  it("rejects malformed, cross-profile and inconsistent state without guessing", () => {
    for (const value of [null, [], { ...initial(), unknown: true }, { ...initial(), failed_attempts: 1.5 }, { ...initial(), status: "completed" }, { ...initial(), status: "waiting", failed_attempts: 0 }, { ...initial(), reset_at: now }]) {
      expect(Either.isLeft(decodeWire(value, "invented"))).toBe(true);
    }

    expect(Either.isLeft(decodeRunRecord(initial(), "different"))).toBe(true);
  });

  it("treats invalid resolver output and ordinary exits as permanent, not retryable", () => {
    expect(stageOutcome({ returncode: 0, stdout: "bad", stderr: "" }, () => false)).toMatchObject({ kind: "permanent", detail: "invalid output" });
    expect(stageOutcome({ returncode: 2, stdout: "", stderr: "safe reason" })).toEqual({ kind: "permanent", detail: "exit 2", tail: "safe reason" });
    expect(stageOutcome({ returncode: 75, stdout: "", stderr: "" }).kind).toBe("temporary");
  });

  it("redacts bounded child tails before persistence", () => {
    const tail = sanitizedTail("old\nline 1\nline 2\nBearer private-token\ntoken=private\n/home/person/private\n\u001b[31mreason");
    expect(tail).not.toContain("private");
    expect(tail).not.toContain("\u001b");
    expect(tail.split("\n").length).toBeLessThanOrEqual(5);
    fc.assert(fc.property(fc.string({ maxLength: 2000 }), (value) => sanitizedTail(value).length <= 400));
  });
});
