# Fixed Oslo utility interface

Profile and orchestration use `Europe/Oslo`, not a fixed UTC offset or the host time zone. Local calendar and display calculations follow Oslo daylight-saving rules. See `src/lib/server/shared/` and the Effect Clock adapter in `src/lib/server/clock.ts`.

This utility does not read private settings or stores, use the network or change the host time zone. It is not a wire document. See [profile policy](../docs/pipeline/profiles.md#policy) and `tests/foundation/clock.test.ts`.
