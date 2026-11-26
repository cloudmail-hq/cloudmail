/**
 * The few places where the app builds a URL the browser loads by itself (an
 * `<img>` or a download link), which `fetch` interception cannot answer. The
 * demo fills these in before the app renders (see install.ts); callers check
 * `DEMO` first, so nothing here is reachable in a normal build.
 */
export interface DemoHooks {
	/** A `blob:` or `data:` URL for an attachment, made in the page. */
	attachmentUrl?: (mailboxId: string, emailId: string, attachmentId: string) => string;
	/** A `data:` URL for a sender's drawn face, or null for initials. */
	pictureUrl?: (address: string, generated: boolean) => string | null;
}

export const demoHooks: DemoHooks = {};
