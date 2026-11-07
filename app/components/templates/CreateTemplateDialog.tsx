/**
 * Create a template without leaving the current form.
 *
 * The sequence editor used to dead-end with "No templates available" and a
 * link that navigated away, losing whatever had been typed. This dialog
 * creates the template in place and hands it back so the step can select it.
 */

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { extractVariables, slugify } from "~/lib/template-preview";
import api, { type EmailTemplate } from "~/services/api";
import TemplateBodyEditor from "./TemplateBodyEditor";

const INPUT_CLASS =
	"h-11 w-full rounded-[6px] border border-border bg-card px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-violet/40 sm:h-9";

export default function CreateTemplateDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (template: EmailTemplate) => void;
}) {
	const queryClient = useQueryClient();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = useId();

	useEffect(() => {
		if (!open) return;
		setName("");
		setSlug("");
		setSlugTouched(false);
		setSubject("");
		setBody("");
		setError(null);
	}, [open]);

	const effectiveSlug = slugTouched ? slug : slugify(name);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		// React bubbles portal events through the component tree; a host that
		// renders this inside its own <form> must not see this submit.
		e.stopPropagation();
		if (!name.trim() || !effectiveSlug) {
			setError("A name is required.");
			return;
		}
		if (!subject.trim()) {
			setError("A subject is required.");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const created = await api.createTemplate({
				slug: effectiveSlug,
				name: name.trim(),
				subject,
				bodyHtml: body,
			});
			await queryClient.invalidateQueries({ queryKey: ["templates"] });
			onCreated(created);
			onOpenChange(false);
		} catch (err) {
			setError((err as Error).message || "Couldn't create the template.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle className="text-base">Create a template</DialogTitle>
						<DialogDescription className="text-xs">
							Saved to Templates and selected for this step. Your sequence stays as you left it.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1.5">
							<label htmlFor={`${id}-name`} className="block text-xs font-medium text-text-secondary">
								Name
							</label>
							<input
								id={`${id}-name`}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Welcome email"
								className={INPUT_CLASS}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<label htmlFor={`${id}-slug`} className="block text-xs font-medium text-text-secondary">
								Slug
							</label>
							<input
								id={`${id}-slug`}
								value={effectiveSlug}
								onChange={(e) => {
									setSlugTouched(true);
									setSlug(slugify(e.target.value));
								}}
								placeholder="welcome-email"
								spellCheck={false}
								className={`${INPUT_CLASS} font-mono`}
							/>
						</div>
					</div>
					<div className="space-y-1.5">
						<label htmlFor={`${id}-subject`} className="block text-xs font-medium text-text-secondary">
							Subject
						</label>
						<input
							id={`${id}-subject`}
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
							placeholder="Welcome to {{company_name}}"
							className={INPUT_CLASS}
							required
						/>
					</div>
					<div className="space-y-1.5">
						<span className="block text-xs font-medium text-text-secondary">Body</span>
						<TemplateBodyEditor
							value={body}
							onChange={setBody}
							subject={subject}
							variables={extractVariables(subject, body)}
							initialMode="rich"
							minHeightClass="min-h-[220px]"
						/>
					</div>
					{error ? (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					) : null}
					<DialogFooter className="gap-2">
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className="inline-flex min-h-11 items-center justify-center rounded-[6px] px-3.5 text-[13px] font-medium text-text-primary ring-1 ring-border hover:bg-bg-muted sm:min-h-9"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={saving}
							className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[6px] bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground hover:bg-accent-hover disabled:opacity-50 sm:min-h-9"
						>
							{saving ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
							Create and use
						</button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
