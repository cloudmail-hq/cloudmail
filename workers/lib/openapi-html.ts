// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A static, server-rendered reference page for the OpenAPI document.
 *
 * No scripts and no external assets: the CSP is `default-src 'self'` with
 * inline styles allowed, and a docs page has no reason to run code. Every piece
 * of text from the document goes through `esc`, so a summary or description can
 * never become markup.
 */

import type {
	OpenApiDocument,
	OperationObject,
	ParameterObject,
	ReferenceObject,
	ResponseObject,
	SchemaObject,
} from "./openapi";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function esc(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Escape prose, then render `backtick` spans as <code>. Safe because the text is
 * escaped first and the only markup added is a fixed tag pair.
 */
export function prose(value: unknown): string {
	return esc(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function refName(ref: string): string {
	return ref.split("/").pop() ?? ref;
}

/** Inline `$ref`s one level deep; deeper ones stay as references. */
function resolveOnce(schema: SchemaObject, doc: OpenApiDocument): SchemaObject {
	if (schema.$ref) {
		const target = doc.components.schemas[refName(schema.$ref)];
		return target ?? schema;
	}
	return schema;
}

function schemaJson(schema: SchemaObject, doc: OpenApiDocument): string {
	return JSON.stringify(resolveOnce(schema, doc), null, 2);
}

function resolveResponse(
	response: ResponseObject | ReferenceObject,
	doc: OpenApiDocument,
): ResponseObject {
	if ("$ref" in response) {
		return doc.components.responses[refName(response.$ref)] ?? { description: response.$ref };
	}
	return response;
}

function schemaLabel(schema: SchemaObject): string {
	if (schema.$ref) return refName(schema.$ref);
	if (schema.enum) return schema.enum.map(String).join(" | ");
	const t = Array.isArray(schema.type) ? schema.type.join(" | ") : (schema.type ?? "any");
	return schema.format ? `${t} (${schema.format})` : t;
}

function renderParams(params: ParameterObject[]): string {
	const rows = params
		.map(
			(p) =>
				`<tr><td><code>${esc(p.name)}</code></td><td>${esc(p.in)}</td><td><code>${esc(
					schemaLabel(p.schema),
				)}</code></td><td>${p.required ? "yes" : "no"}</td><td>${prose(p.description ?? "")}</td></tr>`,
		)
		.join("");
	return `<h4>Parameters</h4><div class="scroll"><table><thead><tr><th scope="col">Name</th><th scope="col">In</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Description</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderOperation(
	method: string,
	path: string,
	op: OperationObject,
	doc: OpenApiDocument,
): string {
	const parts: string[] = [];
	parts.push(
		`<section class="op" id="${esc(op.operationId)}" aria-labelledby="${esc(op.operationId)}-h">`,
		`<h3 id="${esc(op.operationId)}-h"><span class="method m-${esc(method)}">${esc(
			method.toUpperCase(),
		)}</span> <code class="path">${esc(path)}</code></h3>`,
		`<p class="summary">${esc(op.summary)}</p>`,
	);
	if (op.description) parts.push(`<p>${prose(op.description)}</p>`);

	const meta = [
		`<dt>Operation</dt><dd><code>${esc(op.operationId)}</code></dd>`,
		`<dt>Token scope</dt><dd><code>${esc(op["x-token-scope"])}</code></dd>`,
	];
	if (op["x-mailbox-capability"]?.length) {
		meta.push(
			`<dt>Mailbox capability</dt><dd>${op["x-mailbox-capability"]
				.map((c) => `<code>${esc(c)}</code>`)
				.join(" or ")}</dd>`,
		);
	}
	if (op.security && op.security.length === 0) meta.push(`<dt>Auth</dt><dd>Public</dd>`);
	parts.push(`<dl class="meta">${meta.join("")}</dl>`);

	if (op.parameters?.length) parts.push(renderParams(op.parameters));

	if (op.requestBody) {
		const [mediaType, media] = Object.entries(op.requestBody.content)[0] ?? [];
		if (media) {
			parts.push(
				`<h4>Request body <span class="muted">${esc(mediaType)}${
					op.requestBody.required ? "" : ", optional"
				}</span></h4>`,
				`<pre><code>${esc(schemaJson(media.schema, doc))}</code></pre>`,
			);
		}
	}

	const responseItems = Object.entries(op.responses).map(([code, raw]) => {
		const r = resolveResponse(raw, doc);
		const media = r.content ? Object.entries(r.content)[0] : undefined;
		const body = media
			? `<details><summary><code>${esc(media[0])}</code> ${esc(schemaLabel(media[1].schema))}</summary><pre><code>${esc(
					schemaJson(media[1].schema, doc),
				)}</code></pre></details>`
			: "";
		return `<li><span class="code c${esc(code.charAt(0))}">${esc(code)}</span> ${prose(r.description)}${body}</li>`;
	});
	parts.push(`<h4>Responses</h4><ul class="responses">${responseItems.join("")}</ul>`);
	parts.push(`</section>`);
	return parts.join("");
}

const STYLE = `
:root{--accent:#4f46e5;--fg:#1f2937;--muted:#6b7280;--border:#e5e7eb;--bg:#fff;--code-bg:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--border:#374151;--bg:#111318;--code-bg:#1c1f26;--accent:#a5b4fc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--accent)}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
header{border-bottom:1px solid var(--border);margin-bottom:24px;padding-bottom:16px}
h1{margin:0 0 8px;font-size:1.6rem}
h2{margin:40px 0 12px;font-size:1.25rem;border-bottom:2px solid var(--accent);padding-bottom:4px}
h3{margin:0 0 4px;font-size:1rem;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
h4{margin:16px 0 6px;font-size:.9rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
.path{overflow-wrap:anywhere;word-break:break-word}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:6px;padding:12px;overflow-x:auto}
.op{border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0}
.summary{margin:4px 0 8px}
.muted{color:var(--muted);font-weight:normal}
.method{display:inline-block;min-width:4.2em;text-align:center;border-radius:4px;padding:1px 6px;font:600 .75rem/1.6 ui-monospace,Menlo,monospace;color:#fff;background:#374151}
.m-get{background:#1d4ed8}.m-post{background:#047857}.m-put,.m-patch{background:#b45309}.m-delete{background:#b91c1c}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:8px 0;font-size:.875rem}
.meta dt{color:var(--muted)}.meta dd{margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:.85rem}
th,td{text-align:left;border-bottom:1px solid var(--border);padding:6px 8px;vertical-align:top}
th{color:var(--muted);font-weight:600}
.responses{list-style:none;padding:0;margin:0}
.responses li{padding:4px 0;border-bottom:1px solid var(--border)}
.code{display:inline-block;min-width:3em;font:600 .8rem ui-monospace,Menlo,monospace}
.c2{color:#047857}.c4{color:#b91c1c}.c5{color:#b45309}
details summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin-top:4px}
nav ul{columns:2 200px;padding-left:18px;margin:8px 0}
`;

/** Render the document as a self-contained HTML page. */
export function renderApiDocsHtml(doc: OpenApiDocument): string {
	const groups = new Map<string, string[]>();
	for (const tag of doc.tags) groups.set(tag.name, []);

	for (const [path, item] of Object.entries(doc.paths)) {
		for (const method of METHODS) {
			const op = item[method];
			if (!op) continue;
			const tag = op.tags[0] ?? "Other";
			if (!groups.has(tag)) groups.set(tag, []);
			groups.get(tag)!.push(renderOperation(method, path, op, doc));
		}
	}

	const nonEmpty = [...groups.entries()].filter(([, ops]) => ops.length > 0);
	const nav = nonEmpty
		.map(([tag, ops]) => `<li><a href="#tag-${esc(slug(tag))}">${esc(tag)}</a> <span class="muted">(${ops.length})</span></li>`)
		.join("");
	const sections = nonEmpty
		.map(
			([tag, ops]) =>
				`<section aria-labelledby="tag-${esc(slug(tag))}"><h2 id="tag-${esc(slug(tag))}">${esc(tag)}</h2>${ops.join("")}</section>`,
		)
		.join("");

	const auth = Object.entries(doc.components.securitySchemes)
		.map(
			([name, s]) =>
				`<li><strong>${esc(name)}</strong> <span class="muted">(${esc(
					s.type === "http" ? `${s.scheme} ${s.bearerFormat ?? ""}`.trim() : `${s.type} in ${s.in}: ${s.name}`,
				)})</span>: ${prose(s.description ?? "")}</li>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.info.title)} reference</title>
<style>${STYLE}</style>
</head>
<body>
<main class="wrap">
<header>
<h1>${esc(doc.info.title)} <span class="muted">v${esc(doc.info.version)}</span></h1>
${doc.info.description ? `<p>${prose(doc.info.description)}</p>` : ""}
<p>Machine-readable spec: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> (OpenAPI ${esc(doc.openapi)})</p>
<h2 id="authentication">Authentication</h2>
<ul>${auth}</ul>
<nav aria-label="Sections"><h2 id="contents">Contents</h2><ul>${nav}</ul></nav>
</header>
${sections}
</main>
</body>
</html>
`;
}
