/**
 * The document a message body is rendered into.
 *
 * This is the `srcdoc` of the sandboxed frame in `EmailIframe`, moved out of the
 * effect that assigns it for the same reason the typography rules moved into
 * `~/lib/reading-typography`: as a template literal inside a `useEffect` the
 * only way to check any of it was to open a browser and look. The frame's
 * behaviour — the fit, the height reporting, the CSP, where links open — is now a
 * pure function of the sanitised body and four options, so it can be asserted
 * against and driven from a harness.
 *
 * Sanitising deliberately stays in the component. DOMPurify needs a DOM, this
 * module is imported by the server build, and a builder that could not run under
 * SSR would be a builder nothing could test.
 *
 * ## Security model (unchanged by the move)
 *
 * - The caller sanitises with DOMPurify before this ever sees the markup.
 * - The frame's sandbox withholds `allow-same-origin`, so even a DOMPurify
 *   bypass runs in an opaque origin with no reach into the app's cookies, DOM or
 *   API. That is also why the height has to come back over `postMessage`:
 *   `contentDocument` is not readable from the parent.
 * - A strict CSP meta tag blocks external loads inside the frame as
 *   defence-in-depth behind the `img src` rewriting the caller has already done.
 */

import {
	BODY_FONT_SIZE_PX,
	BODY_LINE_HEIGHT,
	declaresOwnColors,
	paintsOwnSurface,
	readingMeasureCh,
} from "~/lib/reading-typography";

/**
 * How far the frame will shrink a message to make it fit.
 *
 * Below roughly two-thirds, 15px body copy stops being text you can read, so
 * shrinking further only trades one unusable rendering for another. Past the
 * floor the leftover width becomes a horizontal scrollbar instead.
 */
export const MIN_FIT_SCALE = 0.65;

export interface EmailDocumentOptions {
	/** Message HTML, already sanitised by the caller. */
	cleanBody: string;
	/** Frame sizes itself to the content rather than filling its parent. */
	autoSize?: boolean;
	/** Whether the CSP admits remote hosts for images. */
	allowRemoteImages?: boolean;
	/** Override for the body gutter. */
	padding?: string;
	/**
	 * The host app's resolved theme. Only honoured when the sender left the
	 * palette alone — see `declaresOwnColors`.
	 */
	theme: "light" | "dark";
}

const LIGHT = {
	canvas: "#ffffff",
	ink: "#1a1a1a",
	link: "#2563eb",
	quoteBorder: "#d1d5db",
	quoteInk: "#6b7280",
	codeBg: "#f3f4f6",
	rule: "#e5e7eb",
	scheme: "light",
};

const DARK = {
	canvas: "#16181d",
	ink: "#e8eaed",
	link: "#93b8ff",
	quoteBorder: "#3a3f4a",
	quoteInk: "#9aa3af",
	codeBg: "#22252c",
	rule: "#2f333c",
	scheme: "dark",
};

/**
 * Fit-and-measure script: sizes the content to the column, then posts the
 * resulting height to the parent.
 *
 * Runs inside the opaque-origin sandbox, so it has no access to the parent page
 * — it can only postMessage.
 *
 * ## Why fitting has to happen at all
 *
 * A message that `bringsOwnLayout` is sized in fixed pixels — 600px is the
 * twenty-year convention in bulk mail — and the reading pane is not. On a 1280px
 * window with the folder rail and the message list beside it the pane is around
 * 470px, and the frame used to carry `overflow: hidden` on the body so that an
 * auto-sized frame could never show a scrollbar of its own. The two together
 * meant the right-hand third of the newsletter was laid out, painted and then
 * thrown away: no scrollbar, no reflow, no way to reach it. `table { max-width:
 * 100% }` does not save it, because a table whose cells carry their own widths
 * has a min-content width larger than the cap.
 *
 * The fix is the one every mail client on a narrow screen uses: scale the whole
 * layout down to the width available. It is applied to a wrapper, so the
 * sender's own proportions survive intact, and it only engages when the content
 * really is too wide — a plain reply reflows and is left alone.
 *
 * ## Why the height is measured on a wrapper
 *
 * `srcdoc` is assigned imperatively, and reassigned whenever the caller's inputs
 * change — the resolved theme settles after first paint, so that is the common
 * case, not an edge one. A document replaced that way can report
 * `body.scrollHeight === 0` while still painting its content perfectly well: the
 * body ends up with no layout box of its own. Measuring a wrapper sidesteps it,
 * because a normal block's height is its content's height whatever the body is
 * doing. Falling back to `documentElement.scrollHeight` is not an option either
 * — that is the viewport height here, which would pin the frame to whatever it
 * already is.
 *
 * ## Why a ResizeObserver and not just timeouts
 *
 * Four fixed timeouts is a guess about when a message stops growing. Images
 * decode when they decode; a web font arriving reflows everything. The observer
 * answers the actual question, and the timeouts stay as a floor for where it is
 * unavailable. `resize` is listened to as well: the frame's window resizes with
 * the pane, and the scale is a function of the pane's width, so a pane that gets
 * narrower has to re-fit.
 *
 * Both the style writes and the height reports are deduplicated on the values
 * that produced them, so a settled message stops doing either. That is also what
 * stops the observer feeding itself: re-fitting writes the wrapper's width, which
 * would otherwise retrigger it forever.
 */
function fitScript(): string {
	return `<script>
(function () {
	var MIN_SCALE = ${MIN_FIT_SCALE};
	var scroller = document.getElementById("tt-mail-scroll");
	var fit = document.getElementById("tt-mail-fit");
	var content = document.getElementById("tt-mail-body");
	var lastKey = "";
	var lastHeight = 0;
	var scheduled = false;
	/*
	  \`zoom\` rather than \`transform: scale()\`, because zoom participates in layout
	  and a transform does not.

	  With a transform the wrapper keeps its full untransformed width and height as
	  far as its parent is concerned: \`scrollWidth\` still reported 600px for a
	  newsletter painted at 438px, so the scroller grew a horizontal scrollbar for
	  overflow that was no longer visible, and the height had to be multiplied out
	  by hand and written back — arithmetic that then had to be redone every time
	  an image decoded. Zoom makes both automatic: the box really is smaller, so
	  the scroller's own auto height is already correct and a scrollbar appears
	  only when something genuinely does not fit.

	  Where zoom is unsupported nothing is scaled and the overflow falls through to
	  the scrollbar on #tt-mail-scroll. That is a worse read than fitting, and
	  still far better than the silent crop this replaced.
	*/
	var SUPPORTS_ZOOM =
		typeof CSS !== "undefined" && !!CSS.supports && CSS.supports("zoom", "0.5");

	function report() {
		if (!content) return;
		/*
		  Measured on the content wrapper, and scaled by whatever zoom is in effect.

		  Deliberately the same three metrics, on the same element, that this has
		  always used: they disagree with each other, and which one is unreliable
		  varies with how the document was created, so the maximum is what makes a
		  measurement survive a \`srcdoc\` that has just been reassigned. Attempts to
		  measure the scroller instead — the more obvious choice, since zoom has
		  already been applied inside it — read zero noticeably more often.

		  \`getBoundingClientRect\` is a painted rect and so already includes zoom,
		  while \`scrollHeight\` and \`offsetHeight\` are in the element's own
		  coordinate space and do not; scaling those two is what keeps the three
		  comparable. With no zoom applied \`z\` is 1 and this is exactly the
		  calculation it replaced.
		*/
		var z = parseFloat(fit && fit.style.zoom ? fit.style.zoom : "") || 1;
		var rect = content.getBoundingClientRect().height;
		var h = Math.ceil(
			Math.max(rect, content.scrollHeight * z, content.offsetHeight * z),
		);
		/*
		  Plus the horizontal scrollbar, where there is one.

		  A message too wide to fit even at MIN_FIT_SCALE — or any message at all
		  where \`zoom\` is unsupported — leaves #tt-mail-scroll with a scrollbar, and
		  on a platform that draws classic rather than overlay scrollbars that
		  scrollbar occupies real vertical space below the content. It is not part of
		  anything measured above, because the measurement is of the content wrapper
		  *inside* the scroller. Left out, the frame is reported a scrollbar's worth
		  too short and \`body { overflow: hidden }\` crops the very control the
		  reader needs to see the rest of the message.

		  \`offsetHeight - clientHeight\` is exactly that thickness: the scroller
		  carries no border, so the only thing between its border box and its client
		  box is the scrollbar. It is 0 with overlay scrollbars and 0 when there is
		  nothing to scroll, so this changes nothing in the common case — including
		  the unlaid-out state, where both metrics are 0.
		*/
		if (scroller) {
			h += Math.max(0, scroller.offsetHeight - scroller.clientHeight);
		}
		// Padding is on the body, so the wrapper alone is short by it.
		var cs = document.body ? getComputedStyle(document.body) : null;
		if (cs) h += parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0);
		if (h > 0 && h !== lastHeight) {
			lastHeight = h;
			parent.postMessage({ __emailIframeHeight: true, height: h }, "*");
		}
	}

	function layout() {
		if (!scroller || !fit || !content) return;
		var avail = scroller.clientWidth;
		// The width the sender's layout actually needs. \`scrollWidth\` is what
		// reports it while the content is still overflowing; \`offsetWidth\` is what
		// reports it once a zoom has given it the room, and taking the max of the
		// two is what makes the measurement stable across both states instead of
		// oscillating between them.
		var natural = Math.ceil(Math.max(content.scrollWidth, content.offsetWidth));
		var scale = 1;
		if (SUPPORTS_ZOOM && avail > 0 && natural > avail + 1) {
			scale = Math.max(MIN_SCALE, avail / natural);
		}
		var key = avail + "|" + natural + "|" + scale.toFixed(4);
		if (key !== lastKey) {
			lastKey = key;
			// Width is deliberately left alone. Under zoom the wrapper's available
			// width in its own coordinate space becomes avail/scale, which is the
			// natural width by construction — so the sender's layout gets exactly
			// the room it asked for without being pinned to a measured number.
			fit.style.zoom = scale < 1 ? String(scale) : "";
		}
		report();
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		var run = function () { scheduled = false; layout(); };
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
		else setTimeout(run, 16);
	}

	layout();
	setTimeout(layout, 50);
	setTimeout(layout, 150);
	setTimeout(layout, 400);
	window.addEventListener("load", layout);
	window.addEventListener("resize", schedule);

	if (typeof ResizeObserver === "function") {
		// The content wrapper is never written to by layout(), so observing it
		// reports the sender's own reflows rather than our own writes.
		new ResizeObserver(schedule).observe(content);
	}
})();
<\/script>`;
}

/**
 * Keep in-document jump links inside the frame.
 *
 * `<base target="_blank">` applies to every link activation, including a bare
 * `href="#section"` from a newsletter's table of contents — which would open a
 * new tab on `about:srcdoc` showing nothing. These links are the one case that
 * should not leave the message.
 *
 * Scrolling only lands when the frame has its own scrollbar. In `autoSize` mode
 * it is as tall as its content, so the anchor is already on screen and
 * cancelling the navigation is the whole fix.
 */
function anchorScript(): string {
	return `<script>
document.addEventListener("click", function (event) {
	var link = event.target && event.target.closest && event.target.closest("a");
	if (!link) return;
	var href = link.getAttribute("href") || "";
	if (href.charAt(0) !== "#") return;
	event.preventDefault();
	var id = href.slice(1);
	if (!id) { window.scrollTo(0, 0); return; }
	var el = document.getElementById(id) || document.getElementsByName(id)[0];
	if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
});
<\/script>`;
}

/**
 * Build the frame document for one message body.
 *
 * Navigation model: every link opens in a new browser tab. `<base
 * target="_blank">` sets the default, the caller strips `target` from the
 * sender's markup so the base tag is authoritative, and the sandbox withholds
 * top-level navigation so a link cannot replace the app even if both of those
 * fail.
 */
export function buildEmailDocument({
	cleanBody,
	autoSize = false,
	allowRemoteImages = false,
	padding,
	theme,
}: EmailDocumentOptions): string {
	/*
	  A gutter for messages that need one, and none for messages that do not.

	  Trimmed from `18px 20px` first, because this gutter is never the only one:
	  the card around the frame contributes its own, so 20px here read as 36px of
	  blank column on each side of the message.

	  Dropped altogether for a message that lays itself out. A newsletter arrives
	  with its own canvas — a background, an outer table, its own padding inside
	  that — so ours only inset someone else's design inside someone else's design,
	  and it is charged twice over because the card outside is doing the same
	  thing. On a 430px pane the two together came to 66px, a sixth of the width,
	  spent on nothing and paid for in how far the message then had to be scaled
	  down to fit. A plain reply keeps the gutter: it is bare text, and without one
	  it would sit against the border.
	*/
	const bodyPadding =
		padding ??
		(autoSize ? (paintsOwnSurface(cleanBody) ? "0" : "14px 16px") : "24px");

	// Dark only when the sender left the palette to us — see `declaresOwnColors`.
	const palette = theme === "dark" && !declaresOwnColors(cleanBody) ? DARK : LIGHT;

	/*
	  Cap the line length, but only on messages that did not lay themselves out.

	  Text was running the full width of the pane, which on a wide monitor is 200+
	  characters per line — long enough that the eye loses the start of the next
	  one. `readingMeasureCh` returns null for a fixed-width newsletter, where a
	  cap would fight the sender's own table widths.

	  `ch` rather than `px` so the measure tracks the font size and survives a
	  browser zoom. Left-aligned rather than centred: a centred column moves under
	  the reader as they page through messages of differing widths.
	*/
	const measure = readingMeasureCh(cleanBody);
	const measureCss = measure === null ? "" : `max-width: ${measure}ch;`;

	/*
	  A text/plain-only message is stored as its text and dropped into this HTML
	  document as is, so its line breaks collapsed: greeting, body and signature
	  ran together as one paragraph. Without a single tag it cannot be markup, so
	  its whitespace is the formatting and is kept.
	*/
	const plainCss = /<[a-z!/][^>]*>/i.test(cleanBody) ? "" : "white-space: pre-wrap;";

	// Same-origin in both modes. Inline attachments come from our own origin, and
	// allowed remote images are rewritten to the same-origin `/img/` proxy by
	// `prepareEmailHtml`, so no remote host is ever needed. `allowRemoteImages`
	// therefore changes which URLs the body contains, not what this permits.
	//
	// A srcdoc frame has an opaque origin, so `'self'` here would match nothing;
	// the parent origin is spelled out, which is also what the inherited outer
	// policy's `'self'` resolves to.
	void allowRemoteImages;
	const self = typeof location !== "undefined" && /^https?:$/.test(location.protocol) ? ` ${location.origin}` : "";
	const imgSrc = `data: blob: 'self'${self}`;

	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<!--
	Keep the mailbox URL off the wire. Without this, following a link in a
	newsletter hands the sender a referrer, which is the same open-tracking signal
	that remote images are blocked for.
-->
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc}; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; }
html {
	background: ${palette.canvas};
	color-scheme: ${palette.scheme};
}
body {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	font-size: ${BODY_FONT_SIZE_PX}px;
	line-height: ${BODY_LINE_HEIGHT};
	color: ${palette.ink};
	background: ${palette.canvas};
	padding: ${bodyPadding};
	margin: 0;
	word-wrap: break-word;
	overflow-wrap: break-word;
	/*
	  In autoSize mode the frame is as tall as its content, so a scrollbar on the
	  body would be a scrollbar on nothing. Overflow belongs to #tt-mail-scroll
	  instead — which is the difference between a too-wide newsletter being
	  reachable and being cropped in silence.
	*/
	${autoSize ? "overflow: hidden;" : ""}
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: ${palette.link}; }
img { max-width: 100%; height: auto; }
/*
  A blocked image is a 1x1 transparent GIF standing in for the real one, and
  \`height: auto\` scales that square to the declared width: a 600px-wide
  banner became 600px of blank page above the text. Without a declared height
  there is no layout to preserve, so it takes none.
*/
img[data-blocked-src]:not([height]) { height: 0 !important; }
blockquote {
	border-left: 3px solid ${palette.quoteBorder};
	padding-left: 1em;
	margin-left: 0;
	color: ${palette.quoteInk};
}
pre {
	background: ${palette.codeBg};
	padding: 12px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 13px;
}
/*
  Overflow of last resort: reached only by a message too wide to fit even at
  MIN_FIT_SCALE, and by anything at all where \`zoom\` is unsupported.

  Height stays automatic — zoom shrinks the real layout box, so the scroller
  already measures the painted size and there is nothing to compute. \`overflow-y\`
  is hidden so this can never become a second vertical scrollbar inside a frame
  that is already exactly as tall as its content.
*/
#tt-mail-scroll {
	overflow-x: auto;
	overflow-y: hidden;
	scrollbar-width: thin;
}
/*
  The element the height script measures. A flow root, so a child's top or bottom
  margin is contained rather than collapsing through it — otherwise the measured
  height is short by that margin and the last line of the message is cut off.
*/
#tt-mail-body { display: flow-root; ${measureCss} ${plainCss} }
table { border-collapse: collapse; max-width: 100%; }
td, th { padding: 4px 8px; }
p { margin: 0 0 12px; }
p:last-child { margin-bottom: 0; }
h1, h2, h3, h4 { margin: 20px 0 8px; line-height: 1.3; }
h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
h1 { font-size: 20px; }
h2 { font-size: 17px; }
h3 { font-size: 15px; }
ul, ol { padding-left: 22px; margin: 0 0 12px; }
li { margin: 2px 0; }
hr { border: none; border-top: 1px solid ${palette.rule}; margin: 20px 0; }
</style>
</head>
<body><div id="tt-mail-scroll"><div id="tt-mail-fit"><div id="tt-mail-body">${cleanBody}</div></div></div>${anchorScript()}${autoSize ? fitScript() : ""}</body>
</html>`;
}
