// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Keeps the composer's signature wrapper intact inside the editor.
 *
 * StarterKit has no node for `<div>`, so `<div class="email-signature">` was
 * flattened into bare paragraphs on load: the signature lost its rule and
 * colour, and nothing could find it again. Swapping a product's signature
 * when From changes (`swapProductSignature`) needs the block to survive, so
 * it is a node of its own here, round-tripping `class`, `style` and the
 * `data-product` tag.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { PRODUCT_SIGNATURE_ATTR } from "shared/products";

export const SignatureBlock = Node.create({
	name: "signatureBlock",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			product: {
				default: null,
				parseHTML: (el) => el.getAttribute(PRODUCT_SIGNATURE_ATTR),
				renderHTML: (attrs) => (attrs.product ? { [PRODUCT_SIGNATURE_ATTR]: attrs.product } : {}),
			},
			style: {
				default: null,
				parseHTML: (el) => el.getAttribute("style"),
				renderHTML: (attrs) => (attrs.style ? { style: attrs.style } : {}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "div.email-signature" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes({ class: "email-signature" }, HTMLAttributes), 0];
	},
});
