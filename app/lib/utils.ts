import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Attachment, MailboxSettings } from "~/types";
import { MAX_ATTACHMENT_TOTAL_RAW_BYTES } from "../../shared/limits";
import { splitQuotedBody } from "../../shared/quoted-text";
import { htmlToTextLines } from "../../shared/html-text";
import { formatListDate as formatSharedListDate } from "../../shared/dates";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Attachment Utilities ───────────────────────────────────────────

/**
 * Format bytes into human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * URL for an attachment.
 *
 * Pass `inline` when the bytes are going into an `<img>`, an `<iframe>` or the
 * preview overlay. Without it the response carries
 * `Content-Disposition: attachment` and the browser downloads the file instead
 * of rendering it — which is what used to happen when previewing a PDF.
 *
 * The server refuses inline disposition for HTML and SVG regardless, so this
 * flag cannot be used to get executable markup rendered in our origin.
 */
export function getAttachmentUrl(
  mailboxId: string,
  emailId: string,
  attachmentId: string,
  options: { inline?: boolean } = {},
): string {
  const base = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`;
  return options.inline ? `${base}?disposition=inline` : base;
}

/**
 * Filter out inline attachments (images embedded in HTML), returning only regular attachments
 */
export function getNonInlineAttachments(attachments?: Attachment[]): Attachment[] {
  if (!attachments) return [];
  return attachments.filter((att) => att.disposition !== "inline" || !att.content_id);
}

/**
 * Get inline attachments (images embedded in HTML body via content-id)
 */
export function getInlineAttachments(attachments?: Attachment[]): Attachment[] {
  if (!attachments) return [];
  return attachments.filter((att) => att.disposition === "inline" && att.content_id);
}

/**
 * Check if a file is an image based on MIME type
 */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : "";
}

/**
 * Get a human-readable file type from MIME type
 */
export function getFileTypeLabel(mimeType: string): string {
  const typeMap: Record<string, string> = {
    "application/pdf": "PDF",
    "application/msword": "Word",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
    "application/vnd.ms-excel": "Excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
    "application/vnd.ms-powerpoint": "PowerPoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
    "application/zip": "ZIP",
    "application/x-rar-compressed": "RAR",
    "application/x-7z-compressed": "7Z",
    "text/plain": "Text",
    "text/csv": "CSV",
    "text/html": "HTML",
    "application/json": "JSON",
  };
  
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  
  return typeMap[mimeType] || "File";
}

/**
 * Convert a File to a base64 string, without the data-URL prefix.
 *
 * Reads the bytes directly rather than going through `FileReader.readAsDataURL`.
 * The old approach produced a data URL only to slice its prefix back off, and
 * `FileReader` exists only in browsers — which left every send path that encodes
 * an attachment impossible to unit test.
 *
 * Encoded in chunks because `String.fromCharCode(...bytes)` on a multi-megabyte
 * attachment exceeds the argument limit and throws.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Maximum size for a single attachment.
 *
 * Derived from the Cloudflare Email Service 5 MiB per-message ceiling rather
 * than hardcoded: base64 encoding inflates payloads by ~37%, so the raw file
 * budget is well below 5 MiB. See `shared/limits.ts`.
 *
 * This previously claimed 25 MB, which let users attach files the platform
 * would reject — and because sends are dispatched in `waitUntil()`, the failure
 * was invisible in the UI.
 */
export const MAX_ATTACHMENT_SIZE = MAX_ATTACHMENT_TOTAL_RAW_BYTES;

/**
 * Maximum combined size of all attachments on one message.
 */
export const MAX_TOTAL_ATTACHMENTS_SIZE = MAX_ATTACHMENT_TOTAL_RAW_BYTES;

/**
 * Validate attachment file
 */
export function validateAttachment(file: File, currentTotalSize: number = 0): { valid: boolean; error?: string } {
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return { valid: false, error: `File "${file.name}" is ${formatBytes(file.size)}, over the ${formatBytes(MAX_ATTACHMENT_SIZE)} limit` };
  }

  if (currentTotalSize + file.size > MAX_TOTAL_ATTACHMENTS_SIZE) {
    return { valid: false, error: `Attachments would total more than ${formatBytes(MAX_TOTAL_ATTACHMENTS_SIZE)}` };
  }

  return { valid: true };
}

// ── Email Compose Utilities ────────────────────────────────────────

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Format date for compose window display
 */
export function formatComposeDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Wrap signature HTML in the container the composer appends.
 *
 * Shared by the legacy signature in the mailbox settings blob and the stored
 * signatures in the mailbox Durable Object, so both render identically.
 */
export function renderSignatureBlock(innerHtml: string): string {
  if (!innerHtml.trim()) return "";
  return `<div class="email-signature" style="margin-top: 1em; padding-top: 1em; border-top: 1px solid #ddd; color: #666;">${innerHtml}</div>`;
}

/**
 * Get signature block HTML from mailbox settings
 */
export function getSignatureBlock(settings?: MailboxSettings): string {
  if (!settings?.signature?.enabled || !settings.signature.text) {
    return "";
  }
  
  const sigText = settings.signature.html || escapeHtml(settings.signature.text).replace(/\n/g, "<br>");
  return renderSignatureBlock(sigText);
}

/**
 * Build quoted reply block HTML.
 *
 * Only the part the original sender actually wrote is quoted: their own
 * body already ends with the message *they* were replying to, and quoting
 * that too makes the chain grow by a full copy of the thread on every
 * round trip. The earlier messages remain readable in the thread view.
 *
 * The quote is reduced to escaped plain text on purpose — it gets injected
 * into the compose editor, where raw HTML from a remote sender would run.
 */
export function buildQuotedReplyBlock(date: string, sender: string, body: string): string {
  const safeDate = formatComposeDate(date);
  const safeSender = escapeHtml(sender);
  const { visible } = splitQuotedBody(body);
  const quotedBody = escapeHtml(htmlToPlainText(visible)).replace(/\n/g, "<br>");
  
  return `<blockquote style="margin: 1em 0; padding-left: 1em; border-left: 2px solid #ddd; color: #666;">
    <p style="margin: 0 0 0.5em 0;">On ${safeDate}, ${safeSender} wrote:</p>
    <div>${quotedBody}</div>
  </blockquote>`;
}

/**
 * Convert HTML to plain text for text/plain part of emails
 */
export function htmlToPlainText(html: string): string {
  // Entity decoding lives in `shared/html-text` rather than being spelled out
  // here. This function used to decode `&#039;` but not `&#39;`, which is the
  // form the worker's own `escapeHtml` emits — so a body that had already been
  // escaped once picked up a second escape pass and the reader saw a literal
  // `&#39;` in the reading pane.
  return htmlToTextLines(html);
}

/**
 * Split comma-separated email list into array
 */
export function splitEmailList(emailList: string | undefined | null): string[] {
  if (!emailList) return [];
  return emailList
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * Whether a token is a usable address.
 *
 * Deliberately the same shape the server's Zod `.email()` accepts, so the
 * composer can reject an address inline instead of letting the send fail with a
 * generic parse error after the window has already closed.
 */
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL_ADDRESS_RE.test(value.trim());
}

/**
 * Pull the address out of a token, accepting `Name <addr>` as well as a bare
 * address. Returns null when there is no valid address in it.
 */
export function extractEmailAddress(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const angled = trimmed.match(/^\s*(?:.*?)\s*<\s*([^>\s]+)\s*>\s*$/);
  const candidate = angled ? angled[1] : trimmed;
  return isEmailAddress(candidate) ? candidate : null;
}

/**
 * Convert email array to string or undefined (for API)
 */
export function toEmailListValue(emails: string[]): string | string[] | undefined {
  if (emails.length === 0) return undefined;
  if (emails.length === 1) return emails[0];
  return emails;
}

/**
 * Format a unix-seconds timestamp for a list row.
 *
 * Same rule as the mail list (`formatListDate`): time today, "Apr 15" this
 * year, "Apr 15, 2024" before. One format everywhere, rather than a mix of
 * "1m", "2:35 PM" and "Sun" in the same column.
 */
export function formatTime(ts: number) {
  return formatSharedListDate(new Date(ts * 1000).toISOString());
}

/**
 * Format a date for display
 */
export function formatDate(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/**
 * Format a date with time
 */
export function formatDateTime(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Get initials from a name or email
 */
export function initials(name: string | null, email: string): string {
  const source = name || email.split("@")[0];
  const parts = source.split(/[\s.\-_]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return letters.toUpperCase() || "?";
}

/**
 * Deterministic pastel-on-violet palette per person initial
 */
/**
 * Every consumer applies these through an inline `style`, which cannot carry a
 * `dark:` variant, so the theming is done with `light-dark()` instead. That
 * resolves against the `color-scheme` set on <html> by `useThemeStore`, meaning
 * one palette serves both themes and no call site has to know the theme.
 *
 * The tinted backgrounds are raised slightly in dark mode — a 12% wash that
 * reads as colour on white all but disappears on near-black — and the
 * foregrounds are inverted from deep 700-weights to light 300-weights.
 */
const AVATAR_PALETTE = [
  { hue: "124, 92, 252", light: "#5b3ce6", dark: "#c4b5fd" },
  { hue: "34, 197, 94", light: "#15803d", dark: "#86efac" },
  { hue: "244, 114, 182", light: "#be185d", dark: "#f9a8d4" },
  { hue: "251, 146, 60", light: "#c2410c", dark: "#fdba74" },
  { hue: "56, 189, 248", light: "#0369a1", dark: "#7dd3fc" },
  { hue: "168, 85, 247", light: "#7e22ce", dark: "#d8b4fe" },
  { hue: "20, 184, 166", light: "#0f766e", dark: "#5eead4" },
  { hue: "234, 179, 8", light: "#a16207", dark: "#fde047" },
].map(({ hue, light, dark }) => ({
  bg: `light-dark(rgba(${hue}, 0.13), rgba(${hue}, 0.2))`,
  fg: `light-dark(${light}, ${dark})`,
}));

export function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Debounce a function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Strip HTML to plain text
 */
export function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  /*
    `textContent` concatenates text nodes, so adjacent blocks ran together:
    "<h2>This week</h2><p>Three things</p>" became "This weekThree things", and
    "Hi Deeksha,<br>Thanks" became "Hi Deeksha,Thanks" in list snippets. A space
    after every block and line break keeps the words apart; the collapse below
    then folds runs of whitespace back to one.
  */
  doc.body
    .querySelectorAll?.("br, p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, hr")
    .forEach((el) => el.after(" "));
  return (doc.body.textContent || "").replace(/\s+/g, " ");
}

/**
 * Get domain from email address
 */
export function getDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/**
 * Get local part from email address
 */
export function getLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * Download a file from a URL
 */
export function downloadFile(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Format a date for email detail view (more verbose)
 */
export function formatDetailDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format a date for email list view (compact)
 */
export function formatListDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // Same day: show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  
  // Within a week: show day name
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  
  // Same year: show month and day
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  
  // Different year: show full date
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Format a date for short display (e.g., in thread messages)
 */
export function formatShortDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  
  // Same day: show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  
  // Different day: show date and time
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Get a text snippet from HTML body for preview
 */
export function getSnippetText(htmlBody: string | null | undefined, maxLength: number = 200): string {
  if (!htmlBody) return "";
  const text = stripHtml(htmlBody).trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
