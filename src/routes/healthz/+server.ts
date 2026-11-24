import { json } from "@sveltejs/kit";
import { health } from "../../lib/server/health.ts";
import { runtime } from "../../lib/server/runtime.ts";

export const GET = async () => json(await runtime.runPromise(health));
