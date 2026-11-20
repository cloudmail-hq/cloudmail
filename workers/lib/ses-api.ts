// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Amazon SES v2 calls for the connection test in Settings → Domains →
 * Sending, signed with SigV4 by `aws4fetch` (research §5.3):
 *
 *   1. GET /v2/email/account                                   GetAccount
 *   2. GET /v2/email/identities/<domain>                       GetEmailIdentity
 *   3. GET /v2/email/configuration-sets/<set>                  GetConfigurationSet (tracking options)
 *      GET /v2/email/configuration-sets/<set>/event-destinations   (Open/Click events enabled?)
 *   4. optional: SendEmail to success@simulator.amazonses.com
 *
 * One after another, never in parallel, at most one per second: every SES
 * action except SendEmail is limited to 1 request per second.
 *
 * Errors are mapped to a short code and a sentence; the access key, the
 * secret and the signed request never appear in a result or a log line.
 */

import { AwsClient } from "aws4fetch";
import {
	SES_UNLISTED_FEEDBACK_REGIONS,
	sesDkimRecords,
	sesMailFromRecords,
	type SesTestResult,
} from "../../shared/ses-sending";
import { sesApiBase, SesTransport } from "./ses-transport";
import { describeSendError } from "../../shared/send-errors";

export interface SesCredentials {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface SesApiOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: number;
	/** Pause between read calls (1 req/s); overridable in tests. */
	sleep?: (ms: number) => Promise<void>;
}

type Failure = { ok: false; code: string; error: string };

/** The SES v2 endpoint for a region. Throws for a region we do not accept. */
export function sesEndpoint(region: string): string {
	return sesApiBase(region);
}

function describeFailure(status: number, type: string, message: string): Failure {
	// `x-amzn-ErrorType` is "Name:" or "Name:http://..."; keep the name.
	const head = type.split(":")[0] ?? "";
	// "com.amazonaws...#Name" (Coral JSON) keeps only the name.
	const name = (head.includes("#") ? head.split("#").pop() : head) ?? "";
	if (/OptInRequired/i.test(name)) {
		return { ok: false, code: "region_not_enabled", error: "SES isn't enabled in this region for the AWS account." };
	}
	if (status === 403 || /UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|IncompleteSignature|AccessDenied/i.test(name)) {
		const accessDenied = /AccessDenied/i.test(name);
		return {
			ok: false,
			code: accessDenied ? "access_denied" : "invalid_credentials",
			error: accessDenied
				? "AWS accepted the key but it isn't allowed to make this call. Attach the IAM policy shown below."
				: "AWS didn't accept the access key ID and secret. Check both, and that the key is active.",
		};
	}
	if (status === 404 || /NotFound/i.test(name)) {
		return {
			ok: false,
			code: "identity_not_found",
			error: "This domain isn't an SES identity in that region yet. Check the region, or create the identity there.",
		};
	}
	if (status === 429 || /TooManyRequests|Throttl/i.test(name)) {
		return { ok: false, code: "throttled", error: "AWS is throttling requests. Try again in a minute." };
	}
	// Our own words plus AWS's short message, which names no secret.
	const detail = message ? `: ${message.slice(0, 200)}` : "";
	return { ok: false, code: "aws_error", error: `AWS answered ${status}${name ? ` (${name})` : ""}${detail}` };
}

async function getJson(
	client: AwsClient,
	url: string,
	options: SesApiOptions,
): Promise<{ ok: true; body: Record<string, any> } | Failure> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	try {
		const signed = await client.sign(url, { method: "GET", headers: { accept: "application/json" } });
		const res = await (options.fetchImpl ?? fetch)(signed, { signal: controller.signal });
		const text = await res.text();
		let body: Record<string, any> = {};
		try {
			body = text ? (JSON.parse(text) as Record<string, any>) : {};
		} catch {
			body = {};
		}
		if (!res.ok) {
			const type = res.headers.get("x-amzn-errortype") ?? String(body.__type ?? body.code ?? "");
			const message = typeof body.message === "string" ? body.message : typeof body.Message === "string" ? body.Message : "";
			return describeFailure(res.status, type, message);
		}
		return { ok: true, body };
	} catch (e) {
		const aborted = (e as Error)?.name === "AbortError";
		return {
			ok: false,
			code: aborted ? "timeout" : "network_error",
			error: aborted ? "AWS didn't answer in time." : "Couldn't reach AWS. Check the region.",
		};
	} finally {
		clearTimeout(timer);
	}
}

const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);

export const SES_SIMULATOR_SUCCESS = "success@simulator.amazonses.com";

/**
 * Run the checks for `domain`. Never throws; each check reports its own
 * failure so a key that can read the account but not the identity still
 * shows the sandbox status.
 *
 * Sending through SES is allowed only when DKIM is SUCCESS with signing on
 * (research Decision 4); `blockedReason` says why when it is not.
 */
export async function testSesConnection(
	domain: string,
	creds: SesCredentials & { configurationSet?: string | null },
	options: SesApiOptions & { sendTest?: boolean } = {},
): Promise<SesTestResult> {
	const testedAt = options.now ?? Date.now();
	const base = sesEndpoint(creds.region);
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const client = new AwsClient({
		accessKeyId: creds.accessKeyId,
		secretAccessKey: creds.secretAccessKey,
		service: "ses",
		region: creds.region,
		retries: 0,
	});

	const account = await getJson(client, `${base}/v2/email/account`, options);
	await sleep(1000);
	const identity = await getJson(client, `${base}/v2/email/identities/${encodeURIComponent(domain)}`, options);

	const accountResult: SesTestResult["account"] = account.ok
		? {
				ok: true,
				sendingEnabled: account.body.SendingEnabled === true,
				productionAccess: account.body.ProductionAccessEnabled === true,
				sandbox: account.body.ProductionAccessEnabled !== true,
				enforcementStatus: strOrNull(account.body.EnforcementStatus),
				quota: {
					max24HourSend: numOrNull(account.body.SendQuota?.Max24HourSend),
					maxSendRate: numOrNull(account.body.SendQuota?.MaxSendRate),
					sentLast24Hours: numOrNull(account.body.SendQuota?.SentLast24Hours),
				},
			}
		: account;

	let identityResult: SesTestResult["identity"];
	let mailFrom: SesTestResult["mailFrom"];
	if (identity.ok) {
		const dkim = (identity.body.DkimAttributes ?? {}) as Record<string, unknown>;
		const tokens = Array.isArray(dkim.Tokens) ? dkim.Tokens.filter((t): t is string => typeof t === "string") : [];
		const zone = strOrNull(dkim.SigningHostedZone);
		identityResult = {
			ok: true,
			verifiedForSending: identity.body.VerifiedForSendingStatus === true,
			verificationStatus: strOrNull(identity.body.VerificationStatus),
			dkim: {
				status: strOrNull(dkim.Status),
				signingEnabled: dkim.SigningEnabled === true,
				tokens,
				signingHostedZone: zone,
				records: sesDkimRecords(domain, tokens, zone),
			},
		};
		const mf = (identity.body.MailFromAttributes ?? null) as Record<string, unknown> | null;
		const mfDomain = mf ? strOrNull(mf.MailFromDomain) : null;
		mailFrom = {
			domain: mfDomain,
			status: mf ? strOrNull(mf.MailFromDomainStatus) : null,
			records: sesMailFromRecords(domain, creds.region, mfDomain),
			unverifiedEndpoint: SES_UNLISTED_FEEDBACK_REGIONS.has(creds.region),
		};
	} else {
		identityResult = identity;
		mailFrom = {
			domain: null,
			status: null,
			records: sesMailFromRecords(domain, creds.region),
			unverifiedEndpoint: SES_UNLISTED_FEEDBACK_REGIONS.has(creds.region),
		};
	}

	const warnings: string[] = [];
	let configurationSet: SesTestResult["configurationSet"];
	if (creds.configurationSet) {
		await sleep(1000);
		const name = creds.configurationSet;
		const set = await getJson(client, `${base}/v2/email/configuration-sets/${encodeURIComponent(name)}`, options);
		if (set.ok) {
			// SES tracks opens and clicks only through event destinations that
			// enable Open/Click; a custom redirect domain also shows it is in use.
			await sleep(1000);
			const dest = await getJson(
				client,
				`${base}/v2/email/configuration-sets/${encodeURIComponent(name)}/event-destinations`,
				options,
			);
			const types = new Set<string>();
			if (dest.ok && Array.isArray(dest.body.EventDestinations)) {
				for (const d of dest.body.EventDestinations as Record<string, unknown>[]) {
					if (d?.Enabled === false) continue;
					for (const t of Array.isArray(d?.MatchingEventTypes) ? d.MatchingEventTypes : []) types.add(String(t).toUpperCase());
				}
			}
			const customRedirect = !!strOrNull(set.body.TrackingOptions?.CustomRedirectDomain);
			const openTracking = types.has("OPEN");
			const clickTracking = types.has("CLICK") || customRedirect;
			configurationSet = { ok: true, name, openTracking, clickTracking };
			if (openTracking || clickTracking) {
				warnings.push(
					`The configuration set "${name}" has SES ${[openTracking && "open", clickTracking && "click"].filter(Boolean).join(" and ")} tracking on. ` +
						"cloudmail already tracks opens and clicks, so SES would rewrite links a second time and count opens twice. " +
						"Remove Open and Click from its event destinations.",
				);
			}
			if (dest.ok) {
				for (const t of ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"]) {
					if (!types.has(t)) {
						warnings.push(`The configuration set doesn't publish ${t.toLowerCase()} events, so they won't reach cloudmail.`);
					}
				}
			}
		} else {
			configurationSet = { ok: false, name, code: set.code, error: set.error };
		}
	} else {
		warnings.push("No configuration set: bounces and complaints won't reach cloudmail. Create one and add it here.");
	}

	if (accountResult.ok && accountResult.sandbox) {
		warnings.push("The account is in the SES sandbox in this region: only verified recipients, 200 a day.");
	}

	let blockedReason: string | null = null;
	if (!identityResult.ok) blockedReason = identityResult.error;
	else if (!identityResult.verifiedForSending) {
		blockedReason = `The domain isn't verified for sending in SES (${identityResult.verificationStatus ?? "unknown"}).`;
	} else if (identityResult.dkim.status !== "SUCCESS" || !identityResult.dkim.signingEnabled) {
		blockedReason = `DKIM isn't ready (status ${identityResult.dkim.status ?? "not set up"}${identityResult.dkim.signingEnabled ? "" : ", signing off"}). Add the CNAME records below and wait for SES to verify them.`;
	} else if (accountResult.ok && !accountResult.sendingEnabled) {
		blockedReason = "Sending is disabled for the AWS account in this region.";
	} else if (!accountResult.ok) blockedReason = accountResult.error;
	const sendingAllowed = blockedReason === null;

	let sendTest: SesTestResult["sendTest"];
	if (options.sendTest && sendingAllowed) {
		const transport = new SesTransport({
			domain,
			region: creds.region,
			accessKeyId: creds.accessKeyId,
			secretAccessKey: creds.secretAccessKey,
			configurationSet: creds.configurationSet ?? null,
		});
		try {
			const sent = await transport.send({
				from: `postmaster@${domain}`,
				to: SES_SIMULATOR_SUCCESS,
				subject: "cloudmail SES connection test",
				text: "This message tests the Amazon SES connection from cloudmail. It goes to the SES mailbox simulator.",
			});
			sendTest = { ok: true, to: SES_SIMULATOR_SUCCESS, messageId: sent.providerMessageId ?? null };
		} catch (e) {
			sendTest = { ok: false, to: SES_SIMULATOR_SUCCESS, code: (e as { code?: string }).code ?? "send_failed", error: describeSendError(e) };
		}
	}

	return {
		provider: "ses",
		ok: sendingAllowed && (sendTest ? sendTest.ok : true),
		testedAt,
		region: creds.region,
		sendingAllowed,
		blockedReason,
		warnings,
		account: accountResult,
		identity: identityResult,
		mailFrom,
		...(configurationSet ? { configurationSet } : {}),
		...(sendTest ? { sendTest } : {}),
	};
}
