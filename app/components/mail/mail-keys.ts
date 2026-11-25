/**
 * Keys the composer owns, ahead of the editor's own bindings.
 *
 * Cmd/Ctrl+Enter sends; the composer listens for it on its window. TipTap's
 * HardBreak binds the same key to a line break, so the keydown did both: a
 * stray `<br>` went into the body at the caret as the message went out.
 * Claiming the key here stops the line break and leaves the event to bubble
 * (ProseMirror calls `preventDefault`, not `stopPropagation`), so the send
 * still happens. Shift+Enter stays the line break.
 */

import { Extension } from "@tiptap/core";

export const MailKeys = Extension.create({
	name: "mailKeys",
	// Above HardBreak (100) and the list keymaps.
	priority: 1000,

	addKeyboardShortcuts() {
		return {
			"Mod-Enter": () => true,
		};
	},
});
