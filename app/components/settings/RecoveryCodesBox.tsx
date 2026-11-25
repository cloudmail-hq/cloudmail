/**
 * A fresh set of recovery codes, shown once: copy, download or print them.
 *
 * Used when two-factor first turns on (an authenticator app or a first
 * passkey) and when the user makes a new set. Printing writes the codes into
 * a new blank window and prints that, so nothing else on the page is printed
 * and the codes never go to a server.
 */

import { Download, Printer } from "lucide-react";
import { CopyButton, PRIMARY_BUTTON_CLASS, SECONDARY_BUTTON_CLASS } from "./settings-ui";

function fileText(codes: string[]): string {
	return `cloudmail recovery codes\nGenerated ${new Date().toLocaleString()}\nEach code can be used once.\n\n${codes.join("\n")}\n`;
}

function download(codes: string[]) {
	const blob = new Blob([fileText(codes)], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "cloudmail-recovery-codes.txt";
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function print(codes: string[]) {
	const w = window.open("", "_blank", "width=480,height=640");
	if (!w) return;
	const doc = w.document;
	doc.title = "Recovery codes";
	const style = doc.createElement("style");
	style.textContent =
		"body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:32px;color:#111}" +
		"h1{font-size:18px;margin:0 0 8px}p{font-size:13px;color:#444;margin:0 0 16px}" +
		"ol{font-family:ui-monospace,Menlo,monospace;font-size:15px;line-height:2;columns:2}";
	doc.head.appendChild(style);
	const h = doc.createElement("h1");
	h.textContent = "cloudmail recovery codes";
	const p = doc.createElement("p");
	p.textContent = `Generated ${new Date().toLocaleString()}. Each code signs in once. Keep this page somewhere safe.`;
	const list = doc.createElement("ol");
	for (const code of codes) {
		const li = doc.createElement("li");
		li.textContent = code;
		list.appendChild(li);
	}
	doc.body.appendChild(h);
	doc.body.appendChild(p);
	doc.body.appendChild(list);
	w.focus();
	w.print();
}

export default function RecoveryCodesBox({
	codes,
	onDone,
	intro,
}: {
	codes: string[];
	onDone: () => void;
	/** Why these codes appeared; defaults to the authenticator wording. */
	intro?: string;
}) {
	const text = codes.join("\n");
	return (
		<div className="space-y-3" role="status">
			<div>
				<h4 className="text-sm font-medium text-text-primary">Save your recovery codes</h4>
				<p className="mt-1 text-sm text-text-secondary">
					{intro ??
						"If you lose your passkeys or your authenticator, each of these codes signs you in once."}{" "}
					They won't be shown again, so store them somewhere safe, like a password manager.
				</p>
			</div>
			<ul
				aria-label="Recovery codes"
				className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-[6px] bg-bg-subtle p-3 font-mono text-xs text-text-primary ring-1 ring-border sm:grid-cols-2"
			>
				{codes.map((code) => (
					<li key={code}>{code}</li>
				))}
			</ul>
			<div className="flex flex-wrap items-center gap-2">
				<CopyButton text={text} label="Copy codes" what="Recovery codes copied" />
				<button type="button" onClick={() => download(codes)} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
					<Download size={13} aria-hidden />
					Download
				</button>
				<button type="button" onClick={() => print(codes)} className={`${SECONDARY_BUTTON_CLASS} h-8`}>
					<Printer size={13} aria-hidden />
					Print
				</button>
				<button type="button" onClick={onDone} className={`${PRIMARY_BUTTON_CLASS} ml-auto h-8`}>
					I've saved them
				</button>
			</div>
		</div>
	);
}
