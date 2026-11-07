// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Settings → Products: the identity each product's domains and aliases send as.
 *
 * Every domain gets a product of its own by default (named after the domain);
 * an admin can merge domains into one product, claim extra aliases, and set
 * the display name, accent, logo, signature, reply tone, knowledge and default
 * templates. The preview on the right shows the signature as the composer
 * inserts it and the unsubscribe page as a recipient sees it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ImageIcon, Loader2, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { LazyEditor } from "~/components/lazy";
import {
	ConfirmDialog,
	DANGER_BUTTON_CLASS,
	InlineError,
	PRIMARY_BUTTON_CLASS,
	SECONDARY_BUTTON_CLASS,
	SETTINGS_INPUT_CLASS,
	SectionHeading,
	SettingsField,
} from "~/components/settings/settings-ui";
import {
	useCreateProduct,
	useDeleteProduct,
	useDeleteProductLogo,
	useProducts,
	useRefreshProductKnowledge,
	useUpdateProduct,
	useUploadProductLogo,
} from "~/queries/products";
import { useDomains } from "~/queries/domains";
import { useTemplates } from "~/queries/templates";
import { validateLogoFile } from "~/queries/branding";
import { sanitizeInlineHtml } from "~/lib/email-html";
import { toast } from "~/lib/toast";
import { cn, fileToBase64 } from "~/lib/utils";
import { ApiError } from "~/services/api";
import type { ProductPatch, ProductView } from "~/services/products-api";
import { contrastRatio, MIN_UI_CONTRAST } from "shared/color-contrast";
import {
	AGENT_PROMPT_MAX,
	KNOWLEDGE_MAX,
	PRODUCT_NAME_MAX,
	badgeColor,
	renderProductSignature,
} from "shared/products";

interface Draft {
	name: string;
	displayName: string;
	accentColor: string;
	domains: string;
	aliases: string;
	signatureHtml: string;
	agentPrompt: string;
	knowledgeText: string;
	knowledgeUrl: string;
	defaultTemplates: string[];
}

function toDraft(p: ProductView): Draft {
	return {
		name: p.name,
		displayName: p.displayName ?? "",
		accentColor: p.accentColor ?? "",
		domains: p.domains.join(", "),
		aliases: p.aliases.join(", "),
		signatureHtml: p.signatureHtml ?? "",
		agentPrompt: p.agentPrompt ?? "",
		knowledgeText: p.knowledgeText ?? "",
		knowledgeUrl: p.knowledgeUrl ?? "",
		defaultTemplates: p.defaultTemplates,
	};
}

const list = (s: string) =>
	s
		.split(/[\s,]+/)
		.map((x) => x.trim().toLowerCase())
		.filter(Boolean);

function toPatch(d: Draft): ProductPatch {
	return {
		name: d.name.trim(),
		displayName: d.displayName.trim() || null,
		accentColor: d.accentColor.trim() || null,
		domains: list(d.domains),
		aliases: list(d.aliases),
		signatureHtml: d.signatureHtml.trim() ? d.signatureHtml : null,
		agentPrompt: d.agentPrompt.trim() || null,
		knowledgeText: d.knowledgeText.trim() || null,
		knowledgeUrl: d.knowledgeUrl.trim() || null,
		defaultTemplates: d.defaultTemplates,
	};
}

function messageOf(e: unknown, fallback: string) {
	return e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback;
}

export default function ProductsSettings() {
	const { data: products = [], isPending, isError, refetch } = useProducts();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const create = useCreateProduct();
	const [newName, setNewName] = useState("");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!selectedId && products.length) setSelectedId(products[0]!.id);
		if (selectedId && products.length && !products.some((p) => p.id === selectedId)) setSelectedId(products[0]!.id);
	}, [products, selectedId]);

	const selected = products.find((p) => p.id === selectedId) ?? null;

	async function onCreate() {
		setError(null);
		if (!newName.trim()) return setError("Give the product a name.");
		try {
			const { product } = await create.mutateAsync({ name: newName.trim() });
			setSelectedId(product.id);
			setCreating(false);
			setNewName("");
			toast.success(`Created ${product.name}.`);
		} catch (e) {
			setError(messageOf(e, "Couldn't create the product."));
		}
	}

	return (
		<section className="space-y-3">
			<SectionHeading icon={Boxes} title="Products" busy={isPending}>
				<button type="button" onClick={() => setCreating((v) => !v)} className={SECONDARY_BUTTON_CLASS}>
					<Plus size={13} aria-hidden />
					New product
				</button>
			</SectionHeading>
			<p className="text-sm text-text-secondary">
				A product is the identity your domains send as: name, colours, logo, signature and the agent's voice.
				Mail from an alias or domain uses its product automatically, in the composer, auto-drafts and the
				unsubscribe page. Each domain starts as its own product.
			</p>

			{creating && (
				<div className="flex flex-wrap items-end gap-2 rounded-[8px] bg-card p-4 ring-1 ring-border">
					<SettingsField
						label="Product name"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						maxLength={PRODUCT_NAME_MAX}
						placeholder="Acme Analytics"
						className="min-w-[220px] flex-1"
						autoFocus
						onKeyDown={(e) => e.key === "Enter" && void onCreate()}
					/>
					<button type="button" onClick={() => void onCreate()} disabled={create.isPending} className={PRIMARY_BUTTON_CLASS}>
						{create.isPending && <Loader2 size={13} className="animate-spin" aria-hidden />}
						Create
					</button>
				</div>
			)}
			<InlineError message={error} />

			{isError ? (
				<div className="flex items-center justify-between rounded-[6px] bg-bg-subtle px-3 py-2 text-xs text-text-secondary">
					Couldn't load products.
					<button type="button" onClick={() => void refetch()} className="font-medium text-text-primary hover:underline">
						Retry
					</button>
				</div>
			) : null}

			{products.length === 0 && !isPending && !isError ? (
				<p className="rounded-[8px] bg-card p-5 text-sm text-text-secondary ring-1 ring-border">
					No products yet. Add a domain in Settings → Domains and it gets one automatically, or create one here.
				</p>
			) : null}

			{products.length > 0 && (
				<div className="space-y-4">
					{/* Product picker: a strip of toggle buttons, one per product. */}
					<div role="tablist" aria-label="Products" className="flex flex-wrap gap-1.5">
						{products.map((p) => (
							<button
								key={p.id}
								type="button"
								role="tab"
								aria-selected={p.id === selectedId}
								onClick={() => setSelectedId(p.id)}
								className={cn(
									"inline-flex h-9 items-center gap-2 rounded-[8px] border px-3 text-[13px] font-medium touch:h-11",
									p.id === selectedId
										? "border-text-primary bg-card text-text-primary"
										: "border-border bg-bg-subtle text-text-secondary hover:bg-bg-muted",
								)}
							>
								<span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: badgeColor(p) }} />
								{p.displayName || p.name}
								<span className="text-[11px] font-normal text-text-tertiary">
									{p.domains.length === 1 ? p.domains[0] : `${p.domains.length} domains`}
								</span>
							</button>
						))}
					</div>
					{selected && <ProductEditor key={selected.id} product={selected} />}
				</div>
			)}
		</section>
	);
}

function ProductEditor({ product }: { product: ProductView }) {
	const update = useUpdateProduct();
	const remove = useDeleteProduct();
	const uploadLogo = useUploadProductLogo();
	const deleteLogo = useDeleteProductLogo();
	const refresh = useRefreshProductKnowledge();
	const { data: domainList } = useDomains();
	const domains = domainList?.domains ?? [];
	const { data: templates = [] } = useTemplates();
	const [draft, setDraft] = useState<Draft>(() => toDraft(product));
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	// Re-seed after a save (updatedAt moves), never on a background refetch.
	const seeded = useRef(product.updatedAt);
	useEffect(() => {
		if (seeded.current === product.updatedAt) return;
		seeded.current = product.updatedAt;
		setDraft(toDraft(product));
	}, [product]);

	const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
	const dirty = JSON.stringify(toPatch(draft)) !== JSON.stringify(toPatch(toDraft(product)));
	const accent = draft.accentColor || badgeColor(product);
	const contrast = draft.accentColor ? contrastRatio(draft.accentColor, "#FFFFFF") : null;
	const knownDomains = useMemo(() => domains.map((d) => d.hostname), [domains]);
	const unknownDomains = list(draft.domains).filter((d) => knownDomains.length && !knownDomains.includes(d));

	async function onSave() {
		setError(null);
		if (!draft.name.trim()) return setError("Name can't be empty.");
		if (draft.accentColor && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(draft.accentColor)) {
			return setError("Accent colour must be a hex value like #4F46E5.");
		}
		try {
			await update.mutateAsync({ id: product.id, patch: toPatch(draft) });
			toast.success(`Saved ${draft.name.trim()}.`);
		} catch (e) {
			setError(messageOf(e, "Couldn't save the product."));
		}
	}

	async function onPickLogo(file: File | undefined) {
		if (fileInput.current) fileInput.current.value = "";
		if (!file) return;
		const check = validateLogoFile(file);
		if (!check.valid) return setError(check.error ?? "That image can't be used as a logo.");
		try {
			await uploadLogo.mutateAsync({
				id: product.id,
				logo: { content: await fileToBase64(file), filename: file.name, type: file.type },
			});
			toast.success("Logo updated.");
		} catch (e) {
			setError(messageOf(e, "Couldn't upload that logo."));
		}
	}

	async function onRefresh() {
		setError(null);
		try {
			if (dirty) await update.mutateAsync({ id: product.id, patch: toPatch(draft) });
			const { chars } = await refresh.mutateAsync(product.id);
			toast.success(`Fetched ${chars.toLocaleString()} characters for the agent.`);
		} catch (e) {
			setError(messageOf(e, "Couldn't fetch the knowledge URL."));
		}
	}

	const shownName = draft.displayName.trim() || draft.name.trim() || "Untitled";

	return (
		<div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
			<div className="min-w-0 space-y-5 rounded-[8px] bg-card p-4 ring-1 ring-border sm:p-5">
				<div className="grid gap-4 sm:grid-cols-2">
					<SettingsField label="Name" value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={PRODUCT_NAME_MAX} />
					<SettingsField
						label="Display name"
						value={draft.displayName}
						onChange={(e) => set("displayName", e.target.value)}
						maxLength={PRODUCT_NAME_MAX}
						placeholder={draft.name}
						hint="Shown to recipients. Defaults to the name."
					/>
				</div>

				<SettingsField
					label="Domains"
					value={draft.domains}
					onChange={(e) => set("domains", e.target.value)}
					placeholder="acme.com, mail.acme.com"
					hint={
						unknownDomains.length
							? `Not a domain this deployment serves yet: ${unknownDomains.join(", ")}.`
							: "Comma-separated. Subdomains inherit the product."
					}
				/>
				<SettingsField
					label="Extra aliases"
					value={draft.aliases}
					onChange={(e) => set("aliases", e.target.value)}
					placeholder="hello@shared.dev"
					hint="Addresses on other domains that should still sign as this product."
				/>

				<div className="space-y-1.5">
					<label htmlFor={`accent-${product.id}`} className="block text-[11px] font-medium text-text-secondary">
						Accent colour
					</label>
					<div className="flex flex-wrap items-center gap-2">
						<input
							id={`accent-${product.id}`}
							type="color"
							value={accent}
							onChange={(e) => set("accentColor", e.target.value)}
							className="h-9 w-12 cursor-pointer rounded-[6px] border border-border bg-bg-subtle p-1"
						/>
						<input
							type="text"
							value={draft.accentColor}
							onChange={(e) => set("accentColor", e.target.value.trim())}
							placeholder={badgeColor(product)}
							maxLength={7}
							aria-label="Accent colour hex value"
							className={cn(SETTINGS_INPUT_CLASS, "w-28 font-mono")}
						/>
						{draft.accentColor && (
							<button type="button" onClick={() => set("accentColor", "")} className={SECONDARY_BUTTON_CLASS}>
								Use default
							</button>
						)}
					</div>
					{contrast !== null && contrast < MIN_UI_CONTRAST && (
						<p role="status" className="text-xs text-warning-text">
							{draft.accentColor.toUpperCase()} is {contrast.toFixed(2)}:1 on white; buttons on the unsubscribe page switch to dark text.
						</p>
					)}
				</div>

				<div className="space-y-1.5">
					<span className="block text-[11px] font-medium text-text-secondary">Logo</span>
					<div className="flex flex-wrap items-center gap-3">
						<div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-[6px] border border-border bg-bg-subtle">
							{product.logoUrl ? (
								<img src={product.logoUrl} alt={`${shownName} logo`} className="h-full w-full object-contain p-1" />
							) : (
								<ImageIcon size={16} className="text-text-tertiary" aria-hidden />
							)}
						</div>
						<input
							ref={fileInput}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							className="hidden"
							tabIndex={-1}
							aria-hidden="true"
							onChange={(e) => void onPickLogo(e.target.files?.[0])}
						/>
						<button type="button" onClick={() => fileInput.current?.click()} disabled={uploadLogo.isPending} className={SECONDARY_BUTTON_CLASS}>
							{uploadLogo.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Upload size={13} aria-hidden />}
							{product.logoUrl ? "Replace" : "Upload"}
						</button>
						{product.logoUrl && (
							<button
								type="button"
								onClick={() => void deleteLogo.mutateAsync(product.id).catch((e) => setError(messageOf(e, "Couldn't remove the logo.")))}
								className="text-xs text-text-secondary hover:text-destructive"
							>
								Remove
							</button>
						)}
					</div>
					<p className="text-xs text-text-tertiary">
						PNG, JPEG, WebP or GIF up to 512 KB. Public: it appears on the unsubscribe page and in templates.
					</p>
				</div>

				<div className="space-y-1.5">
					<span className="block text-[11px] font-medium text-text-secondary">Default signature</span>
					<LazyEditor value={draft.signatureHtml} onChange={(html: string) => set("signatureHtml", html)} ariaLabel="Default signature" />
					<p className="text-xs text-text-tertiary">
						Added when a message is written from this product's addresses, and swapped when From changes.
					</p>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={`tone-${product.id}`} className="block text-[11px] font-medium text-text-secondary">
						Reply tone for the agent
					</label>
					<textarea
						id={`tone-${product.id}`}
						value={draft.agentPrompt}
						onChange={(e) => set("agentPrompt", e.target.value)}
						maxLength={AGENT_PROMPT_MAX}
						rows={3}
						placeholder="Friendly and brief. Sign off as the Acme team. Never promise refunds; link to the billing page instead."
						className={cn(SETTINGS_INPUT_CLASS, "h-auto py-2")}
					/>
					<p className="text-xs text-text-tertiary">
						Added after the agent's own rules, so it shapes voice but can't turn off draft-only or injection checks.
					</p>
					<p className="text-right text-[11px] tabular-nums text-text-tertiary" aria-live="polite">
						{draft.agentPrompt.length}/{AGENT_PROMPT_MAX}
					</p>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={`knowledge-${product.id}`} className="block text-[11px] font-medium text-text-secondary">
						Knowledge for the agent
					</label>
					<textarea
						id={`knowledge-${product.id}`}
						value={draft.knowledgeText}
						onChange={(e) => set("knowledgeText", e.target.value)}
						maxLength={KNOWLEDGE_MAX}
						rows={4}
						placeholder="Pricing, plans, common questions, links to docs…"
						className={cn(SETTINGS_INPUT_CLASS, "h-auto py-2")}
					/>
					<div className="flex flex-wrap items-end gap-2">
						<SettingsField
							label="Or fetch from a URL"
							type="url"
							value={draft.knowledgeUrl}
							onChange={(e) => set("knowledgeUrl", e.target.value)}
							placeholder="https://acme.com/faq"
							className="min-w-[220px] flex-1"
						/>
						<button
							type="button"
							onClick={() => void onRefresh()}
							disabled={!draft.knowledgeUrl.trim() || refresh.isPending}
							className={SECONDARY_BUTTON_CLASS}
						>
							{refresh.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />}
							Fetch now
						</button>
					</div>
					<p className="text-xs text-text-tertiary">
						{product.knowledgeFetchedAt
							? `Last fetched ${new Date(product.knowledgeFetchedAt).toLocaleString()}.`
							: "Fetched pages are stored as text for the agent, up to 8,000 characters."}
					</p>
				</div>

				{templates.length > 0 && (
					<fieldset className="space-y-1.5">
						<legend className="text-[11px] font-medium text-text-secondary">Default templates</legend>
						<div className="flex flex-wrap gap-1.5">
							{templates.slice(0, 30).map((t) => {
								const on = draft.defaultTemplates.includes(t.slug);
								return (
									<button
										key={t.slug}
										type="button"
										aria-pressed={on}
										onClick={() =>
											set(
												"defaultTemplates",
												on ? draft.defaultTemplates.filter((s) => s !== t.slug) : [...draft.defaultTemplates, t.slug].slice(0, 10),
											)
										}
										className={cn(
											"inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium touch:h-11",
											on ? "border-text-primary bg-bg-muted text-text-primary" : "border-border text-text-secondary hover:bg-bg-muted",
										)}
									>
										{t.name}
									</button>
								);
							})}
						</div>
						<p className="text-xs text-text-tertiary">Listed first in the composer's template menu for this product.</p>
					</fieldset>
				)}

				<InlineError message={error} />

				<div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
					<button type="button" onClick={() => void onSave()} disabled={!dirty || update.isPending} className={PRIMARY_BUTTON_CLASS}>
						{update.isPending && <Loader2 size={13} className="animate-spin" aria-hidden />}
						{update.isPending ? "Saving…" : "Save"}
					</button>
					{dirty && (
						<button type="button" onClick={() => setDraft(toDraft(product))} className="text-sm text-text-secondary hover:underline">
							Discard changes
						</button>
					)}
					<div className="flex-1" />
					<button type="button" onClick={() => setConfirmDelete(true)} className={DANGER_BUTTON_CLASS}>
						<Trash2 size={13} aria-hidden />
						Delete
					</button>
				</div>
			</div>

			<ProductPreview
				productId={product.id}
				name={shownName}
				accent={accent}
				logoUrl={product.logoUrl}
				signatureHtml={draft.signatureHtml}
				domain={list(draft.domains)[0] ?? ""}
			/>

			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete ${product.name}?`}
				description="Its domains and aliases go back to the deployment's own branding and no signature. Mail is not touched. Domains do not get a new default product."
				confirmLabel="Delete product"
				pending={remove.isPending}
				onConfirm={() =>
					void remove
						.mutateAsync(product.id)
						.then(() => {
							setConfirmDelete(false);
							toast.info(`Deleted ${product.name}.`);
						})
						.catch((e) => setError(messageOf(e, "Couldn't delete the product.")))
				}
			/>
		</div>
	);
}

/** Live preview: the signature as inserted, and the unsubscribe page. */
function ProductPreview({
	productId,
	name,
	accent,
	logoUrl,
	signatureHtml,
	domain,
}: {
	productId: string;
	name: string;
	accent: string;
	logoUrl: string | null;
	signatureHtml: string;
	domain: string;
}) {
	const onAccent = (contrastRatio(accent, "#FFFFFF") ?? 0) >= 4.5 ? "#ffffff" : "#111113";
	return (
		<aside aria-label="Preview" className="min-w-0 space-y-3 xl:sticky xl:top-20 xl:self-start">
			<div className="rounded-[8px] bg-card p-4 ring-1 ring-border">
				<p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Message</p>
				{/* The email body is shown on white, as most mail clients render it. */}
				<div className="rounded-[6px] bg-white p-3 text-[13px] leading-relaxed text-[#1f2937] ring-1 ring-black/5">
					<p>Hi Sam,</p>
					<p className="mt-2">Thanks for getting in touch. Here's what I found.</p>
					{signatureHtml.trim() ? (
						<div
							className="mt-3 border-t border-[#ddd] pt-3 text-[#666]"
							// Sanitised: this renders inline in the app, not in the sandboxed frame.
							dangerouslySetInnerHTML={{ __html: sanitizeInlineHtml(renderProductSignature(productId, signatureHtml)) }}
						/>
					) : (
						<p className="mt-3 text-xs italic text-[#6b7280]">No signature: messages go out unsigned.</p>
					)}
				</div>
			</div>
			<div className="rounded-[8px] bg-card p-4 ring-1 ring-border">
				<p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Unsubscribe page</p>
				<div className="rounded-[6px] bg-[#f7f7f8] p-3 dark:bg-[#111113]">
					<div className="rounded-[8px] border border-[#e5e7eb] bg-white p-4 dark:border-[#2e2e33] dark:bg-[#1c1c1f]" style={{ borderTop: `4px solid ${accent}` }}>
						{logoUrl ? (
							<img src={logoUrl} alt="" className="mb-2 max-h-8 max-w-[120px] object-contain" />
						) : (
							<p className="mb-2 text-xs font-semibold text-[#1f2937] dark:text-[#f3f4f6]">{name}</p>
						)}
						<p className="text-sm font-semibold text-[#1f2937] dark:text-[#f3f4f6]">Unsubscribe from {name}?</p>
						<p className="mt-1 text-xs text-[#4b5563] dark:text-[#a1a1aa]">
							you@example.com will stop receiving marketing email from {domain || "this domain"}.
						</p>
						<span
							className="mt-3 inline-flex h-8 items-center rounded-[6px] px-3 text-xs font-semibold"
							style={{ backgroundColor: accent, color: onAccent }}
						>
							Unsubscribe
						</span>
					</div>
				</div>
			</div>
		</aside>
	);
}
