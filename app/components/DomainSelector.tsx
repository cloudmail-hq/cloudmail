// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect } from "react";
import { Globe, ChevronDown, Check } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useZoneStore } from "~/hooks/useZoneStore";

interface Zone {
	id: string;
	domain: string;
	name: string;
	zoneId?: string;
}

interface DomainSelectorProps {
	zones: Zone[];
	className?: string;
}

export default function DomainSelector({ zones, className = "" }: DomainSelectorProps) {
	const { selectedZone, hasChosenZone, setSelectedZone, setZones } =
		useZoneStore();

	// Update zones in store when props change
	useEffect(() => {
		setZones(zones);
	}, [zones, setZones]);

	// Default to the first zone, but only before the user has chosen anything.
	// Keying this off `!selectedZone` instead made "All Domains" — which is
	// represented by a null zone — unselectable: it was overwritten on the very
	// next render.
	useEffect(() => {
		if (!hasChosenZone && !selectedZone && zones.length > 0) {
			setSelectedZone(zones[0]);
		}
	}, [zones, hasChosenZone, selectedZone, setSelectedZone]);

	// Don't show selector if only one zone
	if (zones.length <= 1) {
		return null;
	}

	// A null zone after the user has chosen means "All Domains", not "nothing
	// picked yet" — labelling it "Select Domain" would read as an empty state.
	const displayName =
		selectedZone?.name ||
		selectedZone?.domain ||
		(hasChosenZone ? "All Domains" : "Select Domain");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-bg-muted hover:text-text-primary ${className}`}
				>
					<Globe className="h-3.5 w-3.5" />
					<span className="hidden sm:inline max-w-[120px] truncate">
						{displayName}
					</span>
					<ChevronDown className="h-3 w-3 opacity-60" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<div className="px-2 py-1.5 text-xs font-medium text-text-secondary">
					Select Domain
				</div>
				<DropdownMenuSeparator />
				{zones.map((zone) => (
					<DropdownMenuItem
						key={zone.id}
						onClick={() => setSelectedZone(zone)}
						className="cursor-pointer flex items-center justify-between"
					>
						<div className="flex flex-col">
							<span className="text-sm font-medium">{zone.name}</span>
							{zone.name !== zone.domain && (
								<span className="text-xs text-text-secondary">{zone.domain}</span>
							)}
						</div>
						{selectedZone?.id === zone.id && (
							<Check className="h-4 w-4 text-violet" />
						)}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={() => setSelectedZone(null)}
					className="cursor-pointer flex items-center justify-between"
				>
					<span className="text-sm">All Domains</span>
					{!selectedZone && <Check className="h-4 w-4 text-violet" />}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
