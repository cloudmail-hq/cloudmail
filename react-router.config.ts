// Copyright (c) 2026 Cloudflare, Inc. Licensed under the Apache License 2.0 (LICENSES/Apache-2.0.txt).
// Modified by Tapetide. This file as a whole is licensed under the Fair Core License (LICENSE).

import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
