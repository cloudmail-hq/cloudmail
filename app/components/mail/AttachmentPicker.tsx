/**
 * Attachment staging for the composer.
 *
 * Validates against the platform's per-message ceiling up front, because sends
 * are dispatched in `waitUntil()` and an oversized message would otherwise fail
 * invisibly after the composer had already closed.
 */

import { useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import {
	MAX_TOTAL_ATTACHMENTS_SIZE,
	formatBytes,
	isImageMimeType,
	validateAttachment,
} from "~/lib/utils";

/** A file staged for sending, before it is base64-encoded for the API. */
export interface AttachmentFile {
	id: string;
	file: File;
	/** Object URL for image thumbnails; revoked when the chip is removed. */
	preview?: string;
}

/**
 * Build the add-files handler shared by the button and the drop target, so both
 * enforce the same size budget.
 */
export function createAttachmentAdder(
	attachments: AttachmentFile[],
	onChange: (next: AttachmentFile[]) => void,
	onError: (message: string) => void,
) {
	return (files: FileList | File[]) => {
		const accepted: AttachmentFile[] = [];
		let runningTotal = attachments.reduce((sum, a) => sum + a.file.size, 0);

		for (const file of Array.from(files)) {
			const check = validateAttachment(file, runningTotal);
			if (!check.valid) {
				onError(check.error ?? `${file.name} could not be attached.`);
				continue;
			}
			runningTotal += file.size;
			accepted.push({
				id: crypto.randomUUID(),
				file,
				preview: isImageMimeType(file.type)
					? URL.createObjectURL(file)
					: undefined,
			});
		}

		if (accepted.length > 0) onChange([...attachments, ...accepted]);
	};
}

/** Drop-target wiring for the composer body. */
export function useAttachmentDrop(
	add: (files: FileList | File[]) => void,
	disabled?: boolean,
) {
	const [isOver, setIsOver] = useState(false);

	return {
		isOver,
		handlers: {
			onDragOver: (e: React.DragEvent) => {
				if (disabled) return;
				e.preventDefault();
				setIsOver(true);
			},
			onDragLeave: () => setIsOver(false),
			onDrop: (e: React.DragEvent) => {
				if (disabled) return;
				e.preventDefault();
				setIsOver(false);
				if (e.dataTransfer.files?.length) add(e.dataTransfer.files);
			},
		},
	};
}

/** Chips for the staged files, with per-file removal and a running total. */
export function AttachmentChips({
	attachments,
	onChange,
	disabled,
}: {
	attachments: AttachmentFile[];
	onChange: (next: AttachmentFile[]) => void;
	disabled?: boolean;
}) {
	if (attachments.length === 0) return null;

	const total = attachments.reduce((sum, a) => sum + a.file.size, 0);

	return (
		<div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
			{attachments.map((att) => (
				<span
					key={att.id}
					className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-2 py-1 text-[11px] text-text-secondary"
				>
					{att.preview ? (
						<img
							src={att.preview}
							alt=""
							className="h-4 w-4 rounded object-cover"
						/>
					) : (
						<Paperclip size={10} aria-hidden />
					)}
					<span className="max-w-[160px] truncate font-medium">
						{att.file.name}
					</span>
					<span className="font-light text-text-tertiary">
						{formatBytes(att.file.size)}
					</span>
					<button
						type="button"
						disabled={disabled}
						onClick={() => {
							if (att.preview) URL.revokeObjectURL(att.preview);
							onChange(attachments.filter((a) => a.id !== att.id));
						}}
						aria-label={`Remove ${att.file.name}`}
						// Inside a chip: exempt from the 44px floor, held to 24px (WCAG 2.5.8).
						className="touch-exempt inline-flex items-center justify-center rounded-full p-0.5 hover:bg-black/10 disabled:opacity-40 touch:min-h-6 touch:min-w-6"
					>
						<X size={9} />
					</button>
				</span>
			))}
			<span className="text-[10px] font-light text-text-tertiary">
				{formatBytes(total)} of {formatBytes(MAX_TOTAL_ATTACHMENTS_SIZE)}
			</span>
		</div>
	);
}

interface AttachmentPickerProps {
	attachments: AttachmentFile[];
	onChange: (next: AttachmentFile[]) => void;
	onError: (message: string) => void;
	disabled?: boolean;
}

export default function AttachmentPicker({
	attachments,
	onChange,
	onError,
	disabled,
}: AttachmentPickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const add = createAttachmentAdder(attachments, onChange, onError);

	return (
		<>
			<button
				type="button"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
				title="Attach files"
				aria-label="Attach files"
				className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary disabled:opacity-40"
			>
				<Paperclip size={15} />
			</button>
			<input
				ref={inputRef}
				type="file"
				multiple
				className="hidden"
				onChange={(e) => {
					if (e.target.files?.length) add(e.target.files);
					e.target.value = "";
				}}
			/>
		</>
	);
}
