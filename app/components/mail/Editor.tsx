/**
 * Rich text editor for the composer.
 *
 * TipTap with the extension set outbound email actually needs: marks, lists,
 * links, quotes and tables. Table resizing stays off so the serialised HTML
 * survives the trip through other mail clients.
 */

import TiptapImage from "@tiptap/extension-image";
import LinkExtension from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table/kit";
import TextAlign from "@tiptap/extension-text-align";

import Underline from "@tiptap/extension-underline";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	Bold,
	Image as ImageIcon,
	Italic,
	Link as LinkIcon,
	List,
	ListOrdered,
	Minus,
	Quote,
	Redo2,
	RemoveFormatting,
	Strikethrough,
	Table as TableIcon,
	Underline as UnderlineIcon,
	Undo2,
	Unlink,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn, fileToBase64, formatBytes, validateAttachment } from "~/lib/utils";
import { rankSnippets, type SnippetTemplate } from "~/lib/snippets";
import { SignatureBlock } from "./signature-node";
import { dismissToast, showToast, type ToastAction } from "~/lib/toast";
import { htmlToPlainText, keepOriginalHtml, plainTextToHtml } from "~/lib/paste-clean";
import {
	ClearFormatting,
	LINK_OPTIONS,
	PasteCleanup,
	SafeColor,
	SafeHighlight,
	SafeTextStyle,
	replaceLastPaste,
	type PastedInfo,
} from "./paste-extension";
import SnippetMenu, {
	SNIPPET_LISTBOX_ID,
	snippetOptionId,
} from "~/components/mail/SnippetMenu";
import {
	SnippetExtension,
	insertSnippet,
	type SnippetHandlers,
	type SnippetMenuState,
} from "~/components/mail/snippet-extension";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { editorBodyHtml, normalizeEditorInput } from "~/lib/editor-html";
import { clearHistory, endOfMessageText, patchContent, replaceContent } from "./editor-history";
import { MailKeys } from "./mail-keys";

interface EditorProps {
	value: string;
	onChange: (value: string) => void;
	/** Reports inline-image failures so the composer can surface them. */
	onError?: (message: string) => void;
	placeholder?: string;
	className?: string;
	/**
	 * Put the caret in the body on mount. Off by default: a new message wants the
	 * caret in the To field, and this editor used to take it regardless.
	 * `"start"` is for a reply, whose first line sits above the signature and
	 * the quote; `true` and `"end"` put it after the writer's last line, before
	 * a signature or a quoted original (a reopened draft).
	 */
	autoFocus?: boolean | "start" | "end";
	/**
	 * Drop the editor's own border and radius, for a host that already frames
	 * it. In the composer the box sat inside the window's border, a frame inside
	 * a frame.
	 */
	bare?: boolean;
	/**
	 * Receives a small handle once the editor exists, for hosts that insert
	 * content at the caret (template variable chips).
	 */
	onReady?: (handle: EditorHandle) => void;
	/** Accessible name for the editable region. */
	ariaLabel?: string;
	/**
	 * Templates offered by typing `;` in the body. Omit to turn snippets off
	 * (the signature editor has no use for them).
	 */
	snippets?: SnippetTemplate[];
	/** Values for `{{first_name}}` and friends, read at insert time. */
	snippetVariables?: () => Record<string, string>;
	/** Receives the editor once it exists, for inserting from outside. */
	onEditor?: (editor: TiptapEditor | null) => void;
	/**
	 * Called when the editor loads `source` and its own form of it differs
	 * (`<div><br></div>` lines, a `<br>` ending a block). No `onChange` follows
	 * a load, so a host that compares bodies to decide whether to save can adopt
	 * `normalized` as the saved form rather than see an edit nobody made.
	 */
	onNormalize?: (source: string, normalized: string) => void;
	/**
	 * What is being edited: the draft, reply or forward. When it changes, the
	 * next `value` loads as a new document (caret at the start, undo history
	 * cleared). Other changes to `value` are edits by the host, such as a
	 * signature swapped for another From, and are patched in place.
	 */
	documentKey?: unknown;
}

export interface EditorHandle {
	/** Insert plain text at the caret, replacing any selection. */
	insertText: (text: string) => void;
	focus: () => void;
}

/** The caret position for `autoFocus`. */
function focusTarget(editor: TiptapEditor, autoFocus: true | "start" | "end"): "start" | number {
	return autoFocus === "start" ? "start" : endOfMessageText(editor.state.doc);
}

/*
  Block spacing, list markers, quotes and tables come from `.mail-editor` in
  index.css, which mirrors the reader so a draft looks the same in both.
*/
const EDITOR_CLASS = "mail-editor focus:outline-none min-h-[200px] px-4 py-3 text-text-primary";

export default function Editor({
	value,
	onChange,
	onError,
	placeholder,
	bare = false,
	className,
	autoFocus,
	onReady,
	ariaLabel,
	snippets,
	snippetVariables,
	onEditor,
	onNormalize,
	documentKey,
}: EditorProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);

	/*
	  Snippet popup state. The extension reports through `snippetHandlers`, a
	  ref read on every keystroke, so the editor is built once and still sees
	  the latest templates, recipient and highlighted row.
	*/
	const [menu, setMenu] = useState<SnippetMenuState>({
		open: false,
		query: "",
		range: null,
		rect: null,
	});
	const [activeIndex, setActiveIndex] = useState(0);
	const snippetHandlers = useRef<SnippetHandlers | null>(null);
	/*
	  The paste toast. The raw clipboard of the last cleaned paste lives in the
	  plugin state (outside the document and the undo history); this ref only
	  maps it to the toast showing for it, so an edit can close a stale offer.
	*/
	const pasteToastRef = useRef<{ pasteId: number; toastId: string } | null>(null);
	const pasteHandlers = useRef<{
		onPasted: (info: PastedInfo, editor: TiptapEditor) => void;
		onSettled: (id: number) => void;
		onFiles: (files: File[]) => void;
	} | null>(null);
	pasteHandlers.current = {
		onPasted: (info, ed) => {
			if (pasteToastRef.current) dismissToast(pasteToastRef.current.toastId);
			const text = info.raw.text || (info.raw.html ? htmlToPlainText(info.raw.html) : "");
			const actions: ToastAction[] = [];
			if (info.raw.html) {
				actions.push({
					label: "Keep original formatting",
					onClick: (dismiss: () => void) => {
						replaceLastPaste(ed, info.id, keepOriginalHtml(info.raw.html));
						dismiss();
					},
				});
			}
			if (text) {
				actions.push({
					label: "Paste as plain text",
					onClick: (dismiss: () => void) => {
						replaceLastPaste(ed, info.id, plainTextToHtml(text));
						dismiss();
					},
				});
			}
			// Images over the paste size ceiling are left out, never silently.
			const imageNote =
				info.droppedImages > 0
					? `${info.droppedImages === 1 ? "An image was" : `${info.droppedImages} images were`} over 1 MB and left out. Attach ${info.droppedImages === 1 ? "it" : "them"} with the image button instead.`
					: undefined;
			if (actions.length === 0 && !imageNote) return;
			const message =
				info.kind === "markdown"
					? "Formatted as Markdown"
					: info.kind === "terminal"
						? "Pasted as a code block"
						: info.removed > 0
							? "Pasted without its colours and fonts"
							: "Pasted";
			const toastId = showToast({
				kind: imageNote ? "warning" : "info",
				message,
				description: imageNote,
				actions,
				durationMs: 6000,
				id: "composer-paste",
			});
			pasteToastRef.current = { pasteId: info.id, toastId };
		},
		onSettled: (id) => {
			if (pasteToastRef.current?.pasteId === id) {
				dismissToast(pasteToastRef.current.toastId);
				pasteToastRef.current = null;
			}
		},
		// A screenshot or copied image file goes through the same checks as the
		// image button. Called after this render, so `insertImage` exists.
		onFiles: (files) => {
			for (const file of files) void insertImage(file);
		},
	};
	const snippetsEnabled = snippets !== undefined;
	const matches = menu.open ? rankSnippets(snippets ?? [], menu.query) : [];

	/*
	  Options held stable across renders.

	  `useEditor` compares its options with the editor's on every render and
	  calls `setOptions` when anything differs. Fresh `.configure()` objects, a
	  fresh `editorProps` and the latest `value` all differ every time, so each
	  render reconfigured the editor and rebuilt its plugins, which reset the
	  snippet picker's state on every arrow key. Content after mount is kept in
	  sync by the reconcile effect below, not by these options.
	*/
	const initialValueRef = useRef(value);
	const initialContentRef = useRef(normalizeEditorInput(value));
	/**
	 * The last body this editor reported or was handed. When `value` comes back
	 * equal to it, the host is echoing the editor and there is nothing to load.
	 */
	const lastValueRef = useRef(value);
	/** Set by the first edit; until then a body that arrives late may move the caret. */
	const editedRef = useRef(false);
	/** Set when `documentKey` changes, until the new body loads or the user types. */
	const documentKeyRef = useRef(documentKey);
	const newDocumentRef = useRef(false);
	const onNormalizeRef = useRef(onNormalize);
	onNormalizeRef.current = onNormalize;
	const extensions = useMemo(
		() => [
			// StarterKit v3 bundles Link and Underline; turn those off here so the
			// configured copies below are the only ones (TipTap warned about the
			// duplicate names on every mount).
			StarterKit.configure({ link: false, underline: false }),
			// Cmd/Ctrl+Enter sends; without this it also typed a line break.
			MailKeys,
			Underline,
			TextAlign.configure({ types: ["heading", "paragraph"] }),
			// Autolinks only http(s), `www.` and email addresses, so pasted code
			// such as `env.DEV_AUTH_BYPASS` stays text. See paste-extension.ts.
			LinkExtension.configure(LINK_OPTIONS),
			TiptapImage.configure({ allowBase64: true }),
			SafeTextStyle,
			// Colours and highlights set from code are kept; from HTML only
			// readable ones are parsed, and highlights pin a dark text colour.
			SafeColor,
			SafeHighlight.configure({ multicolor: true }),
			TableKit.configure({ table: { resizable: false } }),
			// Keeps `div.email-signature` whole so a product signature can be swapped.
			SignatureBlock,
			// Pastes keep structure and lose presentation; see ~/lib/paste-clean.
			PasteCleanup.configure({
				onPasted: (info, ed) => pasteHandlers.current?.onPasted(info, ed),
				onPasteSettled: (id) => pasteHandlers.current?.onSettled(id),
				onPasteFiles: (files) => pasteHandlers.current?.onFiles(files),
			}),
			ClearFormatting,
			// Renders `placeholder` through the `.is-editor-empty` rule in
			// index.css. A bare `data-placeholder` attribute displayed nothing.
			...(placeholder ? [Placeholder.configure({ placeholder })] : []),
			...(snippetsEnabled
				? [SnippetExtension.configure({ getHandlers: () => snippetHandlers.current })]
				: []),
		],
		[placeholder, snippetsEnabled],
	);
	const editorProps = useMemo(
		() => ({
			attributes: {
				class: EDITOR_CLASS,
				role: "textbox",
				"aria-multiline": "true",
				...(ariaLabel ? { "aria-label": ariaLabel } : {}),
			},
		}),
		[ariaLabel],
	);

	const editor = useEditor({
		extensions,
		content: initialContentRef.current,
		editorProps,
		onUpdate: ({ editor }) => {
			editedRef.current = true;
			newDocumentRef.current = false;
			const html = editorBodyHtml(editor);
			lastValueRef.current = html;
			onChange(html);
		},
	});

	// The opening content, as the editor writes it. See `onNormalize`.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const source = initialValueRef.current;
		const html = editorBodyHtml(editor);
		if (source.trim() !== "" && html !== source) onNormalizeRef.current?.(source, html);
	}, [editor]);

	useEffect(() => {
		onEditor?.(editor ?? null);
		return () => onEditor?.(null);
	}, [editor, onEditor]);

	const pickSnippet = useCallback(
		(template: SnippetTemplate) => {
			if (!editor || !menu.range) return;
			insertSnippet(editor, menu.range, template, snippetVariables?.() ?? {});
			setMenu({ open: false, query: "", range: null, rect: null });
		},
		[editor, menu.range, snippetVariables],
	);

	// Rebuilt every render so the plugin always acts on the current list.
	snippetHandlers.current = {
		// The plugin only reports when the query or position changes, and a new
		// query means a new ranking, so the highlight goes back to the top.
		onState: (next) => {
			setMenu(next);
			setActiveIndex(0);
		},
		onKey: (event) => {
			if (matches.length === 0) return false;
			if (event.key === "ArrowDown") {
				setActiveIndex((i) => (i + 1) % matches.length);
				return true;
			}
			if (event.key === "ArrowUp") {
				setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
				return true;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				pickSnippet(matches[Math.min(activeIndex, matches.length - 1)]);
				return true;
			}
			return false;
		},
	};

	/*
	  The editor keeps focus while the popup is open, so the listbox is tied to
	  the editable region itself. It is a multi-line `textbox`, which supports
	  `aria-autocomplete`, `aria-controls` and `aria-activedescendant` (but not
	  `aria-expanded`); the live region below announces the result count.
	*/
	useEffect(() => {
		const dom = editor && !editor.isDestroyed ? editor.view.dom : null;
		if (!dom || !snippetsEnabled) return;
		dom.setAttribute("aria-autocomplete", "list");
		if (menu.open && matches.length > 0) {
			dom.setAttribute("aria-controls", SNIPPET_LISTBOX_ID);
			dom.setAttribute(
				"aria-activedescendant",
				snippetOptionId(Math.min(activeIndex, matches.length - 1)),
			);
		} else {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
		}
	}, [editor, snippetsEnabled, menu.open, matches.length, activeIndex]);

	// A new draft, reply or forward: the next body is a new document, and
	// nothing typed in the previous one can be undone into it, even when the
	// two bodies happen to be the same.
	useEffect(() => {
		if (documentKeyRef.current === documentKey) return;
		documentKeyRef.current = documentKey;
		newDocumentRef.current = true;
		editedRef.current = false;
		if (editor && !editor.isDestroyed) clearHistory(editor);
	}, [documentKey, editor]);

	/*
	  A body handed in from outside. Neither path fires `onChange` (autosave
	  would have saved an untouched draft) or adds an undo step (Cmd+Z used to
	  empty the body).

	  - The first body, or another draft opened in the same composer, loads as
	    a new document: caret at the start, history cleared, so undo can't bring
	    back the previous draft.
	  - Anything later is the host editing the open body, usually a signature
	    that arrives after the composer opened or is swapped for another From.
	    Only the part that changed is replaced, so the caret and the undo
	    history stay where they were. Replacing the whole body here moved the
	    caret into the signature while the user was typing.

	  Inserts the user asks for (templates, signatures) go through the editor at
	  the caret instead.
	*/
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		// The host echoing what the editor just reported.
		if (value === lastValueRef.current) return;
		lastValueRef.current = value;
		if (value === editorBodyHtml(editor)) return;
		// An empty document serialises to "<p></p>", never the empty string the
		// composer starts with.
		if (value.trim() === "" && editor.isEmpty) return;
		const fresh = newDocumentRef.current || (editor.isEmpty && !editedRef.current);
		newDocumentRef.current = false;
		if (fresh) {
			replaceContent(editor, normalizeEditorInput(value));
			editedRef.current = false;
		} else {
			patchContent(editor, normalizeEditorInput(value));
		}
		const html = editorBodyHtml(editor);
		if (html !== value) onNormalizeRef.current?.(value, html);
		// The body usually arrives just after mount, which moved the caret the
		// first focus put in place.
		if (fresh && autoFocus && !editedRef.current) {
			const raf = requestAnimationFrame(() => {
				if (!editor.isDestroyed) editor.commands.focus(focusTarget(editor, autoFocus));
			});
			return () => cancelAnimationFrame(raf);
		}
	}, [value, editor, autoFocus]);

	// Once per mount, and only when asked: a new message wants the caret in To.
	const focusedRef = useRef(false);
	useEffect(() => {
		if (!editor || editor.isDestroyed || !autoFocus || focusedRef.current) return;
		focusedRef.current = true;
		editor.commands.focus(focusTarget(editor, autoFocus));
	}, [editor, autoFocus]);

	useEffect(() => {
		if (!editor || !onReady) return;
		onReady({
			insertText: (text) => {
				if (!editor.isDestroyed) editor.chain().focus().insertContent(text).run();
			},
			focus: () => {
				if (!editor.isDestroyed) editor.commands.focus();
			},
		});
	}, [editor, onReady]);

	const setLink = useCallback(() => {
		if (!editor) return;
		const previous = editor.getAttributes("link").href as string | undefined;
		const url = window.prompt("Link URL", previous ?? "https://");
		if (url === null) return;
		if (url.trim() === "") {
			editor.chain().focus().extendMarkRange("link").unsetLink().run();
			return;
		}
		editor
			.chain()
			.focus()
			.extendMarkRange("link")
			.setLink({ href: url.trim() })
			.run();
	}, [editor]);

	/**
	 * Inline images are embedded as data URLs rather than uploaded, because the
	 * send path base64-encodes attachments anyway and this keeps a picture in the
	 * body from needing a second round trip before the message exists.
	 */
	const insertImage = useCallback(
		async (file: File) => {
			if (!editor) return;
			const check = validateAttachment(file);
			if (!check.valid) {
				onError?.(check.error ?? `${file.name} is too large.`);
				return;
			}
			try {
				const base64 = await fileToBase64(file);
				editor
					.chain()
					.focus()
					.setImage({
						src: `data:${file.type || "image/png"};base64,${base64}`,
						alt: file.name,
					})
					.run();
			} catch {
				onError?.(`Could not read ${file.name} (${formatBytes(file.size)}).`);
			}
		},
		[editor, onError],
	);

	if (!editor) return null;

	const ToolbarButton = ({
		label,
		active,
		disabled,
		onClick,
		children,
	}: {
		label: string;
		active?: boolean;
		disabled?: boolean;
		onClick: () => void;
		children: React.ReactNode;
	}) => (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={active}
			className={cn(
				"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] transition-colors disabled:opacity-40",
				active
					? "bg-bg-muted text-text-primary"
					: "text-text-secondary hover:bg-bg-subtle hover:text-text-primary",
			)}
		>
			{children}
		</button>
	);

	return (
		<div
			className={cn(
				"flex min-h-0 flex-col overflow-hidden bg-card",
				!bare && "rounded-[8px] border border-border",
				className,
			)}
		>
			<div
				className={cn(
					"flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1",
					/*
					  One scrolling row on touch rather than three wrapped ones: at 44px
					  a dozen format buttons need 530px, and every wrapped row comes
					  out of the space for typing. Scrollbar hidden; the cut-off
					  button at the edge says there is more.
					*/
					"no-scrollbar touch:flex-nowrap touch:gap-0 touch:overflow-x-auto touch:overscroll-x-contain touch:py-0",
					bare ? "bg-card px-3" : "bg-bg-subtle/70",
				)}
			>
				<ToolbarButton
					label="Bold"
					active={editor.isActive("bold")}
					onClick={() => editor.chain().focus().toggleBold().run()}
				>
					<Bold size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Italic"
					active={editor.isActive("italic")}
					onClick={() => editor.chain().focus().toggleItalic().run()}
				>
					<Italic size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Underline"
					active={editor.isActive("underline")}
					onClick={() => editor.chain().focus().toggleUnderline().run()}
				>
					<UnderlineIcon size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Strikethrough"
					active={editor.isActive("strike")}
					onClick={() => editor.chain().focus().toggleStrike().run()}
				>
					<Strikethrough size={13} />
				</ToolbarButton>

				<ToolbarButton
					label="Clear formatting"
					onClick={() => editor.chain().focus().clearFormatting().run()}
				>
					<RemoveFormatting size={13} />
				</ToolbarButton>

				<span className="mx-1 h-4 w-px bg-border" aria-hidden />

				<ToolbarButton
					label="Bullet list"
					active={editor.isActive("bulletList")}
					onClick={() => editor.chain().focus().toggleBulletList().run()}
				>
					<List size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Numbered list"
					active={editor.isActive("orderedList")}
					onClick={() => editor.chain().focus().toggleOrderedList().run()}
				>
					<ListOrdered size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Quote"
					active={editor.isActive("blockquote")}
					onClick={() => editor.chain().focus().toggleBlockquote().run()}
				>
					<Quote size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Divider"
					onClick={() => editor.chain().focus().setHorizontalRule().run()}
				>
					<Minus size={13} />
				</ToolbarButton>

				<span className="mx-1 h-4 w-px bg-border" aria-hidden />

				<ToolbarButton
					label="Link"
					active={editor.isActive("link")}
					onClick={setLink}
				>
					<LinkIcon size={13} />
				</ToolbarButton>
				{editor.isActive("link") && (
					<ToolbarButton
						label="Remove link"
						onClick={() => editor.chain().focus().unsetLink().run()}
					>
						<Unlink size={13} />
					</ToolbarButton>
				)}
				<ToolbarButton
					label="Insert image"
					onClick={() => fileInputRef.current?.click()}
				>
					<ImageIcon size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Insert table"
					active={editor.isActive("table")}
					onClick={() =>
						editor
							.chain()
							.focus()
							.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
							.run()
					}
				>
					<TableIcon size={13} />
				</ToolbarButton>

				<span className="mx-1 h-4 w-px bg-border" aria-hidden />

				<ToolbarButton
					label="Undo"
					disabled={!editor.can().undo()}
					onClick={() => editor.chain().focus().undo().run()}
				>
					<Undo2 size={13} />
				</ToolbarButton>
				<ToolbarButton
					label="Redo"
					disabled={!editor.can().redo()}
					onClick={() => editor.chain().focus().redo().run()}
				>
					<Redo2 size={13} />
				</ToolbarButton>

				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) void insertImage(file);
						e.target.value = "";
					}}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<EditorContent editor={editor} />
			</div>

			{snippetsEnabled && menu.open && (
				<SnippetMenu
					items={matches}
					activeIndex={Math.min(activeIndex, Math.max(0, matches.length - 1))}
					query={menu.query}
					rect={menu.rect}
					onHover={setActiveIndex}
					onPick={pickSnippet}
				/>
			)}
			{snippetsEnabled && menu.open && (
				<span className="sr-only" aria-live="polite">
					{matches.length === 0
						? "No templates match"
						: `${matches.length} template${matches.length === 1 ? "" : "s"}. Use up and down to choose, Enter to insert.`}
				</span>
			)}
		</div>
	);
}
