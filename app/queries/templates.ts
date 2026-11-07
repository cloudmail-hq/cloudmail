/**
 * Shared email templates.
 *
 * Templates live in R2 rather than a mailbox Durable Object, so they are not
 * scoped by mailbox and every composer sees the same set.
 */

import { useQuery } from "@tanstack/react-query";
import api, { type EmailTemplate } from "~/services/api";

const TEMPLATE_KEY = ["templates"] as const;

export function useTemplates() {
	return useQuery<EmailTemplate[]>({
		queryKey: TEMPLATE_KEY,
		queryFn: ({ signal }) => api.listTemplates({ signal }),
		staleTime: 60_000,
	});
}

/*
 * The template editor and list screens call `api` directly with local state
 * rather than going through hooks here, so single-template and delete hooks were
 * only ever dead exports. If those screens move onto TanStack Query, add them
 * back then — and share TEMPLATE_KEY so invalidation reaches this list.
 */
