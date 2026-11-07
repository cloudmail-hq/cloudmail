/**
 * Bulk actions for the ticked rows.
 *
 * Replaces the list heading while a selection exists rather than stacking below
 * it, so the first row stays on screen on short viewports.
 */

import {
	ArchiveRestore,
	FolderInput,
	MailOpen,
	Mail,
	Star,
	Tag,
	Trash2,
	X,
} from "lucide-react";
import { canMoveInto } from "shared/folders";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { BulkActionRequest } from "~/services/api";
import type { Folder, Label } from "~/types";

export interface BulkExtra {
	folder_id?: string;
	label_id?: string;
}

interface MailSelectionBarProps {
	count: number;
	allSelected: boolean;
	onToggleAll: () => void;
	onClear: () => void;
	onAction: (action: BulkActionRequest["action"], extra?: BulkExtra) => void;
	/** Move targets; the folder on screen is filtered out upstream. */
	folders: Folder[];
	labels: Label[];
	/** Listing the bin, so the selection can be put back where it came from. */
	canRestore?: boolean;
	/**
	 * Delete destroys rather than bins: true in Trash and in Spam, matching the
	 * storage layer. Drives the label, and makes the caller confirm.
	 */
	deleteDestroys?: boolean;
	busy?: boolean;
}

function IconButton({
	label,
	onClick,
	disabled,
	danger,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			className={`inline-flex h-7 w-7 items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 ${
				danger
					? "text-text-secondary hover:bg-destructive/10 hover:text-destructive"
					: "text-text-secondary hover:bg-bg-muted hover:text-text-primary"
			}`}
		>
			{children}
		</button>
	);
}

export default function MailSelectionBar({
	count,
	allSelected,
	onToggleAll,
	onClear,
	onAction,
	folders,
	labels,
	canRestore = false,
	deleteDestroys = false,
	busy = false,
}: MailSelectionBarProps) {
	return (
		<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-bg-subtle/80 px-3 py-2">
			<input
				type="checkbox"
				checked={allSelected}
				onChange={onToggleAll}
				aria-label={allSelected ? "Deselect all" : "Select all"}
				className="h-3.5 w-3.5 cursor-pointer accent-violet"
			/>
			<span className="mr-1 text-xs font-semibold text-text-primary">
				{count} selected
			</span>

			<IconButton
				label="Mark as read"
				onClick={() => onAction("read")}
				disabled={busy}
			>
				<MailOpen size={14} />
			</IconButton>
			<IconButton
				label="Mark as unread"
				onClick={() => onAction("unread")}
				disabled={busy}
			>
				<Mail size={14} />
			</IconButton>
			<IconButton
				label="Star"
				onClick={() => onAction("star")}
				disabled={busy}
			>
				<Star size={14} />
			</IconButton>

			{folders.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							disabled={busy}
							title="Move to"
							aria-label="Move to folder"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
						>
							<FolderInput size={14} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuLabel>Move to</DropdownMenuLabel>
						{/* Drafts and Scheduled are refused by the server; see `canMoveInto`. */}
						{folders.filter((f) => canMoveInto(f.id)).map((folder) => (
							<DropdownMenuItem
								key={folder.id}
								className="cursor-pointer"
								onClick={() => onAction("move", { folder_id: folder.id })}
							>
								{folder.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			{labels.length > 0 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							disabled={busy}
							title="Apply label"
							aria-label="Apply label"
							className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
						>
							<Tag size={14} />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-48">
						<DropdownMenuLabel>Apply label</DropdownMenuLabel>
						{labels.map((label) => (
							<DropdownMenuItem
								key={label.id}
								className="cursor-pointer"
								onClick={() => onAction("label", { label_id: label.id })}
							>
								<span
									className="h-2.5 w-2.5 rounded-full"
									style={{ backgroundColor: label.color }}
									aria-hidden
								/>
								{label.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}

			{canRestore && (
				<IconButton
					label="Restore to original folder"
					onClick={() => onAction("restore")}
					disabled={busy}
				>
					<ArchiveRestore size={14} />
				</IconButton>
			)}

			{/*
			  Where Delete is reversible this bins the selection and the caller offers
			  Undo, so it does not ask. Where it destroys, the caller confirms.
			*/}
			<IconButton
				label={deleteDestroys ? "Delete forever" : "Move to Trash"}
				onClick={() =>
					onAction(deleteDestroys ? "delete_permanently" : "delete")
				}
				disabled={busy}
				danger
			>
				<Trash2 size={14} />
			</IconButton>

			<div className="flex-1" />

			<IconButton label="Clear selection" onClick={onClear}>
				<X size={14} />
			</IconButton>
		</div>
	);
}
