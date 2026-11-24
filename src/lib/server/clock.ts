import { Clock, DateTime, Effect, Layer, TestClock, TestContext } from "effect";

export const OSLO_ZONE = DateTime.zoneUnsafeMakeNamed("Europe/Oslo");

export const osloNow = Effect.map(Clock.currentTimeMillis, (millis) =>
  DateTime.unsafeMake(millis).pipe(DateTime.setZone(OSLO_ZONE)),
);

// Clock is Effect's resource service. Tests fix it before any service runs.
export const FixedOsloClock = Layer.effectDiscard(
  TestClock.setTime(Date.parse("2026-10-19T12:00:00Z")),
).pipe(Layer.provideMerge(TestContext.TestContext));
