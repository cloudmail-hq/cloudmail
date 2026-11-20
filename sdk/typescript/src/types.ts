/**
 * Friendly names for the generated OpenAPI types (`./generated/schema.ts`).
 * Regenerate with `npm run generate`; never edit the generated file.
 */

import type { components, operations, paths } from "./generated/schema.js";

export type { components, operations, paths };

type Schemas = components["schemas"];

/** The JSON body of an operation's response for a status code. */
export type ResponseBody<Op extends keyof operations, Status extends number> = operations[Op]["responses"] extends infer R
	? Status extends keyof R
		? R[Status] extends { content: { "application/json": infer B } }
			? B
			: never
		: never
	: never;

/** The JSON request body of an operation. */
export type RequestBody<Op extends keyof operations> = operations[Op] extends {
	requestBody?: { content: { "application/json": infer B } };
}
	? B
	: never;

type JsonOf<R> = R extends { content: { "application/json": infer B } } ? B : never;

/** The JSON body of an operation's 2xx response (a union when it has several). */
export type SuccessBody<Op extends keyof operations> = {
	[S in keyof operations[Op]["responses"]]: S extends 200 | 201 | 202 ? JsonOf<operations[Op]["responses"][S]> : never;
}[keyof operations[Op]["responses"]];

/** The query parameters of an operation. */
export type QueryParams<Op extends keyof operations> = operations[Op]["parameters"] extends { query?: infer Q } ? NonNullable<Q> : never;

export type Email = Schemas["Email"];
export type EmailPage = Schemas["EmailPage"];
export type Mailbox = Schemas["Mailbox"];
export type MailboxSettingsPatch = Schemas["MailboxSettingsPatch"];
export type SendEmailRequest = Schemas["SendEmailRequest"];
export type SendAccepted = Schemas["SendAccepted"];
export type PendingApproval = Schemas["PendingApproval"];
export type SendApproval = Schemas["SendApproval"];
export type Webhook = Schemas["Webhook"];
export type WebhookDelivery = Schemas["WebhookDelivery"];
export type AttachmentPayload = Schemas["AttachmentPayload"];

export type CreateAgentInboxRequest = RequestBody<"createAgentInbox">;
export type CreateAgentInboxResult = ResponseBody<"createAgentInbox", 201>;
export type AgentInbox = NonNullable<ResponseBody<"getAgentInbox", 200>["agent_inbox"]>;
export type CreateWebhookRequest = RequestBody<"createWebhook">;
export type CreateWebhookResult = ResponseBody<"createWebhook", 201>;
export type UpdateWebhookRequest = RequestBody<"updateWebhook">;

/** Event types a webhook or the stream can carry. */
export type WebhookEventType = NonNullable<Webhook["events"]>[number];

/** The webhook / event-stream payload (`shared/webhooks.ts`). */
export interface WebhookEvent<Data = WebhookEventData> {
	id: string;
	type: WebhookEventType | (string & {});
	created_at: string;
	mailbox: string;
	/** Present and true only on deliveries from "Send test". */
	test?: true;
	data: Data;
}

export interface WebhookEventData {
	id?: string;
	thread_id?: string | null;
	from?: string | null;
	from_name?: string | null;
	to?: string[];
	cc?: string[];
	subject?: string;
	snippet?: string;
	has_attachments?: boolean;
	labels?: string[];
	folder?: string;
	spam?: boolean;
	detail?: { recipient?: string | null; reason?: string | null; cause?: string | null; url?: string | null; source?: string | null };
	[key: string]: unknown;
}

/** A send's result: accepted, or held for a person to approve (HTTP 202 `pending_approval`). */
export type SendResult = SendAccepted | PendingApproval;

export function isPendingApproval(result: unknown): result is PendingApproval {
	return !!result && typeof result === "object" && (result as { status?: unknown }).status === "pending_approval";
}
