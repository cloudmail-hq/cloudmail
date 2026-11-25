/**
 * The API reference pages of the docs site, generated from the OpenAPI
 * document (`../openapi.ts`): an index, one page per tag and one page per
 * operation. Output is Markdown, the same as the hand-written guides, so each
 * page has a `.md` twin for free.
 *
 * `{{BASE_URL}}` is left in the examples; `./site.ts` replaces it with the
 * origin of the deployment that is serving the page.
 */

import type {
	HttpMethod,
	OpenApiDocument,
	OperationObject,
	ParameterObject,
	ReferenceObject,
	ResponseObject,
	SchemaObject,
} from "../openapi";

const METHODS: HttpMethod[] = ["get", "post", "put", "patch", "delete"];

/** The mailbox every example uses; the page script swaps in the reader's own. */
export const EXAMPLE_MAILBOX = "support@example.com";

export interface ApiOperation {
	method: string;
	path: string;
	op: OperationObject;
	tag: string;
	tagSlug: string;
	slug: string;
	/** Docs path below `/docs/`, e.g. `api/emails/send-email`. */
	page: string;
}

export function tagSlug(tag: string): string {
	return tag
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function operationSlug(operationId: string): string {
	return operationId
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase();
}

/** One line per tag, shown on the index and at the top of the tag's page. */
export const TAG_DESCRIPTIONS: Record<string, string> = {
	"Me/Config": "Who the caller is, what it may do in each mailbox, and which domains this deployment serves.",
	Branding: "The deployment's name, tagline, accent colour and logo.",
	Preferences: "Deployment-wide display, notification and sending preferences.",
	Access: "Which user or service may reach which mailbox, and the deployment-wide audit log.",
	Mailboxes: "List, create, read, update and delete mailboxes, and poll one for changes.",
	Delegates: "The people who can reach a mailbox, and how far.",
	Emails: "List, read, send, reply, forward, move, flag and delete messages, and download attachments.",
	Drafts: "Create or update a draft.",
	Threads: "Read a conversation, mark it read, and mute or unmute it.",
	Folders: "System and custom folders with their unread counts.",
	Labels: "Create labels and put them on messages.",
	Search: "Search one mailbox or every mailbox you can read, and ask questions answered from your mail.",
	Signatures: "Signatures a mailbox can sign outgoing mail with.",
	Snooze: "Hide a message until a time you choose.",
	"Follow-ups": "Reminders for sent mail that has not had a reply.",
	Triage: "AI labels, label prompts and the split-inbox tabs.",
	Screener: "First-time senders waiting for a yes or no.",
	"Scheduled sends": "Queue a message for later, cancel it, or send it now.",
	Rules: "Filter rules that run on incoming mail, in order.",
	Senders: "Blocked and allowed senders for a mailbox.",
	Export: "Download a mailbox as an mbox file.",
	Approvals: "Sends made with an API token or connected app that are waiting for a person.",
	Audit: "Who has done what in a mailbox.",
	People: "Correspondents across every mailbox you can read.",
	Products: "Products that group sending domains under one name, logo and unsubscribe page.",
	Analytics: "Sent, delivered, opened and clicked counts, inbound volume and DMARC reports.",
	Templates: "Reusable email templates.",
	Sequences: "Multi-step email sequences and the people enrolled in them.",
	Domains: "Domains, their DNS records and sending provider, and the Cloudflare connection.",
	Licence: "The deployment's licence status and activation.",
	Suppressions: "Addresses that must not be mailed, and template sends to many recipients.",
	"Sending health": "Spam complaint rate per domain, the bulk-sending pause, and per-mailbox send caps.",
	Usage: "This month's usage, projected cost and budget thresholds.",
	Webhooks: "Endpoints that receive a signed POST when mail events happen.",
	"Agent inboxes": "A mailbox and a token for one automated agent, with an expiry.",
	Events: "Mail events pushed over a WebSocket or Server-Sent Events.",
	AI: "AI providers and model routing, conversation summaries and the daily brief.",
	Notifications: "Web Push subscriptions and notification preferences.",
	Privacy: "Tracking switches, the privacy notice, retention, account export and deletion.",
	Import: "Import mail from a file or an IMAP server.",
	Migration: "Copy a mailbox from the legacy storage namespace.",
	Meta: "The OpenAPI document, a health check and the system status.",
};

/** Every operation, in document order. */
export function listOperations(doc: OpenApiDocument): ApiOperation[] {
	const out: ApiOperation[] = [];
	for (const [path, item] of Object.entries(doc.paths)) {
		for (const method of METHODS) {
			const op = item[method];
			if (!op) continue;
			const tag = op.tags[0] ?? "Other";
			const slug = operationSlug(op.operationId);
			out.push({
				method: method.toUpperCase(),
				path,
				op,
				tag,
				tagSlug: tagSlug(tag),
				slug,
				page: `api/${tagSlug(tag)}/${slug}`,
			});
		}
	}
	return out;
}

/** Tags that have at least one operation, in the document's tag order. */
export function listTags(doc: OpenApiDocument, operations: ApiOperation[]): string[] {
	const used = new Set(operations.map((o) => o.tag));
	const ordered = doc.tags.map((t) => t.name).filter((name) => used.has(name));
	for (const tag of used) if (!ordered.includes(tag)) ordered.push(tag);
	return ordered;
}

// -- Schema helpers ---------------------------------------------------

function refName(ref: string): string {
	return ref.split("/").pop() ?? ref;
}

/** Follow `$ref`s and merge `allOf` into one schema. */
function resolve(schema: SchemaObject | undefined, doc: OpenApiDocument, depth = 0): SchemaObject {
	if (!schema || depth > 8) return {};
	if (schema.$ref) return resolve(doc.components.schemas[refName(schema.$ref)], doc, depth + 1);
	if (schema.allOf) {
		const merged: SchemaObject = { type: "object", properties: {}, required: [] };
		for (const part of schema.allOf) {
			const r = resolve(part, doc, depth + 1);
			Object.assign(merged.properties!, r.properties ?? {});
			merged.required!.push(...(r.required ?? []));
			if (r.description && !merged.description) merged.description = r.description;
		}
		if (schema.description) merged.description = schema.description;
		return merged;
	}
	return schema;
}

function typeLabel(schema: SchemaObject | undefined, doc: OpenApiDocument, depth = 0): string {
	if (!schema || depth > 4) return "any";
	if (schema.$ref) {
		const target = resolve(schema, doc);
		return target.properties || target.type === "object" ? "object" : typeLabel(target, doc, depth + 1);
	}
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
	const variants = schema.oneOf ?? schema.anyOf;
	if (variants) return [...new Set(variants.map((v) => typeLabel(v, doc, depth + 1)))].join(" | ");
	if (schema.allOf) return "object";
	if (Array.isArray(schema.type)) {
		return schema.type.map((t) => typeLabel({ ...schema, type: t }, doc, depth + 1)).join(" | ");
	}
	if (schema.type === "array") {
		const inner = typeLabel(schema.items, doc, depth + 1);
		return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
	}
	if (schema.type === "string" && schema.contentMediaType) return `binary (${schema.contentMediaType})`;
	if (schema.type === "string" && schema.format) return `string (${schema.format})`;
	return schema.type ?? (schema.properties ? "object" : "any");
}

interface FieldRow {
	name: string;
	required: boolean;
	type: string;
	description: string;
}

const MAX_FIELD_ROWS = 80;
const MAX_FIELD_DEPTH = 2;

function collectFields(
	schema: SchemaObject,
	doc: OpenApiDocument,
	prefix: string,
	depth: number,
	rows: FieldRow[],
): void {
	const resolved = resolve(schema, doc);
	const required = new Set(resolved.required ?? []);
	for (const [name, raw] of Object.entries(resolved.properties ?? {})) {
		if (rows.length >= MAX_FIELD_ROWS) return;
		const prop = resolve(raw, doc);
		rows.push({
			name: prefix + name,
			required: required.has(name),
			type: typeLabel(raw, doc),
			description: raw.description ?? prop.description ?? "",
		});
		if (depth >= MAX_FIELD_DEPTH) continue;
		if (prop.properties) collectFields(prop, doc, `${prefix}${name}.`, depth + 1, rows);
		else if (prop.type === "array" && prop.items) {
			const item = resolve(prop.items, doc);
			if (item.properties) collectFields(item, doc, `${prefix}${name}[].`, depth + 1, rows);
		}
	}
}

/** Escape text for a table cell: one line, pipes escaped. */
function cell(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function code(text: string): string {
	return `\`${cell(text)}\``;
}

function fieldTable(schema: SchemaObject, doc: OpenApiDocument): string {
	const rows: FieldRow[] = [];
	collectFields(schema, doc, "", 0, rows);
	if (rows.length === 0) return "";
	const lines = ["| Field | Type | Description |", "| --- | --- | --- |"];
	for (const row of rows) {
		lines.push(
			`| ${code(row.name)}${row.required ? " **required**" : ""} | ${code(row.type)} | ${cell(row.description)} |`,
		);
	}
	return lines.join("\n");
}

function variantName(schema: SchemaObject, index: number, doc: OpenApiDocument): string {
	if (schema.$ref) return refName(schema.$ref);
	if (schema.type === "array") {
		return schema.items?.$ref ? `Array of ${refName(schema.items.$ref)}` : `Array of ${typeLabel(schema.items, doc)}`;
	}
	return `Shape ${index + 1}`;
}

/** Describe a request or response schema as Markdown: a note, a table, or one table per variant. */
function describeSchema(schema: SchemaObject, doc: OpenApiDocument): string {
	const parts: string[] = [];
	const variants = schema.oneOf ?? schema.anyOf;
	if (variants && variants.some((v) => resolve(v, doc).properties || v.type === "array")) {
		parts.push("One of these shapes:");
		variants.forEach((variant, index) => {
			parts.push(`**${variantName(variant, index, doc)}**`);
			parts.push(describeSchema(variant, doc) || `${code(typeLabel(variant, doc))}`);
		});
		return parts.join("\n\n");
	}
	const resolved = resolve(schema, doc);
	if (resolved.description) parts.push(resolved.description);
	if (resolved.type === "array" && resolved.items) {
		const item = resolve(resolved.items, doc);
		if (item.properties) {
			parts.push("An array of objects with these fields:");
			parts.push(fieldTable(item, doc));
		} else parts.push(`An array of ${code(typeLabel(resolved.items, doc))}.`);
		return parts.join("\n\n");
	}
	if (resolved.properties && Object.keys(resolved.properties).length > 0) {
		parts.push(fieldTable(resolved, doc));
		if (resolved.additionalProperties === true) parts.push("Other fields may be present.");
		return parts.join("\n\n");
	}
	if (resolved.type && resolved.type !== "object") parts.push(`${code(typeLabel(resolved, doc))}`);
	return parts.join("\n\n");
}

// -- Example requests -------------------------------------------------

const PATH_EXAMPLES: Record<string, string> = {
	mailboxId: EXAMPLE_MAILBOX,
	address: EXAMPLE_MAILBOX,
	person: "customer@example.org",
	sender: "customer@example.org",
	domain: "example.com",
	kind: "user",
	slug: "welcome",
	part: "1",
};

function pathExample(name: string): string {
	return (
		PATH_EXAMPLES[name] ??
		name
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.toUpperCase()
	);
}

const OUTSIDE_RECIPIENT = new Set(["to", "cc", "bcc", "recipient", "recipients"]);

function exampleString(name: string, schema: SchemaObject): string {
	if (schema.format === "email") return OUTSIDE_RECIPIENT.has(name) ? "customer@example.org" : EXAMPLE_MAILBOX;
	if (schema.format === "uri") return "https://hooks.example.org/cloudmail";
	if (schema.format === "date-time") return "2027-01-15T09:00:00Z";
	if (schema.contentEncoding === "base64") return "SGVsbG8=";
	switch (name) {
		case "subject":
			return "Hello";
		case "html":
			return "<p>Hello</p>";
		case "text":
		case "body":
		case "message":
			return "Hello";
		case "filename":
			return "note.txt";
		case "type":
			return "text/plain";
		case "domain":
			return "example.com";
		case "color":
			return "#4F46E5";
		default:
			return "string";
	}
}

/** A small example value for a request body: required fields only. */
export function exampleValue(schema: SchemaObject | undefined, doc: OpenApiDocument, name = "", depth = 0): unknown {
	if (!schema || depth > 5) return null;
	const variants = schema.oneOf ?? schema.anyOf;
	if (variants?.length) return exampleValue(variants[0], doc, name, depth + 1);
	const s = resolve(schema, doc);
	if (s.oneOf ?? s.anyOf) return exampleValue((s.oneOf ?? s.anyOf)![0], doc, name, depth + 1);
	if (s.const !== undefined) return s.const;
	if (s.enum?.length) return s.enum[0];
	const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
	if (type === "array") return [exampleValue(s.items, doc, name, depth + 1)];
	if (type === "object" || s.properties) {
		const props = s.properties ?? {};
		let names = (s.required ?? []).filter((n) => n in props);
		// A body with no required field (a patch) shows its first field, so the
		// example still has the right shape.
		if (names.length === 0) names = Object.keys(props).slice(0, 1);
		// A message needs a body: the schemas say "at least one of html or text".
		if ("text" in props && "html" in props && !names.includes("text") && !names.includes("html")) {
			names = [...names, "text"];
		}
		const out: Record<string, unknown> = {};
		for (const n of names) out[n] = exampleValue(props[n], doc, n, depth + 1);
		return out;
	}
	if (type === "integer" || type === "number") return s.minimum ?? 1;
	if (type === "boolean") return true;
	if (type === "string") return exampleString(name, s);
	return null;
}

/** `X-Migration-Token` becomes `MIGRATION_TOKEN`: the shell variable an example reads a header from. */
function headerVariable(name: string): string {
	return name
		.replace(/^X-/i, "")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.toUpperCase();
}

function exampleRequest(entry: ApiOperation, doc: OpenApiDocument): string {
	const { op, method } = entry;
	const url = `{{BASE_URL}}${entry.path.replace(/\{(\w+)\}/g, (_, name: string) => pathExample(name))}`;
	const lines: string[] = [];
	lines.push(method === "GET" ? `curl "${url}"` : `curl -X ${method} "${url}"`);
	if (!isPublicOperation(op)) lines.push(`-H "Authorization: Bearer $CLOUDMAIL_TOKEN"`);
	for (const p of op.parameters ?? []) {
		if (p.in !== "header") continue;
		if (p.name === "Idempotency-Key") lines.push(`-H "Idempotency-Key: $(uuidgen)"`);
		// Any other header the operation requires, read from a variable named after it.
		else if (p.required) lines.push(`-H "${p.name}: $${headerVariable(p.name)}"`);
	}
	if (op.requestBody) {
		const [mediaType, media] = Object.entries(op.requestBody.content)[0] ?? [];
		if (mediaType === "application/json" && media) {
			lines.push(`-H "Content-Type: application/json"`);
			const body = JSON.stringify(exampleValue(media.schema, doc), null, 2).replace(/'/g, "'\\''");
			lines.push(`-d '${body}'`);
		} else if (mediaType) {
			lines.push(`-H "Content-Type: ${mediaType}"`);
			lines.push("--data-binary @file");
		}
	}
	const responseTypes = Object.values(op.responses).flatMap((r) => ("content" in r && r.content ? Object.keys(r.content) : []));
	if (responseTypes.some((t) => t !== "application/json" && t !== "text/event-stream")) lines.push("-o download");
	return lines.map((line, i) => (i === 0 ? line : `  ${line}`)).join(" \\\n");
}

// -- Page bodies ------------------------------------------------------

function resolveResponse(response: ResponseObject | ReferenceObject, doc: OpenApiDocument): ResponseObject {
	if ("$ref" in response) {
		return doc.components.responses[refName(response.$ref)] ?? { description: response.$ref };
	}
	return response;
}

function parameterTable(params: ParameterObject[], doc: OpenApiDocument): string {
	const lines = ["| Name | In | Type | Description |", "| --- | --- | --- | --- |"];
	for (const p of params) {
		lines.push(
			`| ${code(p.name)}${p.required ? " **required**" : ""} | ${p.in} | ${code(typeLabel(p.schema, doc))} | ${cell(p.description ?? "")} |`,
		);
	}
	return lines.join("\n");
}

/** An operation the OpenAPI document marks as needing no credentials. */
export function isPublicOperation(op: OperationObject): boolean {
	return op.security !== undefined && op.security.length === 0;
}

function authLine(op: OperationObject): string {
	if (isPublicOperation(op)) return "No authentication needed.";
	const scope = op["x-token-scope"];
	const parts = [
		scope === "any"
			? "Any valid API token can call this."
			: `Needs an API token with the ${code(scope)} scope.`,
	];
	const caps = op["x-mailbox-capability"];
	if (caps?.length) {
		parts.push(
			`The caller's grant on the mailbox must include ${caps.map((c) => code(c)).join(" or ")}.`,
		);
	}
	parts.push("See [Authentication](/docs/authentication).");
	return parts.join(" ");
}

function stripPeriod(text: string): string {
	return text.replace(/\.$/, "");
}

export interface GeneratedPage {
	title: string;
	description: string;
	body: string;
}

export function operationPage(entry: ApiOperation, doc: OpenApiDocument): GeneratedPage {
	const { op } = entry;
	const parts: string[] = [];
	parts.push(`${code(`${entry.method} ${entry.path}`)}`);
	if (op.description) parts.push(op.description);
	parts.push(authLine(op));

	// A WebSocket upgrade is not something curl can show.
	if (!/websocket/i.test(op.summary)) {
		parts.push("## Example request");
		parts.push(`\`\`\`bash\n${exampleRequest(entry, doc)}\n\`\`\``);
	}

	if (op.parameters?.length) {
		parts.push("## Parameters");
		parts.push(parameterTable(op.parameters, doc));
		if (op.parameters.some((p) => p.name === "Idempotency-Key")) {
			parts.push("See [Idempotency keys](/docs/guides/idempotency).");
		}
	}

	if (op.requestBody) {
		const [mediaType, media] = Object.entries(op.requestBody.content)[0] ?? [];
		if (mediaType && media) {
			parts.push(`## Request body`);
			parts.push(`${code(mediaType)}${op.requestBody.required ? "" : ", optional"}.`);
			const described = describeSchema(media.schema, doc);
			if (described) parts.push(described);
		}
	}

	const success = Object.entries(op.responses).find(([status]) => status.startsWith("2"));
	if (success) {
		const response = resolveResponse(success[1], doc);
		const [mediaType, media] = Object.entries(response.content ?? {})[0] ?? [];
		if (mediaType && media) {
			parts.push("## Response body");
			if (mediaType !== "application/json") parts.push(`${code(mediaType)}.`);
			else {
				const described = describeSchema(media.schema, doc);
				parts.push(described || "A JSON object.");
			}
		}
	}

	parts.push("## Status codes");
	const statusLines = ["| Status | Meaning |", "| --- | --- |"];
	for (const [status, raw] of Object.entries(op.responses)) {
		statusLines.push(`| ${code(status)} | ${cell(resolveResponse(raw, doc).description)} |`);
	}
	parts.push(statusLines.join("\n"));
	parts.push("Error bodies are described in [Errors](/docs/errors).");

	return {
		title: stripPeriod(op.summary),
		description: `${stripPeriod(op.summary)}. ${entry.method} ${entry.path}`,
		body: parts.join("\n\n"),
	};
}

function operationRows(operations: ApiOperation[]): string {
	const lines = ["| Method | Path | Operation |", "| --- | --- | --- |"];
	for (const o of operations) {
		lines.push(`| ${code(o.method)} | ${code(o.path)} | [${cell(stripPeriod(o.op.summary))}](/docs/${o.page}) |`);
	}
	return lines.join("\n");
}

export function tagPage(tag: string, operations: ApiOperation[]): GeneratedPage {
	const description = TAG_DESCRIPTIONS[tag] ?? `${tag} endpoints.`;
	return {
		title: tag,
		description,
		body: [operationRows(operations)].join("\n\n"),
	};
}

export function apiIndexPage(doc: OpenApiDocument, tags: string[], operations: ApiOperation[]): GeneratedPage {
	const parts: string[] = [];
	const open = operations.filter((o) => isPublicOperation(o.op));
	parts.push(
		"The base URL is `{{BASE_URL}}`. Every endpoint needs `Authorization: Bearer ttk_<id>_<secret>`; see " +
			"[Authentication](/docs/authentication) to create a token. " +
			`The machine-readable description is [/api/v1/openapi.json](/api/v1/openapi.json) (OpenAPI ${doc.openapi}).`,
	);
	if (open.length) {
		parts.push(
			`These answer without a token: ${open
				.map((o) => `[${cell(stripPeriod(o.op.summary))}](/docs/${o.page})`)
				.join(", ")}.`,
		);
	}
	parts.push("## Sections");
	parts.push(
		tags
			.map((tag) => {
				const count = operations.filter((o) => o.tag === tag).length;
				return `- [${tag}](/docs/api/${tagSlug(tag)}): ${TAG_DESCRIPTIONS[tag] ?? ""} ${count} endpoint${count === 1 ? "" : "s"}.`;
			})
			.join("\n"),
	);
	parts.push("## All endpoints");
	const ordered = tags.flatMap((tag) => operations.filter((o) => o.tag === tag));
	parts.push(operationRows(ordered));
	return {
		title: "API reference",
		description: `Every endpoint of the ${doc.info.title}, generated from its OpenAPI ${doc.info.version} description.`,
		body: parts.join("\n\n"),
	};
}
