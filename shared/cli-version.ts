// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The cloudmail CLI release this deployment was built alongside. Sent on every
 * API response as `X-Cloudmail-Cli-Version`; an older CLI prints a one-line
 * update hint on stderr. Bump it together with a `vX.Y.Z` CLI release tag.
 */
export const CLI_VERSION = "0.0.1";

export const CLI_VERSION_HEADER = "X-Cloudmail-Cli-Version";
