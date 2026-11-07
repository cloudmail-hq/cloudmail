// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type Branding, type BrandingInput } from "~/services/api";
import { queryKeys } from "./keys";

/** Kept in step with `defaultBranding()` in `workers/lib/branding.ts`. */
export const DEFAULT_BRANDING: Branding = {
	appName: "cloudmail",
	tagline: null,
	accentColor: "#4F46E5",
	logoMimeType: null,
	logoFilename: null,
	logoUpdatedAt: null,
	updatedAt: 0,
};

export const APP_NAME_MAX_LENGTH = 40;
export const TAGLINE_MAX_LENGTH = 120;
/** Mirrors `MAX_LOGO_BYTES` on the Worker, which is the authority. */
export const MAX_LOGO_BYTES = 512 * 1024;
export const ALLOWED_LOGO_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
];

/**
 * The current branding record.
 *
 * `staleTime: Infinity` because this is rendered by the chrome on every page and
 * only ever changes from within this app — the mutations below invalidate it, so
 * there is nothing for polling to discover. Placeholder data is the defaults, so
 * the wordmark renders a sensible name on first paint instead of flashing empty.
 */
export function useBranding() {
	return useQuery<Branding>({
		queryKey: queryKeys.branding,
		queryFn: ({ signal }) => api.getBranding({ signal }),
		staleTime: Infinity,
		placeholderData: DEFAULT_BRANDING,
	});
}

/**
 * URL for the uploaded logo, or null when none is set.
 *
 * The `v` stamp is what lets the server mark the response immutable: the blob
 * lives at a fixed key that is overwritten in place, so the URL has to change for
 * a replaced logo to be picked up.
 */
export function brandingLogoUrl(branding: Branding | undefined): string | null {
	if (!branding?.logoMimeType) return null;
	const version = branding.logoUpdatedAt ?? branding.updatedAt;
	return `/api/v1/branding/logo?v=${version}`;
}

function useBrandingMutation<TVariables>(
	mutationFn: (variables: TVariables) => Promise<Branding>,
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn,
		// Write the response straight into the cache so the wordmark updates
		// immediately, then invalidate so the stored record is the final word.
		onSuccess: (branding) => {
			qc.setQueryData(queryKeys.branding, branding);
			qc.invalidateQueries({ queryKey: queryKeys.branding });
		},
	});
}

export function useUpdateBranding() {
	return useBrandingMutation((patch: BrandingInput) =>
		api.updateBranding(patch),
	);
}

export function useResetBranding() {
	// `void` rather than an inferred type parameter, so callers can invoke
	// `mutateAsync()` with no argument.
	return useBrandingMutation<void>(() => api.resetBranding());
}

export function useUploadBrandingLogo() {
	return useBrandingMutation(
		(logo: { content: string; filename: string; type: string }) =>
			api.uploadBrandingLogo(logo),
	);
}

export function useDeleteBrandingLogo() {
	return useBrandingMutation<void>(() => api.deleteBrandingLogo());
}

/** Client-side pre-check so an oversized file never gets base64-encoded. */
export function validateLogoFile(file: File): { valid: boolean; error?: string } {
	const type = file.type.split(";")[0]!.trim().toLowerCase();
	if (!ALLOWED_LOGO_MIME_TYPES.includes(type)) {
		return {
			valid: false,
			error: "Use a PNG, JPEG, WebP or GIF image. SVG isn't accepted.",
		};
	}
	if (file.size === 0) {
		return { valid: false, error: "That file is empty." };
	}
	if (file.size > MAX_LOGO_BYTES) {
		const kb = Math.round(MAX_LOGO_BYTES / 1024);
		return { valid: false, error: `Logo must be ${kb} KB or smaller.` };
	}
	return { valid: true };
}
