// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Products, stored in the global AuthDO database (migration `0011_products`).
 *
 * Same shape as `DomainStore`: synchronous methods over the minimal `AuthSql`
 * interface, so tests run it on `node:sqlite` and the Durable Object runs it on
 * `ctx.storage.sql`. Settings are one JSON column, normalised on read, so a new
 * setting needs no migration.
 */

import type { AuthSql, AuthTransaction } from "../auth/store-core";
import { randomId } from "../auth/crypto";
import {
	AGENT_PROMPT_MAX,
	KNOWLEDGE_MAX,
	MAX_DEFAULT_TEMPLATES,
	MAX_PRODUCT_ALIASES,
	MAX_PRODUCT_DOMAINS,
	PRODUCT_NAME_MAX,
	SIGNATURE_MAX,
	defaultProductName,
	slugify,
	type Product,
	type ProductSettings,
} from "../../shared/products";

export interface ProductInput {
	name?: string;
	slug?: string;
	domains?: string[];
	aliases?: string[];
	displayName?: string | null;
	accentColor?: string | null;
	signatureHtml?: string | null;
	agentPrompt?: string | null;
	knowledgeText?: string | null;
	knowledgeUrl?: string | null;
	knowledgeFetchedAt?: number | null;
	defaultTemplates?: string[];
}

export type ProductWriteResult =
	| { ok: true; product: Product }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "invalid"; error: string }
	| { ok: false; reason: "conflict"; error: string };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function emptySettings(): ProductSettings {
	return {
		displayName: null,
		accentColor: null,
		signatureHtml: null,
		agentPrompt: null,
		knowledgeText: null,
		knowledgeUrl: null,
		knowledgeFetchedAt: null,
		defaultTemplates: [],
	};
}

function text(v: unknown, max: number): string | null {
	return typeof v === "string" && v.trim() ? v.slice(0, max) : null;
}

/** Coerce stored JSON into settings; unknown or malformed fields fall back. */
export function normalizeSettings(raw: unknown): ProductSettings {
	const base = emptySettings();
	if (!raw || typeof raw !== "object") return base;
	const v = raw as Record<string, unknown>;
	return {
		displayName: text(v.displayName, PRODUCT_NAME_MAX)?.trim() ?? null,
		accentColor: typeof v.accentColor === "string" && HEX.test(v.accentColor) ? v.accentColor : null,
		signatureHtml: text(v.signatureHtml, SIGNATURE_MAX),
		agentPrompt: text(v.agentPrompt, AGENT_PROMPT_MAX),
		knowledgeText: text(v.knowledgeText, KNOWLEDGE_MAX),
		knowledgeUrl: typeof v.knowledgeUrl === "string" && /^https:\/\//i.test(v.knowledgeUrl) ? v.knowledgeUrl : null,
		knowledgeFetchedAt: typeof v.knowledgeFetchedAt === "number" ? v.knowledgeFetchedAt : null,
		defaultTemplates: Array.isArray(v.defaultTemplates)
			? v.defaultTemplates.filter((s): s is string => typeof s === "string").slice(0, MAX_DEFAULT_TEMPLATES)
			: [],
	};
}

function parseJson(raw: unknown): unknown {
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Validate an input's fields. Returns an error message, or null when valid. */
export function validateProductInput(input: ProductInput): string | null {
	if (input.name !== undefined && !input.name.trim()) return "Name can't be empty.";
	if (input.name && input.name.trim().length > PRODUCT_NAME_MAX) return `Name must be ${PRODUCT_NAME_MAX} characters or fewer.`;
	if (input.slug !== undefined && slugify(input.slug) !== input.slug) {
		return "Slug may contain only lowercase letters, digits and dashes.";
	}
	if (input.accentColor && !HEX.test(input.accentColor)) return "Accent colour must be a hex value like #4F46E5.";
	if (input.domains) {
		if (input.domains.length > MAX_PRODUCT_DOMAINS) return `At most ${MAX_PRODUCT_DOMAINS} domains per product.`;
		const bad = input.domains.find((d) => !HOST.test(d.trim().toLowerCase()));
		if (bad !== undefined) return `"${bad}" is not a domain.`;
	}
	if (input.aliases) {
		if (input.aliases.length > MAX_PRODUCT_ALIASES) return `At most ${MAX_PRODUCT_ALIASES} aliases per product.`;
		const bad = input.aliases.find((a) => !ADDRESS.test(a.trim()));
		if (bad !== undefined) return `"${bad}" is not an email address.`;
	}
	if (input.knowledgeUrl && !/^https:\/\/[^\s]+$/i.test(input.knowledgeUrl)) return "Knowledge URL must start with https://.";
	if (input.signatureHtml && input.signatureHtml.length > SIGNATURE_MAX) return "Signature is too long.";
	if (input.agentPrompt && input.agentPrompt.length > AGENT_PROMPT_MAX) return `Reply tone must be ${AGENT_PROMPT_MAX} characters or fewer.`;
	if (input.knowledgeText && input.knowledgeText.length > KNOWLEDGE_MAX) return `Knowledge must be ${KNOWLEDGE_MAX} characters or fewer.`;
	if (input.defaultTemplates && input.defaultTemplates.length > MAX_DEFAULT_TEMPLATES) {
		return `At most ${MAX_DEFAULT_TEMPLATES} default templates.`;
	}
	return null;
}

const unique = (list: string[]) => [...new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();

export class ProductStore {
	constructor(
		private readonly sql: AuthSql,
		private readonly transaction: AuthTransaction,
	) {}

	private all(query: string, ...bindings: unknown[]): any[] {
		return this.sql.exec(query, ...bindings).toArray();
	}

	private one(query: string, ...bindings: unknown[]): any | null {
		return this.all(query, ...bindings)[0] ?? null;
	}

	private hydrate(row: any): Product {
		const id = String(row.id);
		return {
			id,
			slug: String(row.slug),
			name: String(row.name),
			domains: this.all(`SELECT hostname FROM product_domains WHERE product_id = ? ORDER BY hostname`, id).map(
				(r) => String(r.hostname),
			),
			aliases: this.all(`SELECT address FROM product_aliases WHERE product_id = ? ORDER BY address`, id).map(
				(r) => String(r.address),
			),
			logoMimeType: row.logo_mime_type ? String(row.logo_mime_type) : null,
			logoUpdatedAt: row.logo_updated_at === null || row.logo_updated_at === undefined ? null : Number(row.logo_updated_at),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			...normalizeSettings(parseJson(row.settings)),
		};
	}

	listProducts(): Product[] {
		return this.all(`SELECT * FROM products ORDER BY name COLLATE NOCASE, id`).map((r) => this.hydrate(r));
	}

	/** By id or slug. */
	getProduct(idOrSlug: string): Product | null {
		const key = idOrSlug.trim();
		const row =
			this.one(`SELECT * FROM products WHERE id = ?`, key) ??
			this.one(`SELECT * FROM products WHERE slug = ?`, key.toLowerCase());
		return row ? this.hydrate(row) : null;
	}

	private uniqueSlug(base: string, exceptId?: string): string {
		let slug = slugify(base);
		for (let n = 2; ; n++) {
			const row = this.one(`SELECT id FROM products WHERE slug = ?`, slug);
			if (!row || String(row.id) === exceptId) return slug;
			slug = `${slugify(base).slice(0, 36)}-${n}`;
		}
	}

	/** The first link (domain or alias) another product already owns. */
	private linkConflict(productId: string | null, domains: string[], aliases: string[]): string | null {
		for (const d of domains) {
			const row = this.one(`SELECT product_id FROM product_domains WHERE hostname = ?`, d);
			if (row && String(row.product_id) !== productId) return `${d} already belongs to another product.`;
		}
		for (const a of aliases) {
			const row = this.one(`SELECT product_id FROM product_aliases WHERE address = ?`, a);
			if (row && String(row.product_id) !== productId) return `${a} already belongs to another product.`;
		}
		return null;
	}

	private writeLinks(id: string, domains: string[] | undefined, aliases: string[] | undefined) {
		if (domains) {
			// A domain taken off a product on purpose should not come straight
			// back as an auto-created product of its own.
			const before = this.all(`SELECT hostname FROM product_domains WHERE product_id = ?`, id).map((r) => String(r.hostname));
			this.dismissDefault(before.filter((d) => !domains.includes(d)));
			this.sql.exec(`DELETE FROM product_domains WHERE product_id = ?`, id);
			for (const d of domains) this.sql.exec(`INSERT INTO product_domains (hostname, product_id) VALUES (?, ?)`, d, id);
			this.undismiss(domains);
		}
		if (aliases) {
			this.sql.exec(`DELETE FROM product_aliases WHERE product_id = ?`, id);
			for (const a of aliases) this.sql.exec(`INSERT INTO product_aliases (address, product_id) VALUES (?, ?)`, a, id);
		}
	}

	private mergeSettings(current: ProductSettings, input: ProductInput): ProductSettings {
		const pick = <K extends keyof ProductSettings>(key: K): ProductSettings[K] =>
			input[key as keyof ProductInput] !== undefined ? (input[key as keyof ProductInput] as ProductSettings[K]) : current[key];
		return normalizeSettings({
			displayName: pick("displayName"),
			accentColor: pick("accentColor"),
			signatureHtml: pick("signatureHtml"),
			agentPrompt: pick("agentPrompt"),
			knowledgeText: pick("knowledgeText"),
			knowledgeUrl: pick("knowledgeUrl"),
			// A changed URL invalidates the fetched copy's timestamp.
			knowledgeFetchedAt:
				input.knowledgeUrl !== undefined && input.knowledgeUrl !== current.knowledgeUrl
					? null
					: pick("knowledgeFetchedAt"),
			defaultTemplates: pick("defaultTemplates"),
		});
	}

	createProduct(input: ProductInput & { name: string }, now: number): ProductWriteResult {
		const error = validateProductInput(input);
		if (error) return { ok: false, reason: "invalid", error };
		const domains = unique(input.domains ?? []);
		const aliases = unique(input.aliases ?? []);
		return this.transaction((): ProductWriteResult => {
			const conflict = this.linkConflict(null, domains, aliases);
			if (conflict) return { ok: false, reason: "conflict", error: conflict };
			if (input.slug && this.one(`SELECT id FROM products WHERE slug = ?`, input.slug)) {
				return { ok: false, reason: "conflict", error: `The slug "${input.slug}" is taken.` };
			}
			const id = randomId("prd");
			const slug = input.slug ?? this.uniqueSlug(input.name);
			this.sql.exec(
				`INSERT INTO products (id, slug, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				id,
				slug,
				input.name.trim(),
				JSON.stringify(this.mergeSettings(emptySettings(), input)),
				now,
				now,
			);
			this.writeLinks(id, domains, aliases);
			return { ok: true, product: this.getProduct(id)! };
		});
	}

	updateProduct(idOrSlug: string, input: ProductInput, now: number): ProductWriteResult {
		const error = validateProductInput(input);
		if (error) return { ok: false, reason: "invalid", error };
		return this.transaction((): ProductWriteResult => {
			const current = this.getProduct(idOrSlug);
			if (!current) return { ok: false, reason: "not_found" };
			const domains = input.domains ? unique(input.domains) : undefined;
			const aliases = input.aliases ? unique(input.aliases) : undefined;
			const conflict = this.linkConflict(current.id, domains ?? [], aliases ?? []);
			if (conflict) return { ok: false, reason: "conflict", error: conflict };
			if (input.slug && input.slug !== current.slug && this.one(`SELECT id FROM products WHERE slug = ?`, input.slug)) {
				return { ok: false, reason: "conflict", error: `The slug "${input.slug}" is taken.` };
			}
			this.sql.exec(
				`UPDATE products SET name = ?, slug = ?, settings = ?, updated_at = ? WHERE id = ?`,
				input.name?.trim() || current.name,
				input.slug ?? current.slug,
				JSON.stringify(this.mergeSettings(current, input)),
				now,
				current.id,
			);
			this.writeLinks(current.id, domains, aliases);
			return { ok: true, product: this.getProduct(current.id)! };
		});
	}

	deleteProduct(idOrSlug: string): Product | null {
		return this.transaction(() => {
			const current = this.getProduct(idOrSlug);
			if (!current) return null;
			this.sql.exec(`DELETE FROM product_domains WHERE product_id = ?`, current.id);
			this.sql.exec(`DELETE FROM product_aliases WHERE product_id = ?`, current.id);
			this.sql.exec(`DELETE FROM products WHERE id = ?`, current.id);
			// Otherwise the next list would recreate a default for each domain.
			this.dismissDefault(current.domains);
			return current;
		});
	}

	setProductLogo(idOrSlug: string, mimeType: string | null, now: number): Product | null {
		const current = this.getProduct(idOrSlug);
		if (!current) return null;
		this.sql.exec(
			`UPDATE products SET logo_mime_type = ?, logo_updated_at = ?, updated_at = ? WHERE id = ?`,
			mimeType,
			mimeType ? now : null,
			now,
			current.id,
		);
		return this.getProduct(current.id);
	}

	/**
	 * Give every domain without a product one of its own, named after the
	 * domain. Domains already claimed (by this default or by hand) are left
	 * alone, and deleting an auto-created product does not resurrect it on the
	 * next call while the domain is listed in `skip`.
	 */
	ensureDefaultProducts(
		domains: { hostname: string; displayName?: string | null }[],
		now: number,
	): Product[] {
		return this.transaction(() => {
			const dismissed = new Set(
				this.all(`SELECT value FROM meta WHERE key LIKE 'product_dismissed:%'`).map((r) => String(r.value)),
			);
			for (const domain of domains) {
				const hostname = domain.hostname.trim().toLowerCase();
				if (!hostname || dismissed.has(hostname)) continue;
				if (this.one(`SELECT product_id FROM product_domains WHERE hostname = ?`, hostname)) continue;
				const id = randomId("prd");
				const name = defaultProductName(hostname, domain.displayName);
				this.sql.exec(
					`INSERT INTO products (id, slug, name, settings, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`,
					id,
					this.uniqueSlug(hostname.split(".")[0] || hostname),
					name,
					now,
					now,
				);
				this.sql.exec(`INSERT INTO product_domains (hostname, product_id) VALUES (?, ?)`, hostname, id);
			}
			return this.listProducts();
		});
	}

	/** Remember that a domain's default product was deleted on purpose. */
	dismissDefault(hostnames: string[]): void {
		for (const h of hostnames) {
			this.sql.exec(
				`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
				`product_dismissed:${h.toLowerCase()}`,
				h.toLowerCase(),
			);
		}
	}

	/** Undo `dismissDefault` when a domain is explicitly assigned again. */
	undismiss(hostnames: string[]): void {
		for (const h of hostnames) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `product_dismissed:${h.toLowerCase()}`);
	}
}
