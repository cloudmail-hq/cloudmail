/**
 * Amazon SNS HTTPS message signature verification (SES research §7.3).
 *
 * - The string to sign is `Key\nValue\n` for exactly the fields AWS lists,
 *   in this order, skipping `Subject` when it is absent.
 * - `SignatureVersion` "1" is RSA-SHA1, "2" is RSA-SHA256. Anything else is refused.
 * - The certificate URL must be `https://sns.<topic region>.amazonaws.com/
 *   SimpleNotificationService-<hex>.pem`, with no port, credentials, query or
 *   fragment. The host is pinned to the region of the topic ARN, which itself
 *   was checked against the stored ARN before this runs.
 * - The certificate must be inside its validity window. Certificates are
 *   cached per isolate by URL (a new certificate always has a new URL); a
 *   failed fetch is never cached.
 *
 * @see https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

import { X509Certificate, createVerify } from "node:crypto";

export interface SnsMessage {
	Type: string;
	MessageId: string;
	TopicArn: string;
	Message: string;
	Timestamp: string;
	SignatureVersion: string;
	Signature: string;
	SigningCertURL: string;
	Subject?: string;
	SubscribeURL?: string;
	Token?: string;
	UnsubscribeURL?: string;
}

const NOTIFICATION_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_FIELDS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

const SNS_TYPES = new Set(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]);

/** Parse and shape-check an SNS body. Null when it is not an SNS message. */
export function parseSnsMessage(body: string): SnsMessage | null {
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const m = raw as Record<string, unknown>;
	const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : undefined);
	const required = ["Type", "MessageId", "TopicArn", "Message", "Timestamp", "SignatureVersion", "Signature", "SigningCertURL"];
	for (const k of required) if (str(k) === undefined) return null;
	if (!SNS_TYPES.has(str("Type")!)) return null;
	const out: SnsMessage = {
		Type: str("Type")!,
		MessageId: str("MessageId")!,
		TopicArn: str("TopicArn")!,
		Message: str("Message")!,
		Timestamp: str("Timestamp")!,
		SignatureVersion: str("SignatureVersion")!,
		Signature: str("Signature")!,
		SigningCertURL: str("SigningCertURL")!,
	};
	for (const k of ["Subject", "SubscribeURL", "Token", "UnsubscribeURL"] as const) {
		const v = str(k);
		if (v !== undefined) out[k] = v;
	}
	if (out.Type !== "Notification" && (out.SubscribeURL === undefined || out.Token === undefined)) return null;
	return out;
}

/** The exact string AWS signs for this message. */
export function snsStringToSign(msg: SnsMessage): string {
	const fields = msg.Type === "Notification" ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
	let out = "";
	for (const key of fields) {
		const value = (msg as unknown as Record<string, string | undefined>)[key];
		if (value === undefined) {
			if (key === "Subject") continue;
			throw new Error(`SNS message is missing ${key}`);
		}
		out += `${key}\n${value}\n`;
	}
	return out;
}

/** The region in a topic ARN, or null. */
export function topicRegion(topicArn: string): string | null {
	const m = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(topicArn);
	return m ? m[1]! : null;
}

/** Whether `url` is an SNS host URL for `region`: https, exact host, no port/credentials/query/fragment. */
function isSnsHostUrl(url: URL, region: string): boolean {
	return (
		url.protocol === "https:" &&
		url.port === "" &&
		url.username === "" &&
		url.password === "" &&
		url.hash === "" &&
		url.hostname === `sns.${region}.amazonaws.com`
	);
}

/** The certificate URL rule (research §7.3). */
export function isAllowedCertUrl(raw: string, topicArn: string): boolean {
	const region = topicRegion(topicArn);
	if (!region) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	return isSnsHostUrl(u, region) && u.search === "" && /^\/SimpleNotificationService-[0-9a-f]+\.pem$/i.test(u.pathname);
}

/**
 * The SubscribeURL rule: https on the topic region's SNS host, path `/`, and
 * a query of `Action=ConfirmSubscription`, the topic ARN and a token only.
 */
export function isAllowedSubscribeUrl(raw: string, topicArn: string): boolean {
	const region = topicRegion(topicArn);
	if (!region) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (!isSnsHostUrl(u, region) || u.pathname !== "/") return false;
	const keys = [...u.searchParams.keys()];
	const allowed = new Set(["Action", "TopicArn", "Token"]);
	if (keys.length !== new Set(keys).size || keys.some((k) => !allowed.has(k))) return false;
	return u.searchParams.get("Action") === "ConfirmSubscription" && u.searchParams.get("TopicArn") === topicArn &&
		!!u.searchParams.get("Token");
}

/** Overridable in tests: a local certificate instead of a fetch to AWS. */
export const snsVerifyDeps = {
	fetchCert: async (url: string): Promise<string> => {
		const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`certificate fetch answered ${res.status}`);
		const text = await res.text();
		if (text.length > 16_384) throw new Error("certificate too large");
		return text;
	},
	now: () => Date.now(),
};

const certCache = new Map<string, { cert: X509Certificate; at: number }>();
const CERT_TTL_MS = 24 * 60 * 60 * 1000;

export function clearSnsCertCache(): void {
	certCache.clear();
}

async function certFor(url: string): Promise<X509Certificate> {
	const now = snsVerifyDeps.now();
	const hit = certCache.get(url);
	if (hit && now - hit.at < CERT_TTL_MS) return hit.cert;
	const pem = await snsVerifyDeps.fetchCert(url);
	if (!/-----BEGIN CERTIFICATE-----/.test(pem)) throw new Error("not a PEM certificate");
	const cert = new X509Certificate(pem);
	if (certCache.size > 50) certCache.clear();
	certCache.set(url, { cert, at: now });
	return cert;
}

export type SnsVerdict = { ok: true } | { ok: false; reason: string };

/** Verify an SNS message's signature. `msg.TopicArn` must already equal the stored ARN. */
export async function verifySnsMessage(msg: SnsMessage): Promise<SnsVerdict> {
	const algorithm = msg.SignatureVersion === "1" ? "RSA-SHA1" : msg.SignatureVersion === "2" ? "RSA-SHA256" : null;
	if (!algorithm) return { ok: false, reason: "unsupported SignatureVersion" };
	if (!isAllowedCertUrl(msg.SigningCertURL, msg.TopicArn)) return { ok: false, reason: "certificate URL not allowed" };
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(msg.Signature)) return { ok: false, reason: "malformed signature" };
	let cert: X509Certificate;
	try {
		cert = await certFor(msg.SigningCertURL);
	} catch {
		return { ok: false, reason: "certificate unavailable" };
	}
	const now = snsVerifyDeps.now();
	const from = Date.parse(cert.validFrom);
	const to = Date.parse(cert.validTo);
	if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) {
		return { ok: false, reason: "certificate outside its validity period" };
	}
	let valid = false;
	try {
		valid = createVerify(algorithm).update(snsStringToSign(msg), "utf8").verify(cert.publicKey, msg.Signature, "base64");
	} catch {
		valid = false;
	}
	return valid ? { ok: true } : { ok: false, reason: "bad signature" };
}
