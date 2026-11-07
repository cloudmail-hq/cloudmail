/** The admin grace banner under the top bar, beside the deliverability one. */

import { useDashboardUser } from "~/queries/people";
import { useLicence } from "~/queries/licence";
import { LicenceGraceBanner } from "./LicenceParts";

export default function LicenceBanner() {
	const isAdmin = useDashboardUser()?.role === "admin";
	const { data } = useLicence(isAdmin);
	if (!isAdmin || data?.status !== "grace") return null;
	return <LicenceGraceBanner view={data} strip />;
}
