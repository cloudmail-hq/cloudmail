// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Outbound webhook endpoints and their delivery log. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { webhooksApi, type WebhookInput } from "~/services/webhooks-api";

const keys = {
	all: ["webhooks"] as const,
	deliveries: (webhookId: string) => ["webhooks", webhookId, "deliveries"] as const,
};

export function useWebhooks(options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: keys.all,
		queryFn: webhooksApi.list,
		enabled: options?.enabled ?? true,
		retry: false,
	});
}

export function useWebhookDeliveries(webhookId: string | null) {
	return useQuery({
		queryKey: webhookId ? keys.deliveries(webhookId) : ["webhooks", "_none"],
		queryFn: () => webhooksApi.deliveries(webhookId!),
		enabled: !!webhookId,
		// Retries land in the background; keep the open log roughly current.
		refetchInterval: 15_000,
	});
}

function useInvalidate() {
	const qc = useQueryClient();
	return (webhookId?: string) => {
		qc.invalidateQueries({ queryKey: keys.all, exact: true });
		if (webhookId) qc.invalidateQueries({ queryKey: keys.deliveries(webhookId) });
	};
}

export function useCreateWebhook() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (input: WebhookInput) => webhooksApi.create(input),
		onSuccess: () => invalidate(),
	});
}

export function useUpdateWebhook() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ id, patch }: { id: string; patch: Partial<WebhookInput> }) => webhooksApi.update(id, patch),
		onSuccess: (_d, { id }) => invalidate(id),
	});
}

export function useDeleteWebhook() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (id: string) => webhooksApi.remove(id),
		onSuccess: () => invalidate(),
	});
}

export function useRotateWebhookSecret() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (id: string) => webhooksApi.rotateSecret(id),
		onSuccess: (_d, id) => invalidate(id),
	});
}

export function useTestWebhook() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: (id: string) => webhooksApi.test(id),
		onSuccess: (_d, id) => invalidate(id),
	});
}

export function useRetryWebhookDelivery() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: ({ deliveryId }: { deliveryId: string; webhookId: string }) => webhooksApi.retry(deliveryId),
		onSuccess: (_d, { webhookId }) => invalidate(webhookId),
	});
}
