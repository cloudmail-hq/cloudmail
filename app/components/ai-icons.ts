/**
 * One icon per AI feature.
 *
 * A sparkle on every AI surface says "AI" and nothing else: it cannot tell a
 * summary from an answer from a draft, and people stop seeing it. So the
 * sparkle is kept for AI in general (the agent, the AI settings heading) and
 * each feature gets an icon for what it does, always next to a text label.
 *
 * Import from here rather than from lucide-react, so a feature keeps the same
 * icon wherever it shows up.
 */
export {
	/** The agent panel and AI settings: AI in general. */
	Sparkles as AgentIcon,
	/** "Ask your inbox": a question answered from the mail. */
	MessageCircleQuestionMark as AskIcon,
	/** Replies the agent drafts on its own. */
	PencilLine as AutoDraftIcon,
	/** The daily brief ("Today"). */
	Sunrise as BriefIcon,
	/** Thread summaries: the list-row marker, the reader card, the button. */
	TextAlignStart as SummaryIcon,
	/** Labels applied by AI triage. */
	Tags as TriageIcon,
	/** The Screener's guess at who a new sender is. */
	UserSearch as VerdictIcon,
} from "lucide-react";
