// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The preview for a held sequence enrollment: the sequence's name and each
 * step's subject and body, rendered for this person the way the dispatcher
 * will render them. See `workers/lib/agent-send-gate.ts`.
 */

import type { HeldEnrollment } from "./held-send";
import { productTemplateVariables } from "./products";
import * as sequences from "./sequences";
import * as templates from "./templates";
import type { Env } from "../types";

export interface EnrollRequest {
	sequenceId: string;
	personId: string;
	personEmail: string;
	personName: string | null;
	fromAddress: string;
	variables?: Record<string, string>;
	skipSteps?: number[];
	delayOverrides?: Record<string, number>;
}

/** Null when the sequence does not exist. */
export async function previewEnrollment(env: Env, req: EnrollRequest): Promise<HeldEnrollment | null> {
	const sequence = await sequences.getSequence(env.BUCKET, req.sequenceId);
	if (!sequence) return null;
	const variables: Record<string, string> = {
		...(await productTemplateVariables(env, req.fromAddress)),
		name: req.personName || req.personEmail.split("@")[0] || "",
		email: req.personEmail,
		...req.variables,
	};
	delete variables.unsubscribe_url;
	const steps: HeldEnrollment["steps"] = [];
	for (const step of sequence.steps) {
		if (req.skipSteps?.includes(step.order)) continue;
		const template = await templates.getTemplate(env.BUCKET, step.templateSlug);
		const rendered = template
			? templates.renderTemplate(template, variables)
			: { subject: `(missing template ${step.templateSlug})`, bodyHtml: "" };
		steps.push({
			order: step.order,
			delayHours: req.delayOverrides?.[String(step.order)] ?? step.delayHours,
			subject: rendered.subject,
			bodyHtml: rendered.bodyHtml,
		});
	}
	return {
		sequenceId: sequence.id,
		sequenceName: sequence.name,
		steps,
		enroll: {
			personId: req.personId,
			personEmail: req.personEmail,
			personName: req.personName,
			fromAddress: req.fromAddress,
			...(req.variables ? { variables: req.variables } : {}),
			...(req.skipSteps ? { skipSteps: req.skipSteps } : {}),
			...(req.delayOverrides ? { delayOverrides: req.delayOverrides } : {}),
		},
	};
}
