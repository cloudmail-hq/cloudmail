// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Resend connection test (Resend research, Decisions 5, 6 and 9):
 *
 *   GET /domains            find the domain's id
 *   GET /domains/:id        status, records, region, open/click tracking
 *   optional POST /emails   a test message to delivered@resend.dev
 *
 * A `sending_access` key answers `401 restricted_api_key` to the GETs. That is
 * accepted: the test says the key can only send, skips the domain checks, and
 * Resend itself refuses an unverified From domain with a definite rejection.
 * The key never appears in a result or a log line.
 */

import type { ResendTestResult, SesDnsRecord } from "../../shared/ses-sending";
import { describeSendError } from "../../shared/send-errors";
import { ResendTransport, resendApiBase, resendTransportDeps } from "./resend-transport";

export const RESEND_TEST_RECIPIENT = "delivered@resend.dev";

interface Options {
	fetchImpl?: typeof fetch;
	now?: number;
	sendTest?: boolean;
	timeoutMs?: number;
}

type Got = { ok: true; body: Record<string, any> } | { ok: false; status: number; name: string; message: string };

async function getJson(apiKey: string, path: string, options: Options): Promise<Got> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	try {
		const res = await (options.fetchImpl ?? resendTransportDeps.fetchImpl ?? fetch)(`${resendApiBase()}${path}`, {
			method: "GET",
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal,
		});
		let body: Record<string, any> = {};
		try {
			body = (await res.json()) as Record<string, any>;
		} catch {
			body = {};
		}
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				name: typeof body.name === "string" ? body.name : "",
				message: typeof body.message === "string" ? body.message.slice(0, 200) : "",
			};
		}
		return { ok: true, body };
	} catch (e) {
		return { ok: false, status: 0, name: (e as Error)?.name === "AbortError" ? "timeout" : "network_error", message: "" };
	} finally {
		clearTimeout(timer);
	}
}

function recordsOf(raw: unknown): SesDnsRecord[] {
	if (!Array.isArray(raw)) return [];
	const out: SesDnsRecord[] = [];
	for (const r of raw.slice(0, 20) as Record<string, unknown>[]) {
		const type = String(r?.type ?? "").toUpperCase();
		if (type !== "MX" && type !== "TXT" && type !== "CNAME") continue;
		const kind = String(r?.record ?? "").toLowerCase();
		out.push({
			type,
			name: String(r?.name ?? "").slice(0, 253),
			value: String(r?.value ?? "").slice(0, 1024),
			purpose: kind === "dkim" ? "dkim" : kind === "tracking" ? "tracking" : type === "MX" ? "mail_from" : "spf",
			...(typeof r?.priority === "number" ? { priority: r.priority } : {}),
			status: typeof r?.status === "string" ? r.status : null,
		});
	}
	return out;
}

function failureText(got: Extract<Got, { ok: false }>): { code: string; error: string } {
	if (got.status === 0) return { code: got.name, error: got.name === "timeout" ? "Resend didn't answer in time." : "Couldn't reach Resend." };
	if (got.status === 401 || got.status === 403) {
		return { code: "invalid_key", error: "Resend didn't accept the API key. Check it, and that it hasn't been revoked." };
	}
	if (got.status === 429) return { code: "rate_limited", error: "Resend is rate limiting requests. Try again in a moment." };
	return { code: "resend_error", error: `Resend answered ${got.status}${got.name ? ` (${got.name})` : ""}${got.message ? `: ${got.message}` : ""}` };
}

export async function testResendConnection(domain: string, apiKey: string, options: Options = {}): Promise<ResendTestResult> {
	const testedAt = options.now ?? Date.now();
	const warnings: string[] = [];
	let fullAccess = true;
	let domainResult: ResendTestResult["domain"] = null;
	let blockedReason: string | null = null;

	const list = await getJson(apiKey, "/domains", options);
	if (!list.ok && list.status === 401 && list.name === "restricted_api_key") {
		fullAccess = false;
		warnings.push(
			"This key can only send, so the domain's status, DNS records and tracking settings can't be checked. " +
				"Check in the Resend dashboard that the domain is verified and that open and click tracking are off.",
		);
	} else if (!list.ok) {
		const f = failureText(list);
		domainResult = { ok: false, ...f };
		blockedReason = f.error;
	} else {
		const items = Array.isArray(list.body.data) ? (list.body.data as Record<string, unknown>[]) : [];
		const match = items.find((d) => String(d?.name ?? "").toLowerCase() === domain.toLowerCase());
		if (!match || typeof match.id !== "string") {
			domainResult = { ok: false, code: "domain_not_found", error: `${domain} isn't a domain in this Resend account. Add it in Resend first.` };
			blockedReason = domainResult.error;
		} else {
			const detail = await getJson(apiKey, `/domains/${encodeURIComponent(match.id)}`, options);
			if (!detail.ok) {
				const f = failureText(detail);
				domainResult = { ok: false, ...f };
				blockedReason = f.error;
			} else {
				const d = detail.body;
				const openTracking = d.open_tracking === true;
				const clickTracking = d.click_tracking === true;
				domainResult = {
					ok: true,
					id: match.id,
					status: typeof d.status === "string" ? d.status : null,
					region: typeof d.region === "string" ? d.region : null,
					openTracking,
					clickTracking,
					records: recordsOf(d.records),
				};
				if (domainResult.status !== "verified") {
					blockedReason = `The domain isn't verified in Resend yet (status ${domainResult.status ?? "unknown"}). Add the DNS records below.`;
				}
				if (openTracking || clickTracking) {
					warnings.push(
						`Resend ${[openTracking && "open", clickTracking && "click"].filter(Boolean).join(" and ")} tracking is on for ${domain}. ` +
							"cloudmail already tracks opens and clicks, so Resend would rewrite links a second time and count opens twice. Turn it off in Resend.",
					);
				}
			}
		}
	}

	const sendingAllowed = blockedReason === null;
	let sendTest: ResendTestResult["sendTest"];
	if (options.sendTest && sendingAllowed) {
		try {
			const sent = await new ResendTransport({ domain, apiKey }).send({
				from: `postmaster@${domain}`,
				to: RESEND_TEST_RECIPIENT,
				subject: "cloudmail Resend connection test",
				text: "This message tests the Resend connection from cloudmail.",
			});
			sendTest = { ok: true, to: RESEND_TEST_RECIPIENT, messageId: sent.providerMessageId ?? null };
		} catch (e) {
			sendTest = { ok: false, to: RESEND_TEST_RECIPIENT, code: (e as { code?: string }).code ?? "send_failed", error: describeSendError(e) };
		}
	}

	return {
		provider: "resend",
		ok: sendingAllowed && (sendTest ? sendTest.ok : true),
		testedAt,
		sendingAllowed,
		blockedReason,
		warnings,
		fullAccess,
		domain: domainResult,
		...(sendTest ? { sendTest } : {}),
	};
}
