import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import MailSearchBar from "~/components/mail/MailSearchBar";
import { useCommandPaletteStore } from "~/hooks/useCommandPaletteStore";
import { isSearchPath, mailboxFromPath, searchHref, searchScope, type SearchScope } from "~/lib/app-nav";
import { useFolders } from "~/queries/folders";

/**
 * The search field in the top bar, on every page.
 *
 * Inside a mailbox it searches that mailbox; anywhere else it searches every
 * inbox the user can read (`/mail/all/search`). The field, its Advanced
 * search panel and the ⌘K hint are the same control everywhere, so the bar
 * never changes shape between pages; only the placeholder says which scope
 * applies.
 *
 * Inside a mailbox the scope chip is a selector: "This mailbox" by default,
 * or "All inboxes" for one search across every inbox. The choice resets to
 * the default when the open mailbox changes.
 */
export default function GlobalSearch() {
	const location = useLocation();
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const openPalette = useCommandPaletteStore((state) => state.open);
	const pageScope = searchScope(location.pathname);
	const mailboxId = mailboxFromPath(location.pathname);
	const [wantAll, setWantAll] = useState(false);
	useEffect(() => setWantAll(false), [mailboxId]);
	const scope: SearchScope = wantAll ? { kind: "all" } : pageScope;
	const { data: folders = [] } = useFolders(mailboxId ?? undefined);
	const inputRef = useRef<HTMLInputElement>(null);

	// The field mirrors `?q=` on a results page, and clears when leaving one.
	const onResults = isSearchPath(location.pathname);
	const urlQuery = onResults ? (searchParams.get("q") ?? "") : "";
	const [query, setQuery] = useState(urlQuery);
	useEffect(() => setQuery(urlQuery), [urlQuery]);

	return (
		<MailSearchBar
			value={query}
			onChange={setQuery}
			onSubmit={(q) => {
				const trimmed = q.trim();
				if (trimmed) navigate(searchHref(scope, trimmed));
			}}
			folders={folders}
			inputRef={inputRef}
			placeholder={scope.kind === "mailbox" ? "Search this mailbox" : "Search all inboxes"}
			scopeChip={scope.kind === "mailbox" ? "This mailbox" : "All inboxes"}
			scopes={[
				{ value: "mailbox", label: "This mailbox", disabled: !mailboxId },
				{ value: "all", label: "All inboxes" },
			]}
			scopeValue={scope.kind}
			onScopeChange={(value) => setWantAll(value === "all")}
			// "Ask my inbox" (#132), from every page, in the same scope as search.
			onAsk={(question) => navigate(`${searchHref(scope, question)}&ask=1`)}
			onOpenPalette={() => openPalette()}
		/>
	);
}
