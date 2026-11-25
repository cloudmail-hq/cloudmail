/** The admin grace banner under the top bar, beside the deliverability one. */

import { useDashboardUser } from "~/queries/people";
import { useLicence } from "~/queries/licence";
import { LicenceGraceBanner, LicenceMovedBanner } from "./LicenceParts";

export default function LicenceBanner() {
	const isAdmin = useDashboardUser()?.role === "admin";
	const { data } = useLicence(isAdmin);
	if (!isAdmin || !data) return null;
	if (data.status === "grace") return <LicenceGraceBanner view={data} strip />;
	if (data.movedFrom) return <LicenceMovedBanner view={data} strip />;
	return null;
}
