// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Keep the open message and `?m=` in step.
 *
 * Selection is still held in `useUIStore` (every list, shortcut and action
 * reads it there); this mirrors it into the URL and back. See
 * `decideSelectionSync` for which side wins.
 *
 * An entry we pushed is tagged in history state, so closing the reader goes
 * Back to it rather than adding a second list entry. That is what makes the
 * phone's Back gesture close the reader and leave the list where it was
 * (scrolled, paged): the list never unmounts while a message is open.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import {
	decideSelectionSync,
	filtersFromParams,
	withFilters,
	readSelectedId,
	type SelectionSnapshot,
	withSelectedId,
} from "~/lib/mail-url";
import type { MailListFilters } from "~/lib/mail-filters";

const PUSHED = "mailReaderPushed";

export function useMailUrlSync() {
	const location = useLocation();
	const navigate = useNavigate();
	const selectedEmailId = useUIStore((s) => s.selectedEmailId);
	const selectEmail = useUIStore((s) => s.selectEmail);
	const closePanel = useUIStore((s) => s.closePanel);
	const isComposing = useUIStore((s) => s.isComposing);

	const params = new URLSearchParams(location.search);
	const urlId = readSelectedId(params);
	const snapshot: SelectionSnapshot = {
		urlKey: `${location.pathname}?${urlId ?? ""}`,
		urlId,
		storeId: selectedEmailId,
	};
	const previousRef = useRef<SelectionSnapshot | null>(null);

	useEffect(() => {
		// A new compose clears the selection and `closeCompose` restores it, so
		// the URL keeps the message meanwhile. The snapshot is not recorded
		// either: when compose ends with nothing selected (sent, discarded) the
		// comparison is against the message that was open, and `?m=` is dropped.
		if (isComposing && snapshot.storeId === null && snapshot.urlKey === previousRef.current?.urlKey) {
			return;
		}
		const previous = previousRef.current;
		previousRef.current = snapshot;
		const pushed = !!(location.state as Record<string, unknown> | null)?.[PUSHED];
		const action = decideSelectionSync(previous, snapshot, pushed);

		if (action.kind === "store") {
			if (action.id) selectEmail(action.id);
			// Only close a reader that is open; a compose in progress (which
			// clears the selection) is not the URL's to cancel.
			else if (snapshot.storeId) closePanel();
			return;
		}
		if (action.kind !== "url") return;

		if (action.mode === "back") {
			navigate(-1);
			return;
		}
		const next = withSelectedId(new URLSearchParams(location.search), action.id);
		const search = next.toString();
		navigate(
			{ pathname: location.pathname, search: search ? `?${search}` : "" },
			action.mode === "push"
				? { state: { [PUSHED]: true } }
				: { replace: true, state: location.state },
		);
		// The snapshot fields are the dependencies; the object is rebuilt per render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [snapshot.urlKey, snapshot.storeId, isComposing]);
}

/**
 * List filters and sort, read from and written to the query string.
 *
 * A filter change replaces the history entry (filters are not worth a Back
 * step each) and drops `?m=`, since the list is about to change under it.
 */
export function useUrlFilters(): [
	MailListFilters,
	(next: MailListFilters) => void,
] {
	const [searchParams, setSearchParams] = useSearchParams();
	const key = searchParams.toString();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const filters = useMemo(() => filtersFromParams(searchParams), [key]);
	const setFilters = useCallback(
		(next: MailListFilters) => {
			setSearchParams(
				(current) => withSelectedId(withFilters(current, next), null),
				{ replace: true },
			);
		},
		[setSearchParams],
	);
	return [filters, setFilters];
}
