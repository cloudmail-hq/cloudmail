// Copyright (c) 2026 Cloudflare, Inc. Licensed under the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modified by Tapetide. This file as a whole is licensed under the Fair Core License (LICENSE).

import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * A build is always a production build. The licence check, the development
 * signing key and the local sign-in bypass are all compiled in or out on
 * `import.meta.env.DEV`, so a build made with NODE_ENV=development would
 * ship development behaviour. Refuse to make one.
 *
 * Checked when a build starts, not when the config resolves: `react-router
 * typegen` resolves this config as a "build" without building anything, and
 * must keep working whatever NODE_ENV is.
 */
const productionBuildOnly = (): Plugin => {
  let refuse = false;
  return {
    name: "cloudmail:production-build-only",
    configResolved(config) {
      refuse = config.command === "build" && !config.isProduction;
    },
    buildStart() {
      if (refuse) {
        throw new Error("cloudmail builds are production builds. Unset NODE_ENV (and any NODE_ENV in .env files) and build again.");
      }
    },
  };
};

export default defineConfig({
  plugins: [
    productionBuildOnly(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
