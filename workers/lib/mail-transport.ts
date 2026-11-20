// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Which provider a message leaves through, chosen per From domain.
 *
 * `sendEmail` (../email-sender.ts) is still the one send function. It asks
 * {@link resolveTransport} for the transport of the From address's domain and
 * hands it the message. A domain with no setting, or set to `cloudflare`, uses
 * {@link CloudflareTransport}, which is the old binding path unchanged. A
 * domain set to `ses` uses {@link SesTransport} (./ses-transport.ts); one set
 * to `resend` uses {@link ResendTransport} (./resend-transport.ts).
 *
 * ## No silent fallback
 *
 * A domain set to SES or Resend never sends through Cloudflare. When its
 * transport cannot be built (credentials incomplete, the secret no longer
 * decrypts, the settings cannot be read) the send throws a
 * {@link TransportError} whose `code` is one of {@link TRANSPORT_REJECTION_CODES}.
 * Those codes are raised before any provider is called, so
 * `classifySendFailure` files them as `rejected` (not sent, safe to retry).
 *
 * ## Lookup failures
 *
 * The per-domain read is retried once after {@link LOOKUP_RETRY_MS}. If it
 * still fails, the deployment-wide marker decides: the AuthDO keeps
 * `sending.any_non_cloudflare` in step with every settings write, and this
 * isolate remembers the last value it read. Known false means no domain can be
 * set to another provider, so Cloudflare is correct. Otherwise the last cached
 * settings for the hostname are used, and with none the send fails closed.
 *
 * ## Cache
 *
 * Settings and the marker are cached per isolate for {@link TRANSPORT_CACHE_MS}
 * (10 s). A write in this isolate drops the entry at once
 * ({@link invalidateTransportCache}); other isolates see it within the TTL.
 * Secrets are decrypted again only when the row's `updated_at` changed.
 *
 * ## Validation
 *
 * Each transport owns its provider's per-message rules (`validate`). The
 * Cloudflare rules are `shared/send-validation.ts` and `shared/email-headers.ts`;
 * the SES and Resend rules are `shared/provider-limits.ts`.
 */

import { authSecret } from "../auth/config";
import type { AuthStoreApi } from "../auth/types";
import { validateOutgoingMessage } from "../../shared/send-validation";
import { sendingDomainOf } from "../../shared/suppressions";
import type { SendingProvider } from "../../shared/ses-sending";
import { openResendKey, openSesSecret, type DomainSendingRecord } from "./domain-sending-store";
import { SesTransport } from "./ses-transport";
import { ResendTransport } from "./resend-transport";

export { SesTransport, type SesTransportConfig } from "./ses-transport";
export { ResendTransport, type ResendTransportConfig } from "./resend-transport";

/** A message as it is handed to a provider: the body is already prepared. */
export interface OutgoingMessage {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
	/**
	 * The `cm_send` tag SES and Resend carry on the message, so their events can
	 * be matched to it even when the send call's answer was lost. Minted by the
	 * transport when absent. Cloudflare ignores it.
	 */
	sendTag?: string;
}

export interface TransportSendResult {
	/**
	 * The RFC 5322 Message-ID (bare, no brackets) replies will cite, the value
	 * callers store in `emails.message_id`. For Cloudflare, the provider's id.
	 * For SES, `<MessageId>@<region>.amazonses.com`. For Resend, the email id
	 * until the `email.sent` webhook reports the header.
	 */
	messageId: string;
	/** The provider's own id when it differs from `messageId` (SES MessageId, Resend id). */
	providerMessageId?: string;
	/** The `cm_send` tag the message carried (SES, Resend). */
	sendTag?: string;
}

export interface MailTransport {
	readonly kind: SendingProvider;
	/** Throw when this provider would refuse the message. No network. */
	validate(message: OutgoingMessage): void;
	send(message: OutgoingMessage): Promise<TransportSendResult>;
}

/** Codes a transport raises before calling any provider: the message was not sent. */
export const TRANSPORT_REJECTION_CODES = [
	"E_PROVIDER_NOT_CONFIGURED",
	"E_PROVIDER_NOT_IMPLEMENTED",
	"E_PROVIDER_LOOKUP_FAILED",
] as const;
export type TransportRejectionCode = (typeof TRANSPORT_REJECTION_CODES)[number];

/** A send that could not be handed to the domain's provider. Never carries a credential. */
export class TransportError extends Error {
	constructor(
		readonly code: TransportRejectionCode,
		message: string,
		readonly provider: SendingProvider,
		readonly domain: string,
	) {
		super(message);
		this.name = "TransportError";
	}
}

const PROVIDER_LABEL: Record<SendingProvider, string> = {
	cloudflare: "Cloudflare Email Service",
	ses: "Amazon SES",
	resend: "Resend",
};

// -- Cloudflare ------------------------------------------------------------------

/**
 * Cloudflare Email Service through the `send_email` binding. Exactly the path
 * `sendEmail` used before transports existed.
 *
 * @see https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export class CloudflareTransport implements MailTransport {
	readonly kind = "cloudflare" as const;

	constructor(private readonly binding: SendEmail) {}

	validate(message: OutgoingMessage): void {
		// Email Service's per-message limits and header allowlist. Throws a
		// `SendValidationError` / `UnsendableHeaderError` whose `.code` matches the
		// provider's own. The header check is THE chokepoint: one refused header
		// fails the whole message at the provider, inside a `waitUntil` nobody reads.
		validateOutgoingMessage({
			to: message.to,
			cc: message.cc,
			bcc: message.bcc,
			html: message.html,
			text: message.text,
			attachments: message.attachments,
			headers: message.headers,
		});
	}

	async send(message: OutgoingMessage): Promise<TransportSendResult> {
		const out: Record<string, unknown> = { to: message.to, from: message.from, subject: message.subject };
		if (message.html) out.html = message.html;
		if (message.text) out.text = message.text;
		if (message.cc) out.cc = message.cc;
		if (message.bcc) out.bcc = message.bcc;
		if (message.replyTo) out.replyTo = message.replyTo;
		if (message.headers && Object.keys(message.headers).length > 0) out.headers = message.headers;
		if (message.attachments && message.attachments.length > 0) {
			out.attachments = message.attachments.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				...(att.contentId ? { contentId: att.contentId } : {}),
			}));
		}
		const result = await this.binding.send(out as any);
		return { messageId: result.messageId };
	}
}

// -- resolution ------------------------------------------------------------------

/** The AuthDO methods the resolver reads. */
export interface TransportStoreApi extends Pick<AuthStoreApi, "getOrInitMeta"> {
	getDomainSending(hostname: string): Promise<DomainSendingRecord | null>;
	anyNonCloudflareSending?(): Promise<boolean>;
}

/** What `sendEmail` needs from the environment to pick a transport. */
export interface MailEnv {
	EMAIL: SendEmail;
	AUTH_STORE?: unknown;
	AUTH_SECRET?: string;
}

/**
 * The first argument of `sendEmail`. Production call sites pass the env (so
 * the domain's setting is honoured); a bare binding is for unit tests and
 * always means Cloudflare. `test/pre-send-paths.test.ts` enforces that.
 */
export type SendVia = SendEmail | MailEnv;

/** Settings changes reach other isolates within this long. */
export const TRANSPORT_CACHE_MS = 10_000;
/** Wait before the one retry of a failed settings lookup. */
export const LOOKUP_RETRY_MS = 150;

/** Overridable in tests. */
export const mailTransportDeps = {
	now: () => Date.now(),
	/** Replaces the AuthDO lookup (tests). */
	store: undefined as ((env: MailEnv) => TransportStoreApi | null) | undefined,
	sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

interface CacheEntry {
	record: DomainSendingRecord | null;
	secret: string | null;
	decryptFailed: boolean;
	readAt: number;
}

const cache = new Map<string, CacheEntry>();
/** Last marker value this isolate read, kept on refresh errors. */
let marker: { value: boolean; readAt: number } | null = null;

/** Drop the cached settings for one hostname, or all of them (and the marker). */
export function invalidateTransportCache(hostname?: string): void {
	marker = null;
	if (hostname) cache.delete(hostname.trim().toLowerCase());
	else cache.clear();
}

function isBinding(via: SendVia): via is SendEmail {
	return typeof (via as { send?: unknown }).send === "function";
}

function defaultStore(env: MailEnv): TransportStoreApi | null {
	if (mailTransportDeps.store) return mailTransportDeps.store(env);
	const ns = env.AUTH_STORE as { idFromName?: (n: string) => unknown; get?: (id: unknown) => unknown } | undefined;
	if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
	return ns.get(ns.idFromName("global")) as TransportStoreApi;
}

/** The marker: true/false when known (fresh or last good), null when never read. */
async function readMarker(store: TransportStoreApi): Promise<boolean | null> {
	const now = mailTransportDeps.now();
	if (marker && now - marker.readAt < TRANSPORT_CACHE_MS) return marker.value;
	if (typeof store.anyNonCloudflareSending !== "function") return marker?.value ?? null;
	try {
		const value = (await store.anyNonCloudflareSending()) === true;
		marker = { value, readAt: now };
		return value;
	} catch (e) {
		console.error("Sending marker refresh failed; keeping the last value:", (e as Error).message);
		return marker?.value ?? null;
	}
}

async function lookup(store: TransportStoreApi, hostname: string): Promise<DomainSendingRecord | null> {
	try {
		return await store.getDomainSending(hostname);
	} catch {
		await mailTransportDeps.sleep(LOOKUP_RETRY_MS);
		return await store.getDomainSending(hostname);
	}
}

async function openSecret(env: MailEnv, store: TransportStoreApi, record: DomainSendingRecord): Promise<string | null> {
	const keyMaterial = await authSecret(env, store);
	if (record.provider === "ses") return record.secretEnc ? openSesSecret(record.secretEnc, keyMaterial, record.hostname) : null;
	if (record.provider === "resend") {
		return record.resendKeyEnc ? openResendKey(record.resendKeyEnc, keyMaterial, record.hostname) : null;
	}
	return null;
}

/** Settings for `hostname`, or `"cloudflare"` when the marker proves none can exist. */
async function readSettings(
	env: MailEnv,
	store: TransportStoreApi,
	hostname: string,
): Promise<CacheEntry | "cloudflare"> {
	const now = mailTransportDeps.now();
	const cached = cache.get(hostname);
	if (cached && now - cached.readAt < TRANSPORT_CACHE_MS) return cached;

	const any = await readMarker(store);
	if (any === false) return "cloudflare";

	let record: DomainSendingRecord | null;
	try {
		record = await lookup(store, hostname);
	} catch (e) {
		if (cached) {
			// Keep the last known setting rather than fail every send on a blip.
			console.error(`Sending settings refresh for ${hostname} failed; using the cached value:`, (e as Error).message);
			return cached;
		}
		throw new TransportError(
			"E_PROVIDER_LOOKUP_FAILED",
			`Couldn't read the sending settings for ${hostname}, so the message was not sent. Try again shortly.`,
			"cloudflare",
			hostname,
		);
	}
	if (!record || record.provider === "cloudflare") {
		const entry = { record, secret: null, decryptFailed: false, readAt: now };
		cache.set(hostname, entry);
		return entry;
	}
	if (cached?.record && cached.record.updatedAt === record.updatedAt && !cached.decryptFailed) {
		const entry = { ...cached, record, readAt: now };
		cache.set(hostname, entry);
		return entry;
	}
	let secret: string | null = null;
	let decryptFailed = false;
	try {
		secret = await openSecret(env, store, record);
	} catch {
		decryptFailed = true;
	}
	const entry = { record, secret, decryptFailed, readAt: now };
	cache.set(hostname, entry);
	return entry;
}

function notConfigured(hostname: string, provider: SendingProvider, what: string): TransportError {
	return new TransportError(
		"E_PROVIDER_NOT_CONFIGURED",
		`${hostname} is set to send through ${PROVIDER_LABEL[provider]}, but ${what}. ` +
			"The message was not sent. Fix it in Settings → Domains → Sending.",
		provider,
		hostname,
	);
}

/**
 * The transport for mail from `fromAddress` (a bare address; see
 * {@link fromAddressOf}).
 *
 * Throws {@link TransportError} when the domain is set to a provider that
 * cannot be used. Never returns Cloudflare for a domain set to SES or Resend.
 */
export async function resolveTransport(via: SendVia, fromAddress: string): Promise<MailTransport> {
	if (isBinding(via)) return new CloudflareTransport(via);
	const hostname = sendingDomainOf(fromAddress);
	const store = hostname ? defaultStore(via) : null;
	// No AuthDO, or one without the RPC (a hand-built env): no settings can
	// exist, so Cloudflare. A real DO stub answers every method name, so this
	// never hides a domain set to another provider; a failed lookup still fails closed.
	if (!store || typeof store.getDomainSending !== "function") return new CloudflareTransport(via.EMAIL);

	const entry = await readSettings(via, store, hostname);
	if (entry === "cloudflare") return new CloudflareTransport(via.EMAIL);
	const record = entry.record;
	if (!record || record.provider === "cloudflare") return new CloudflareTransport(via.EMAIL);

	if (record.provider === "ses") {
		if (!record.region || !record.accessKeyId || !record.secretEnc) {
			throw notConfigured(hostname, "ses", "its region, access key ID or secret access key is missing");
		}
		if (entry.decryptFailed || !entry.secret) {
			throw notConfigured(hostname, "ses", "its stored secret access key can no longer be read (AUTH_SECRET changed?)");
		}
		return new SesTransport({
			domain: hostname,
			region: record.region,
			accessKeyId: record.accessKeyId,
			secretAccessKey: entry.secret,
			configurationSet: record.configurationSet,
		});
	}
	if (!record.resendKeyEnc) throw notConfigured(hostname, "resend", "its API key is missing");
	if (entry.decryptFailed || !entry.secret) {
		throw notConfigured(hostname, "resend", "its stored API key can no longer be read (AUTH_SECRET changed?)");
	}
	return new ResendTransport({ domain: hostname, apiKey: entry.secret });
}

/**
 * Apply the per-message limits of the provider `fromAddress` sends through,
 * before anything is stored (`pre-send.ts`, the scheduled-send route). Throws
 * the provider's `SendValidationError` / `UnsendableHeaderError`.
 *
 * When the provider cannot be determined (settings unreadable, incomplete),
 * the Cloudflare rules apply: `sendEmail` will refuse such a send anyway, and
 * they are the stricter set.
 */
export async function validateForSender(
	via: SendVia,
	fromAddress: string,
	message: Pick<OutgoingMessage, "to" | "cc" | "bcc" | "html" | "text" | "attachments" | "headers">,
): Promise<void> {
	let transport: MailTransport;
	try {
		transport = await resolveTransport(via, fromAddressOf(fromAddress));
	} catch (e) {
		if (!(e instanceof TransportError)) throw e;
		transport = new CloudflareTransport(isBinding(via) ? via : via.EMAIL);
	}
	transport.validate({ ...message, from: fromAddress, subject: "" } as OutgoingMessage);
}

/**
 * The bare From address of a `from` field: `{email,name}`, `Name <a@b>` or
 * `a@b`. The transport is chosen by this address's domain.
 */
export function fromAddressOf(from: string | { email: string; name: string }): string {
	const raw = typeof from === "string" ? from : from.email;
	const m = /<([^<>]+)>\s*$/.exec(raw);
	return (m ? m[1]! : raw).trim();
}
