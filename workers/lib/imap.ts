// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * A minimal IMAP4rev1 client for importing mail (RFC 3501).
 *
 * Only what an import needs, read-only: CAPABILITY from the greeting, LOGIN or
 * AUTHENTICATE PLAIN, LIST, STATUS, EXAMINE (SELECT's read-only twin, so the
 * server never changes a flag on our account), UID SEARCH, UID FETCH with
 * BODY.PEEK[] (which, unlike BODY[], does not set \Seen), and LOGOUT.
 *
 * The transport is injected: production wraps a Workers `connect()` TLS socket
 * (./mail-import-imap.ts), tests replay recorded server transcripts. Every read
 * has a timeout, and a literal larger than `maxLiteralBytes` aborts the
 * session rather than being buffered.
 *
 * ## Response model
 *
 * A response is a line that may embed literals (`{n}\r\n` + n bytes) and then
 * continue. `readResponse` resolves those into a token tree: strings (atoms and
 * quoted strings), `Uint8Array` (literals), `null` (NIL) and nested arrays
 * (parenthesised lists). Status responses keep their human text too, for
 * response codes like `[UIDVALIDITY n]` and for error messages.
 */

export type ImapToken = string | Uint8Array | null | ImapToken[];

export interface ImapResponse {
	/** `*` untagged, `+` continuation, or the command tag. */
	tag: string;
	tokens: ImapToken[];
	/** For status responses (OK/NO/BAD/BYE/PREAUTH): the text after the status. */
	status: string | null;
	text: string;
}

export interface ImapTransport {
	/** Next chunk from the server, or null at EOF. */
	read(): Promise<Uint8Array | null>;
	write(bytes: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export class ImapError extends Error {
	constructor(
		message: string,
		/** `auth` (bad credentials), `protocol`, `timeout`, `closed`, `no` (command refused). */
		readonly kind: "auth" | "protocol" | "timeout" | "closed" | "no",
	) {
		super(message);
		this.name = "ImapError";
	}
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Longest response line accepted (excluding literals). */
const MAX_LINE_BYTES = 1024 * 1024;

// ── Byte reader ─────────────────────────────────────────────────────

class ByteReader {
	#buf = new Uint8Array(0);
	#eof = false;

	constructor(
		private readonly transport: ImapTransport,
		private readonly timeoutMs: number,
	) {}

	async #fill(): Promise<boolean> {
		if (this.#eof) return false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const chunk = await Promise.race([
			this.transport.read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new ImapError("The IMAP server stopped responding.", "timeout")), this.timeoutMs);
			}),
		]).finally(() => clearTimeout(timer));
		if (!chunk) {
			this.#eof = true;
			return false;
		}
		const next = new Uint8Array(this.#buf.length + chunk.length);
		next.set(this.#buf);
		next.set(chunk, this.#buf.length);
		this.#buf = next;
		return true;
	}

	/** One line, CRLF (or bare LF) stripped. Throws at EOF. */
	async readLine(): Promise<Uint8Array> {
		for (;;) {
			const lf = this.#buf.indexOf(0x0a);
			if (lf !== -1) {
				const end = lf > 0 && this.#buf[lf - 1] === 0x0d ? lf - 1 : lf;
				const line = this.#buf.slice(0, end);
				this.#buf = this.#buf.slice(lf + 1);
				return line;
			}
			if (this.#buf.length > MAX_LINE_BYTES) throw new ImapError("IMAP response line too long.", "protocol");
			if (!(await this.#fill())) throw new ImapError("The IMAP server closed the connection.", "closed");
		}
	}

	async readBytes(n: number): Promise<Uint8Array> {
		while (this.#buf.length < n) {
			if (!(await this.#fill())) throw new ImapError("The IMAP server closed the connection.", "closed");
		}
		const out = this.#buf.slice(0, n);
		this.#buf = this.#buf.slice(n);
		return out;
	}
}

// ── Tokenizer ───────────────────────────────────────────────────────

/** A literal placeholder inside the text of a response. */
const LITERAL_MARK = "\u0000LIT";

/**
 * Tokenise a response's text, with `literals[i]` substituted for the i-th
 * literal marker. Exported for tests.
 */
export function tokenizeImap(text: string, literals: Uint8Array[] = []): ImapToken[] {
	const root: ImapToken[] = [];
	const stack: ImapToken[][] = [root];
	let literalIndex = 0;
	let i = 0;
	const top = () => stack[stack.length - 1];
	while (i < text.length) {
		const ch = text[i];
		if (ch === " ") {
			i++;
			continue;
		}
		if (text.startsWith(LITERAL_MARK, i)) {
			top().push(literals[literalIndex++] ?? new Uint8Array(0));
			i += LITERAL_MARK.length;
			continue;
		}
		if (ch === "(") {
			const list: ImapToken[] = [];
			top().push(list);
			stack.push(list);
			i++;
			continue;
		}
		if (ch === ")") {
			if (stack.length > 1) stack.pop();
			i++;
			continue;
		}
		if (ch === '"') {
			let out = "";
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) i++;
				out += text[i];
				i++;
			}
			i++; // closing quote
			top().push(out);
			continue;
		}
		// Atom. A `[...]` section (BODY[HEADER.FIELDS (A B)], response codes)
		// is part of the atom, spaces and parentheses included.
		let out = "";
		let depth = 0;
		while (i < text.length) {
			if (depth === 0 && text.startsWith(LITERAL_MARK, i)) break;
			const c = text[i];
			if (c === "[") depth++;
			else if (c === "]") depth = Math.max(0, depth - 1);
			else if (depth === 0 && (c === " " || c === "(" || c === ")")) break;
			out += c;
			i++;
		}
		top().push(out.toUpperCase() === "NIL" ? null : out);
	}
	return root;
}

const STATUS_WORDS = new Set(["OK", "NO", "BAD", "BYE", "PREAUTH"]);

/** Build a response from its text and literals. Exported for tests. */
export function parseImapResponse(text: string, literals: Uint8Array[] = []): ImapResponse {
	const space = text.indexOf(" ");
	const tag = space === -1 ? text : text.slice(0, space);
	const rest = space === -1 ? "" : text.slice(space + 1);
	if (tag === "+") return { tag, tokens: [], status: null, text: rest };
	const firstWord = rest.split(" ", 1)[0]?.toUpperCase() ?? "";
	if (STATUS_WORDS.has(firstWord)) {
		return { tag, tokens: [firstWord], status: firstWord, text: rest.slice(firstWord.length).trim() };
	}
	return { tag, tokens: tokenizeImap(rest, literals), status: null, text: rest.includes(LITERAL_MARK) ? "" : rest };
}

// ── Response helpers ────────────────────────────────────────────────

export function tokenString(t: ImapToken | undefined): string | null {
	if (t === null || t === undefined) return null;
	if (typeof t === "string") return t;
	if (t instanceof Uint8Array) return utf8.decode(t);
	return null;
}

/** `[CODE value]` from a status text, e.g. `UIDVALIDITY`. */
export function responseCode(text: string, code: string): string | null {
	const m = new RegExp(`\\[${code}(?: ([^\\]]*))?\\]`, "i").exec(text);
	return m ? (m[1] ?? "") : null;
}

export interface ImapListEntry {
	/** The mailbox name as the server spells it (modified UTF-7), for commands. */
	name: string;
	/** Human-readable name (UTF-7 decoded). */
	display: string;
	delimiter: string | null;
	attributes: string[];
}

export function parseListResponse(r: ImapResponse): ImapListEntry | null {
	const [kind, attrs, delim, name] = r.tokens;
	if (typeof kind !== "string" || kind.toUpperCase() !== "LIST") return null;
	const raw = tokenString(name);
	if (raw === null) return null;
	return {
		name: raw,
		display: decodeModifiedUtf7(raw),
		delimiter: tokenString(delim),
		attributes: Array.isArray(attrs) ? attrs.filter((a): a is string => typeof a === "string") : [],
	};
}

export interface ImapFetchItem {
	seq: number;
	uid: number | null;
	flags: string[];
	size: number | null;
	/** INTERNALDATE, the server's arrival time: the fallback for a missing Date header. */
	internalDate: string | null;
	body: Uint8Array | null;
}

export function parseFetchResponse(r: ImapResponse): ImapFetchItem | null {
	const [seq, kind, items] = r.tokens;
	if (typeof kind !== "string" || kind.toUpperCase() !== "FETCH" || !Array.isArray(items)) return null;
	const out: ImapFetchItem = { seq: Number(seq), uid: null, flags: [], size: null, internalDate: null, body: null };
	for (let i = 0; i + 1 < items.length; i += 2) {
		const key = typeof items[i] === "string" ? (items[i] as string).toUpperCase() : "";
		const value = items[i + 1];
		if (key === "UID") out.uid = Number(tokenString(value));
		else if (key === "FLAGS" && Array.isArray(value)) out.flags = value.filter((f): f is string => typeof f === "string");
		else if (key === "RFC822.SIZE") out.size = Number(tokenString(value));
		else if (key === "INTERNALDATE") out.internalDate = tokenString(value);
		else if (key === "BODY[]" || key === "RFC822") {
			out.body = value instanceof Uint8Array ? value : typeof value === "string" ? encoder.encode(value) : null;
		}
	}
	return out;
}

/** Decode IMAP modified UTF-7 (RFC 3501 §5.1.3). Invalid input is returned as-is. */
export function decodeModifiedUtf7(name: string): string {
	return name.replace(/&([^-]*)-/g, (match, b64: string) => {
		if (b64 === "") return "&";
		try {
			const bin = atob(b64.replace(/,/g, "/") + "===".slice((b64.length + 3) % 4));
			const units: number[] = [];
			for (let i = 0; i + 1 < bin.length; i += 2) units.push((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
			return String.fromCharCode(...units);
		} catch {
			return match;
		}
	});
}

/** Quote an astring for a command. Non-ASCII or CR/LF need a literal instead. */
export function quoteImapString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function needsLiteral(value: string): boolean {
	return /[\r\n\0]|[^\x00-\x7f]/.test(value);
}

/** Compress sorted UIDs into an IMAP sequence set: `1:3,7,9:10`. */
export function uidSet(uids: number[]): string {
	const sorted = [...new Set(uids)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const start = sorted[i];
		let end = start;
		while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i];
		parts.push(start === end ? String(start) : `${start}:${end}`);
	}
	return parts.join(",");
}

// ── Client ──────────────────────────────────────────────────────────

/** A command argument: a pre-formatted atom/quoted string, or a string that may need a literal. */
type Arg = { raw: string } | { astring: string };

export interface ImapClientOptions {
	/** Per-read timeout. */
	timeoutMs?: number;
	/** Largest literal accepted; larger aborts the session. */
	maxLiteralBytes?: number;
}

export interface ImapMailboxState {
	exists: number;
	uidValidity: number | null;
	uidNext: number | null;
}

export class ImapClient {
	readonly #reader: ByteReader;
	#tagSeq = 0;
	capabilities = new Set<string>();
	readonly #maxLiteral: number;

	constructor(
		private readonly transport: ImapTransport,
		options: ImapClientOptions = {},
	) {
		this.#reader = new ByteReader(transport, options.timeoutMs ?? 30_000);
		this.#maxLiteral = options.maxLiteralBytes ?? 30 * 1024 * 1024;
	}

	/** Read one full response, literals resolved. */
	async readResponse(): Promise<ImapResponse> {
		let text = "";
		const literals: Uint8Array[] = [];
		for (;;) {
			// UTF-8: atoms are ASCII either way, and quoted names may be UTF-8 (RFC 6855).
			const line = utf8.decode(await this.#reader.readLine());
			const m = /\{(\d+)\+?\}$/.exec(line);
			if (!m) {
				text += line;
				break;
			}
			const n = Number(m[1]);
			if (n > this.#maxLiteral) throw new ImapError(`IMAP literal of ${n} bytes exceeds the limit.`, "protocol");
			text += line.slice(0, m.index) + LITERAL_MARK;
			literals.push(await this.#reader.readBytes(n));
		}
		return parseImapResponse(text, literals);
	}

	async #write(s: string | Uint8Array): Promise<void> {
		await this.transport.write(typeof s === "string" ? encoder.encode(s) : s);
	}

	/**
	 * Send a command and collect untagged responses until its tagged completion.
	 * Throws on NO/BAD; `auth` kind when the command was a login.
	 */
	async command(name: string, args: Arg[] = [], opts: { auth?: boolean } = {}): Promise<{ untagged: ImapResponse[]; done: ImapResponse }> {
		const tag = `T${++this.#tagSeq}`;
		let line = `${tag} ${name}`;
		for (const arg of args) {
			if ("raw" in arg) {
				line += ` ${arg.raw}`;
				continue;
			}
			if (!needsLiteral(arg.astring)) {
				line += ` ${quoteImapString(arg.astring)}`;
				continue;
			}
			// Synchronising literal: wait for the server's go-ahead.
			const bytes = encoder.encode(arg.astring);
			await this.#write(`${line} {${bytes.length}}\r\n`);
			const cont = await this.readResponse();
			if (cont.tag !== "+") throw new ImapError(`IMAP server refused a literal: ${cont.text}`, opts.auth ? "auth" : "no");
			await this.#write(bytes);
			line = "";
		}
		await this.#write(`${line}\r\n`);
		return this.#collect(tag, opts);
	}

	async #collect(tag: string, opts: { auth?: boolean }): Promise<{ untagged: ImapResponse[]; done: ImapResponse }> {
		const untagged: ImapResponse[] = [];
		for (;;) {
			const r = await this.readResponse();
			if (r.tag === tag) {
				if (r.status === "OK") return { untagged, done: r };
				throw new ImapError(
					`${r.status ?? "Error"}: ${r.text || "the server refused the command"}`.slice(0, 300),
					opts.auth ? "auth" : "no",
				);
			}
			if (r.tag === "*" && r.status === "BYE") {
				throw new ImapError(`The IMAP server closed the session: ${r.text}`.slice(0, 300), "closed");
			}
			if (r.tag === "+") continue;
			untagged.push(r);
		}
	}

	/** Read the greeting and capabilities. */
	async greet(): Promise<void> {
		const greeting = await this.readResponse();
		if (greeting.tag !== "*" || (greeting.status !== "OK" && greeting.status !== "PREAUTH")) {
			throw new ImapError(`Unexpected IMAP greeting: ${greeting.text}`.slice(0, 200), "protocol");
		}
		const caps = responseCode(greeting.text, "CAPABILITY");
		if (caps !== null) this.#setCaps(caps);
		else await this.refreshCapabilities();
	}

	#setCaps(caps: string): void {
		this.capabilities = new Set(caps.toUpperCase().split(/\s+/).filter(Boolean));
	}

	async refreshCapabilities(): Promise<void> {
		const { untagged, done } = await this.command("CAPABILITY");
		for (const r of untagged) {
			if (typeof r.tokens[0] === "string" && r.tokens[0].toUpperCase() === "CAPABILITY") {
				this.#setCaps(r.tokens.slice(1).filter((t): t is string => typeof t === "string").join(" "));
			}
		}
		const code = responseCode(done.text, "CAPABILITY");
		if (code) this.#setCaps(code);
	}

	/**
	 * Authenticate. LOGIN with quoted strings when the server allows it and the
	 * credentials are plain ASCII; otherwise AUTHENTICATE PLAIN, which carries
	 * UTF-8 safely in base64.
	 */
	async login(username: string, password: string): Promise<void> {
		const plainAscii = !needsLiteral(username) && !needsLiteral(password);
		const canLogin = !this.capabilities.has("LOGINDISABLED");
		let done: ImapResponse;
		if (canLogin && plainAscii) {
			({ done } = await this.command("LOGIN", [{ astring: username }, { astring: password }], { auth: true }));
		} else {
			if (!this.capabilities.has("AUTH=PLAIN")) {
				throw new ImapError("The server does not offer a login method this importer supports.", "auth");
			}
			const token = base64Utf8(`\0${username}\0${password}`);
			const tag = `T${++this.#tagSeq}`;
			if (this.capabilities.has("SASL-IR")) {
				await this.#write(`${tag} AUTHENTICATE PLAIN ${token}\r\n`);
			} else {
				await this.#write(`${tag} AUTHENTICATE PLAIN\r\n`);
				const cont = await this.readResponse();
				if (cont.tag !== "+") throw new ImapError("The server refused AUTHENTICATE PLAIN.", "auth");
				await this.#write(`${token}\r\n`);
			}
			({ done } = await this.#collect(tag, { auth: true }));
		}
		const caps = responseCode(done.text, "CAPABILITY");
		if (caps) this.#setCaps(caps);
	}

	async list(): Promise<ImapListEntry[]> {
		const { untagged } = await this.command("LIST", [{ raw: '""' }, { raw: '"*"' }]);
		return untagged.map(parseListResponse).filter((e): e is ImapListEntry => e !== null);
	}

	/** Message count, for progress. */
	async status(mailbox: string): Promise<{ messages: number | null; uidNext: number | null; uidValidity: number | null }> {
		const { untagged } = await this.command("STATUS", [{ astring: mailbox }, { raw: "(MESSAGES UIDNEXT UIDVALIDITY)" }]);
		const out = { messages: null as number | null, uidNext: null as number | null, uidValidity: null as number | null };
		for (const r of untagged) {
			const [kind, , items] = r.tokens;
			if (typeof kind !== "string" || kind.toUpperCase() !== "STATUS" || !Array.isArray(items)) continue;
			for (let i = 0; i + 1 < items.length; i += 2) {
				const key = String(items[i]).toUpperCase();
				const value = Number(tokenString(items[i + 1]));
				if (key === "MESSAGES") out.messages = value;
				else if (key === "UIDNEXT") out.uidNext = value;
				else if (key === "UIDVALIDITY") out.uidValidity = value;
			}
		}
		return out;
	}

	/** EXAMINE: SELECT, read-only, so nothing on the source account changes. */
	async examine(mailbox: string): Promise<ImapMailboxState> {
		const { untagged, done } = await this.command("EXAMINE", [{ astring: mailbox }]);
		const state: ImapMailboxState = { exists: 0, uidValidity: null, uidNext: null };
		for (const r of [...untagged, done]) {
			if (r.status) {
				const v = responseCode(r.text, "UIDVALIDITY");
				if (v) state.uidValidity = Number(v);
				const n = responseCode(r.text, "UIDNEXT");
				if (n) state.uidNext = Number(n);
				continue;
			}
			if (typeof r.tokens[1] === "string" && r.tokens[1].toUpperCase() === "EXISTS") {
				state.exists = Number(r.tokens[0]);
			}
		}
		return state;
	}

	/** UIDs greater than `after`, ascending. */
	async uidsAfter(after: number): Promise<number[]> {
		const { untagged } = await this.command("UID SEARCH", [{ raw: `UID ${after + 1}:*` }]);
		const uids: number[] = [];
		for (const r of untagged) {
			if (typeof r.tokens[0] !== "string" || r.tokens[0].toUpperCase() !== "SEARCH") continue;
			for (const t of r.tokens.slice(1)) {
				const n = Number(tokenString(t));
				// `n:*` always includes the highest UID, even below n.
				if (Number.isInteger(n) && n > after) uids.push(n);
			}
		}
		return [...new Set(uids)].sort((a, b) => a - b);
	}

	/** Sizes and flags, no bodies. */
	async fetchMeta(uids: number[]): Promise<ImapFetchItem[]> {
		if (uids.length === 0) return [];
		const { untagged } = await this.command("UID FETCH", [{ raw: uidSet(uids) }, { raw: "(UID FLAGS RFC822.SIZE)" }]);
		return untagged.map(parseFetchResponse).filter((f): f is ImapFetchItem => f !== null && f.uid !== null);
	}

	/** Full messages, without setting \Seen. */
	async fetchBodies(uids: number[]): Promise<ImapFetchItem[]> {
		if (uids.length === 0) return [];
		const { untagged } = await this.command("UID FETCH", [{ raw: uidSet(uids) }, { raw: "(UID FLAGS INTERNALDATE BODY.PEEK[])" }]);
		return untagged.map(parseFetchResponse).filter((f): f is ImapFetchItem => f !== null && f.uid !== null);
	}

	/** Best effort: a failed LOGOUT changes nothing for the import. */
	async logout(): Promise<void> {
		try {
			await this.command("LOGOUT");
		} catch {
			// The server may just hang up after BYE.
		}
		await this.transport.close().catch(() => {});
	}
}

function base64Utf8(value: string): string {
	const bytes = encoder.encode(value);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}
