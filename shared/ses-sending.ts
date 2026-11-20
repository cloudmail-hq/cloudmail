// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Per-domain sending provider settings, shared by the Worker and the UI.
 *
 * A domain sends through Cloudflare Email Service unless an administrator
 * picks Amazon SES or Resend for it (Settings → Domains → Sending). These are
 * the pieces both sides need: the provider names, the SES regions we accept,
 * the shape of the settings view and of a connection test, the DNS records a
 * test returns and the least-privilege IAM policy for a domain.
 *
 * No secret appears in any of these shapes. The view carries `secretStored`,
 * `apiKeyStored` and the last 4 characters of a key only.
 */

export const SENDING_PROVIDERS = ["cloudflare", "ses", "resend"] as const;
export type SendingProvider = (typeof SENDING_PROVIDERS)[number];

/**
 * Commercial-partition regions where SES offers the v2 API (33, research §10).
 * The region is interpolated into the endpoint host
 * (`email.<region>.amazonaws.com`), so the server accepts exactly these values
 * and nothing shaped like them.
 *
 * @see https://docs.aws.amazon.com/general/latest/gr/ses.html
 */
export const SES_REGIONS = [
	{ id: "us-east-1", label: "US East (N. Virginia)" },
	{ id: "us-east-2", label: "US East (Ohio)" },
	{ id: "us-west-1", label: "US West (N. California)" },
	{ id: "us-west-2", label: "US West (Oregon)" },
	{ id: "ca-central-1", label: "Canada (Central)" },
	{ id: "ca-west-1", label: "Canada West (Calgary)" },
	{ id: "mx-central-1", label: "Mexico (Central)" },
	{ id: "sa-east-1", label: "South America (São Paulo)" },
	{ id: "eu-west-1", label: "Europe (Ireland)" },
	{ id: "eu-west-2", label: "Europe (London)" },
	{ id: "eu-west-3", label: "Europe (Paris)" },
	{ id: "eu-central-1", label: "Europe (Frankfurt)" },
	{ id: "eu-central-2", label: "Europe (Zurich)" },
	{ id: "eu-north-1", label: "Europe (Stockholm)" },
	{ id: "eu-south-1", label: "Europe (Milan)" },
	{ id: "eu-south-2", label: "Europe (Spain)" },
	{ id: "ap-south-1", label: "Asia Pacific (Mumbai)" },
	{ id: "ap-south-2", label: "Asia Pacific (Hyderabad)" },
	{ id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
	{ id: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
	{ id: "ap-southeast-3", label: "Asia Pacific (Jakarta)" },
	{ id: "ap-southeast-4", label: "Asia Pacific (Melbourne)" },
	{ id: "ap-southeast-5", label: "Asia Pacific (Malaysia)" },
	{ id: "ap-southeast-6", label: "Asia Pacific (New Zealand)" },
	{ id: "ap-southeast-7", label: "Asia Pacific (Thailand)" },
	{ id: "ap-east-2", label: "Asia Pacific (Taipei)" },
	{ id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
	{ id: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
	{ id: "ap-northeast-3", label: "Asia Pacific (Osaka)" },
	{ id: "me-south-1", label: "Middle East (Bahrain)" },
	{ id: "me-central-1", label: "Middle East (UAE)" },
	{ id: "il-central-1", label: "Israel (Tel Aviv)" },
	{ id: "af-south-1", label: "Africa (Cape Town)" },
] as const;

export type SesRegion = (typeof SES_REGIONS)[number]["id"];

const REGION_IDS = new Set<string>(SES_REGIONS.map((r) => r.id));

export function isSesRegion(value: unknown): value is SesRegion {
	return typeof value === "string" && /^[a-z]{2}-[a-z]+-\d$/.test(value) && REGION_IDS.has(value);
}

/**
 * Regions where the SES endpoints page lists no feedback (MAIL FROM MX)
 * endpoint. The record follows the usual pattern; the UI says it is unverified.
 */
export const SES_UNLISTED_FEEDBACK_REGIONS: ReadonlySet<string> = new Set([
	"ap-southeast-4",
	"ap-southeast-6",
	"ap-east-2",
	"ap-southeast-7",
	"eu-south-2",
	"mx-central-1",
]);

/**
 * The domain of the Message-ID header SES writes: `<MessageId>@<this>`. AWS
 * does not document it; it is observed as `email.amazonses.com` in us-east-1
 * and `<region>.amazonses.com` elsewhere (research §3).
 */
export function sesMessageIdDomain(region: string): string {
	return region === "us-east-1" ? "email.amazonses.com" : `${region}.amazonses.com`;
}

/** SNS topic ARN: `arn:aws:sns:<region>:<12 digits>:<name>`. */
export const SNS_TOPIC_ARN_RE = /^arn:aws:sns:([a-z]{2}-[a-z]+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;

/** An SNS topic ARN in one of the accepted regions. */
export function isSnsTopicArn(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const m = SNS_TOPIC_ARN_RE.exec(value);
	return !!m && isSesRegion(m[1]);
}

/** The 12-digit account ID in an SNS topic ARN, or null. */
export function accountIdOfTopicArn(arn: string | null | undefined): string | null {
	const m = arn ? SNS_TOPIC_ARN_RE.exec(arn) : null;
	return m ? m[2]! : null;
}

/**
 * Long-term IAM user keys only. `ASIA…` keys are temporary and need a
 * session token, which this form has no field for.
 */
export const SES_ACCESS_KEY_ID_RE = /^AKIA[0-9A-Z]{16}$/;
/** IAM secret access keys are 40 characters of base64-ish text. */
export const SES_SECRET_ACCESS_KEY_RE = /^[A-Za-z0-9/+=]{40}$/;
/** SES configuration set names. */
export const SES_CONFIGURATION_SET_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Resend API keys start with `re_`. */
export const RESEND_API_KEY_RE = /^re_[A-Za-z0-9_]{8,200}$/;
/** Svix signing secrets: `whsec_` followed by base64. */
export const RESEND_WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9+/]{16,200}={0,2}$/;

/** Default SES configuration set name the setup steps create. */
export const DEFAULT_SES_CONFIGURATION_SET = "cloudmail";
/** Default custom MAIL FROM subdomain label. */
export const SES_MAIL_FROM_LABEL = "bounce-ses";

/** The only part of a key ever shown or audited. */
export function keyIdLast4(accessKeyId: string): string {
	return accessKeyId.trim().slice(-4);
}

/** One DNS record a provider expects for the domain. */
export interface SesDnsRecord {
	type: "CNAME" | "MX" | "TXT";
	name: string;
	value: string;
	purpose: "dkim" | "mail_from" | "spf" | "tracking";
	priority?: number;
	/** Provider-reported status for this record, when it reports one. */
	status?: string | null;
}

const HOSTED_ZONE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Easy DKIM: each token becomes `<token>._domainkey.<domain>` CNAME
 * `<token>.<SigningHostedZone>`. The zone comes from GetEmailIdentity; when it
 * is missing, `dkim.amazonses.com` is the documented default.
 *
 * @see https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html
 */
export function sesDkimRecords(
	domain: string,
	tokens: readonly string[],
	signingHostedZone?: string | null,
): SesDnsRecord[] {
	const zone =
		signingHostedZone && HOSTED_ZONE_RE.test(signingHostedZone) ? signingHostedZone.toLowerCase() : "dkim.amazonses.com";
	return tokens
		.filter((t) => /^[a-z0-9]{1,63}$/i.test(t))
		.map((t) => ({
			type: "CNAME" as const,
			name: `${t}._domainkey.${domain}`,
			value: `${t}.${zone}`,
			purpose: "dkim" as const,
		}));
}

/**
 * Custom MAIL FROM on `bounce-ses.<domain>` (or the identity's own MAIL FROM
 * domain): exactly one MX to the region's feedback endpoint, and an SPF TXT.
 * The apex MX and SPF are left alone (research §4.4).
 *
 * @see https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
 */
export function sesMailFromRecords(domain: string, region: string, mailFromDomain?: string | null): SesDnsRecord[] {
	const host =
		mailFromDomain && mailFromDomain.toLowerCase().endsWith(`.${domain.toLowerCase()}`)
			? mailFromDomain.toLowerCase()
			: `${SES_MAIL_FROM_LABEL}.${domain}`;
	return [
		{ type: "MX", name: host, value: `feedback-smtp.${region}.amazonses.com`, priority: 10, purpose: "mail_from" },
		{ type: "TXT", name: host, value: "v=spf1 include:amazonses.com ~all", purpose: "spf" },
	];
}

/** One check's outcome in a connection test. */
export interface SendTestOutcome {
	ok: boolean;
	/** Provider message id of the test message, when it was accepted. */
	messageId?: string | null;
	to?: string;
	code?: string;
	error?: string;
}

/** Result of `POST /api/v1/domains/:id/sending/test` for SES. Never carries a credential. */
export interface SesTestResult {
	provider?: "ses";
	ok: boolean;
	testedAt: number;
	region: string;
	/** Sending through SES is allowed only when this is true (DKIM SUCCESS and signing on). */
	sendingAllowed?: boolean;
	/** Why sending is not allowed, in a sentence. */
	blockedReason?: string | null;
	/** Problems that don't block sending, such as provider-side tracking. */
	warnings?: string[];
	account:
		| {
				ok: true;
				sendingEnabled: boolean;
				productionAccess: boolean;
				/** True while the account is in the SES sandbox (verified recipients only). */
				sandbox: boolean;
				enforcementStatus: string | null;
				quota: { max24HourSend: number | null; maxSendRate: number | null; sentLast24Hours: number | null };
		  }
		| { ok: false; code: string; error: string };
	identity:
		| {
				ok: true;
				verifiedForSending: boolean;
				verificationStatus: string | null;
				dkim: {
					status: string | null;
					signingEnabled: boolean;
					tokens: string[];
					signingHostedZone?: string | null;
					records: SesDnsRecord[];
				};
		  }
		| { ok: false; code: string; error: string };
	mailFrom?: {
		domain: string | null;
		status: string | null;
		records: SesDnsRecord[];
		/** The region's feedback endpoint is not on AWS's list; the record follows the pattern. */
		unverifiedEndpoint: boolean;
	};
	configurationSet?:
		| { ok: true; name: string; openTracking: boolean; clickTracking: boolean }
		| { ok: false; name: string; code: string; error: string };
	sendTest?: SendTestOutcome;
}

/** Result of a connection test for Resend. */
export interface ResendTestResult {
	provider: "resend";
	ok: boolean;
	testedAt: number;
	sendingAllowed: boolean;
	blockedReason: string | null;
	warnings: string[];
	/** False for a `sending_access` key, which cannot read domains. */
	fullAccess: boolean;
	domain:
		| {
				ok: true;
				id: string;
				status: string | null;
				region: string | null;
				openTracking: boolean;
				clickTracking: boolean;
				records: SesDnsRecord[];
		  }
		| { ok: false; code: string; error: string }
		| null;
	sendTest?: SendTestOutcome;
}

export type SendingTestResult = SesTestResult | ResendTestResult;

/** The last provider event the webhook accepted, for the status line. */
export interface SendingLastEvent {
	type: string;
	at: number;
	/** SNS subscription state when the event was a (un)subscription. */
	subscription?: "confirmed" | "unsubscribed" | "confirm_failed";
}

/** `GET /api/v1/domains/:id/sending`. */
export interface DomainSendingView {
	domain: string;
	provider: SendingProvider;
	ses: {
		region: string | null;
		/** Last 4 characters of the access key ID, or null. */
		accessKeyIdLast4: string | null;
		/** A secret access key is stored. The key itself is never returned. */
		secretStored: boolean;
		configurationSet: string | null;
		snsTopicArn: string | null;
	} | null;
	resend: {
		/** Last 4 characters of the API key. The key itself is never returned. */
		apiKeyLast4: string | null;
		apiKeyStored: boolean;
		webhookSecretStored: boolean;
	} | null;
	/** Where the provider posts events. Null until SES or Resend settings exist. */
	webhook: { provider: "ses" | "resend"; path: string; url: string | null } | null;
	lastEvent: SendingLastEvent | null;
	updatedAt: number | null;
	updatedBy: string | null;
	lastTest: SendingTestResult | null;
	/** Least-privilege IAM policy for this domain and region, when SES is configured. */
	iamPolicy: IamPolicy | null;
}

export interface IamPolicy {
	Version: "2012-10-17";
	Statement: {
		Sid: string;
		Effect: "Allow";
		Action: string[];
		Resource: string | string[];
		Condition?: Record<string, Record<string, string>>;
	}[];
}

/**
 * The narrowest IAM policy this app needs for `domain` (research §8): send as
 * the domain's identity through the configuration set only, from addresses on
 * the domain, over TLS; read the identity and the configuration set for the
 * connection test; GetAccount, which has no resource type, on `*`.
 *
 * GetAccount does not return the account ID, so it is `ACCOUNT_ID` until an
 * SNS topic ARN (which carries it) is saved.
 */
export function sesIamPolicy(
	domain: string,
	region: string,
	configurationSet?: string | null,
	accountId?: string | null,
): IamPolicy {
	const account = accountId && /^\d{12}$/.test(accountId) ? accountId : "ACCOUNT_ID";
	const host = domain.toLowerCase();
	const identity = `arn:aws:ses:${region}:${account}:identity/${host}`;
	const configSet = `arn:aws:ses:${region}:${account}:configuration-set/${configurationSet || DEFAULT_SES_CONFIGURATION_SET}`;
	return {
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "SendAsDomainThroughConfigSet",
				Effect: "Allow",
				Action: ["ses:SendEmail", "ses:SendRawEmail"],
				Resource: [identity, configSet],
				Condition: {
					StringLike: { "ses:FromAddress": `*@${host}` },
					Bool: { "aws:SecureTransport": "true" },
				},
			},
			{
				Sid: "ReadDomainIdentity",
				Effect: "Allow",
				Action: ["ses:GetEmailIdentity"],
				Resource: identity,
			},
			{
				Sid: "ReadConfigurationSet",
				Effect: "Allow",
				Action: ["ses:GetConfigurationSet", "ses:GetConfigurationSetEventDestinations"],
				Resource: configSet,
			},
			{
				Sid: "ReadAccountStatus",
				Effect: "Allow",
				Action: ["ses:GetAccount"],
				Resource: "*",
			},
		],
	};
}
