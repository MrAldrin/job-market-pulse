import { syntheticServeOrigin } from "../shared/serve-hosts.ts";

// Playwright loads specs in Node; keep Bun snapshot fixtures out of these imports.
export const b8Origin = "http://127.0.0.1:4176";
export const hostedSettingsOrigin = "http://localhost:4178";
export const localSettingsOrigin = "http://127.0.0.1:4179";
export const serveProxy = "http://127.0.0.1:4180";
export const serveOrigin = syntheticServeOrigin;
export const serveOwner = "owner@invented.test";
