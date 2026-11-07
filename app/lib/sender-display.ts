/**
 * What the list shows for a sender when all it has is an address.
 *
 * The list projection carries addresses only, so a row read "priya" or
 * "receipts". Title-casing the local part ("priya.sharma" → "Priya Sharma") is
 * the closest the client can get to a display name without one being stored;
 * role mailboxes like "noreply" get the domain's name instead, which is what
 * the reader actually recognises ("Github", "Stripe").
 */
const ROLE_LOCAL_PARTS = new Set([
	"noreply",
	"no-reply",
	"no_reply",
	"donotreply",
	"do-not-reply",
	"notifications",
	"notification",
	"notify",
	"info",
	"hello",
	"hi",
	"team",
	"support",
	"help",
	"mail",
	"mailer",
	"admin",
	"news",
	"newsletter",
	"updates",
	"receipts",
	"billing",
	"ship",
	"health",
	"accounts",
	"account",
	"security",
	"alerts",
]);

function titleCase(word: string): string {
	return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * Brands whose name is not their domain title-cased. Short, and only the
 * senders nearly every mailbox receives from; anything else falls through.
 */
const BRAND_NAMES: Record<string, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	linkedin: "LinkedIn",
	youtube: "YouTube",
	paypal: "PayPal",
	makenotion: "Notion",
	mongodb: "MongoDB",
	hubspot: "HubSpot",
	digitalocean: "DigitalOcean",
	cloudflare: "Cloudflare",
	devpost: "Devpost",
	openai: "OpenAI",
	icloud: "iCloud",
};

/** The registrable-looking name of a domain: "mail.github.com" → "GitHub". */
function domainLabel(domain: string): string {
	const parts = domain.toLowerCase().split(".").filter(Boolean);
	if (parts.length === 0) return "";
	// Second-level label, skipping common country second levels (co.uk, com.au).
	const sld = parts.length >= 3 && /^(co|com|net|org|ac|gov)$/.test(parts[parts.length - 2])
		? parts[parts.length - 3]
		: parts[Math.max(0, parts.length - 2)];
	if (BRAND_NAMES[sld]) return BRAND_NAMES[sld];
	// Two- and three-letter names are almost always initialisms: AWS, IBM, HP.
	if (sld.length <= 3) return sld.toUpperCase();
	return titleCase(sld);
}

/**
 * The name to show for a sender: the stored `From:` display name when there is
 * one (`sender_name`, migration 26), the humanised address otherwise.
 */
export function senderDisplayName(address: string, storedName?: string | null): string {
	const stored = storedName?.trim();
	if (stored) return stored;
	const trimmed = address.trim();
	const at = trimmed.lastIndexOf("@");
	if (at <= 0) return trimmed;
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1);
	const bare = local.toLowerCase().replace(/\+.*$/, "");
	if (ROLE_LOCAL_PARTS.has(bare) || /noreply|no-reply/.test(bare)) {
		return domainLabel(domain) || local;
	}
	const words = bare.split(/[._-]+/).filter(Boolean);
	// Opaque local parts (digits, long hashes) read worse title-cased.
	if (words.length === 0 || words.some((w) => /\d{3,}/.test(w))) return local;
	return words.map(titleCase).join(" ");
}

/** One or two initials for an avatar. */
export function senderInitials(address: string, storedName?: string | null): string {
	const name = senderDisplayName(address, storedName);
	const words = name.split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
	if (words.length === 0) return "?";
	if (words.length === 1) return words[0][0].toUpperCase();
	return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * A stable hue per address, so the same sender always gets the same avatar.
 * Eight muted tints rather than a free hue, so no avatar out-shouts the accent.
 */
const AVATAR_TINTS = [
	"bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200",
	"bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200",
	"bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
	"bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200",
	"bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200",
	"bg-teal-100 text-teal-800 dark:bg-teal-500/20 dark:text-teal-200",
	"bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200",
	"bg-slate-200 text-slate-800 dark:bg-slate-500/25 dark:text-slate-200",
] as const;

export function senderAvatarTint(address: string): string {
	let h = 0;
	for (const ch of address.trim().toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return AVATAR_TINTS[h % AVATAR_TINTS.length];
}
