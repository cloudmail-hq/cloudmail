// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The model router over a mocked Workers AI binding, for tests that used to
 * hand a raw `Ai` mock to the AI helpers. The real router runs, so the mock
 * still sees exactly the `run(model, body)` calls production makes. No
 * config file and no usage counter.
 */

import { aiFor, type AiHandle } from "../../workers/lib/ai-router";

export function routerOver(binding: unknown, options: { summaryModel?: string } = {}): AiHandle {
	return aiFor({ AI: binding as Ai, SUMMARY_MODEL: options.summaryModel }, { config: null, recorder: null });
}
