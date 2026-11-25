// Shared constants for the offline demo instance (scripts/demo). All names,
// domains and people are fictional; `.example` is reserved by RFC 2606.

export const DEMO_ZONES = [
	{ domain: "northwind.example", name: "Northwind Supply Co." },
	{ domain: "northwindlabs.example", name: "Northwind Labs" },
	{ domain: "harborline.example", name: "Harborline Goods" },
];

// Local-only values for the throwaway demo instance. Not secrets.
export const DEMO_SETUP_TOKEN = "demo-setup-token-local-only-0000";
export const DEMO_AUTH_SECRET = "demo-auth-secret-local-only-00000000000000";

export const DEMO_OWNER = {
	name: "Maya Okafor",
	email: "maya@northwind.example",
	password: "demo-password-northwind-2026",
};

export const DEMO_BASE_URL = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:5173";
