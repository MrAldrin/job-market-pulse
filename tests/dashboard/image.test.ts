import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("deploy/railway/Dockerfile", "utf8");
const runtime = dockerfile.split("FROM oven/bun:1.4.4 AS runtime\n")[1] ?? "";

describe("Railway image packaging", () => {
  it("pins every stage and installs from the frozen lockfile", () => {
    const stages = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(stages).toHaveLength(4);
    expect(stages.every((stage) => /^FROM (oven\/bun:1\.4\.4|dependencies) AS /.test(stage))).toBe(true);
    expect(dockerfile.match(/bun install --frozen-lockfile/g)).toHaveLength(2);
    expect(dockerfile).toContain("bun run build");
  });

  it("allows only adapter output, production dependencies and package metadata at runtime", () => {
    expect(runtime.match(/^COPY .+$/gm)).toEqual([
      "COPY --from=build /app/build/ ./build/",
      "COPY --from=production-dependencies /app/node_modules/ ./node_modules/",
      "COPY --from=build /app/package.json ./package.json",
    ]);
    expect(runtime).toContain("PULSE_DASHBOARD_MODE=railway");
    expect(runtime).toContain("PULSE_DATA_DIR=/data");
    expect(runtime).toContain("HOST=0.0.0.0");
    expect(runtime).toContain("chown 10001:10001 /data");
    expect(runtime).toContain("USER 10001:10001");
    expect(runtime).toContain('CMD ["bun", "build/index.js"]');
  });

  it("keeps the Railway health check and excludes private data from the build context", () => {
    const railway = readFileSync("deploy/railway/railway.toml", "utf8");
    const ignore = readFileSync(".dockerignore", "utf8");
    expect(railway).toContain('healthcheckPath = "/healthz"');
    expect(ignore.startsWith("**\n")).toBe(true);
    expect(ignore).toContain("**/*.sqlite");
    expect(ignore).toContain("**/.env.*");
    expect(ignore).not.toContain("!local_only/");
    expect(ignore).not.toMatch(/^!resources\/.*\*/m);
  });
});
