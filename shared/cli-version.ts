/**
 * The cloudmail CLI release this deployment was built alongside. Sent on every
 * API response as `X-Cloudmail-Cli-Version`; an older CLI prints a one-line
 * update hint on stderr. Bump it together with a `vX.Y.Z` CLI release tag.
 */
export const CLI_VERSION = "0.0.1";

export const CLI_VERSION_HEADER = "X-Cloudmail-Cli-Version";
