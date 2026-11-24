import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { checkoutBuildFingerprint, stampCheckoutBuild } from "./src/lib/server/dashboard/checkout-build.ts";

const dashboardOptions: NonNullable<Parameters<typeof adapter>[0]> = {
  serverOptions: { hostname: "127.0.0.1", port: 8770, idleTimeout: 5 },
};

if (process.env.PULSE_BUILD_APPIMAGE === "1") {
  dashboardOptions.out = "local_only/package-linux/dashboard";
  dashboardOptions.buildOptions = { compile: { autoloadDotenv: false, autoloadBunfig: false } };
} else if (process.env.PULSE_BUILD_WINDOWS === "1") {
  dashboardOptions.out = "local_only/package-windows/dashboard";
  dashboardOptions.buildOptions = {
    compile: { target: "bun-windows-x64", autoloadDotenv: false, autoloadBunfig: false },
  };
}

export default defineConfig(async ({ command }) => {
  const dashboard = adapter(dashboardOptions);

  if (command === "build" && dashboardOptions.out === undefined) {
    const root = process.cwd();
    const before = await checkoutBuildFingerprint(root);
    const adapt = dashboard.adapt;

    dashboard.adapt = async (builder) => {
      await adapt(builder);
      await stampCheckoutBuild(root, before);
    };
  }

  return {
    server: { host: "127.0.0.1", port: 8770, strictPort: true },
    plugins: [tailwindcss(), sveltekit({
      adapter: dashboard,
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["none"], "script-src": ["self"], "style-src": ["self"],
          "img-src": ["self", "data:"], "font-src": ["self"], "connect-src": ["self"],
          "frame-ancestors": ["none"], "base-uri": ["none"], "form-action": ["none"],
        },
      },
    })],
  };
});
