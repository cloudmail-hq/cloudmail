// Copyright (c) 2026 Cloudflare, Inc. Licensed under the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modified by Tapetide. This file as a whole is licensed under the Fair Core License (LICENSE).

import type { Config } from "@react-router/dev/config";

/**
 * `npm run build:demo` sets CLOUDMAIL_DEMO=1 and builds the public demo: the
 * same app as a static site with no Worker behind it (scripts/demo-site). Every
 * other build is the server-rendered app.
 */
const demo = process.env.CLOUDMAIL_DEMO === "1";

export default {
  ssr: !demo,
  buildDirectory: demo ? "build-demo" : "build",
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
