// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Cloudflare connection: the shapes the worker
 * (`workers/routes/cloudflare.ts`) returns and the settings page reads.
 */

/** What the read-only probe checks, one per feature that needs the token. */
export const CF_CAPABILITY_NAMES = [
	"zones.read",
	"dns.read",
	"dns.write",
	"routing",
	"routing.rules",
	"sending",
	"analytics",
	"dmarc",
	"vectorize",
	"workers.scripts",
] as const;

export type CfCapabilityName = (typeof CF_CAPABILITY_NAMES)[number];
export type CfCapabilityStatus = "ok" | "missing" | "unknown";

export interface CfCapability {
	name: CfCapabilityName;
	status: CfCapabilityStatus;
	/** Short reason, e.g. "assumed from token template" or "no zones". */
	detail?: string;
}

export const CF_CAPABILITY_LABELS: Record<CfCapabilityName, string> = {
	"zones.read": "Read zones",
	"dns.read": "Read DNS",
	"dns.write": "Edit DNS",
	routing: "Email Routing",
	"routing.rules": "Routing rules",
	sending: "Email Sending",
	analytics: "Analytics",
	dmarc: "DMARC reports",
	vectorize: "Vectorize",
	"workers.scripts": "Workers scripts",
};

export type CfTokenKind = "user" | "account";

/**
 * `none`: no token anywhere. `connected`: a usable token (env or stored).
 * `reconnect_required`: a stored token that no longer decrypts (AUTH_SECRET
 * was set or changed after connecting).
 */
export type CfConnectionState = "none" | "connected" | "reconnect_required";

export interface CfConnectionView {
	connected: boolean;
	state: CfConnectionState;
	source: "env" | "connection" | null;
	accountId: string | null;
	accountName: string | null;
	tokenKind: CfTokenKind | null;
	last4: string | null;
	verifiedAt: number | null;
	workerScriptName: string;
	capabilities: CfCapability[];
	templateUrl: string;
}

export interface CfAccountChoice {
	id: string;
	name: string | null;
}
