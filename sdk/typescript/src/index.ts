export { Tapetide, Tapetide as Cloudmail } from "./client.js";
export type {
	CallOptions,
	SendInput,
	ListEmailsOptions,
	SearchOptions,
	ApprovalStatus,
	ApprovalEdit,
	ApproveOptions,
	WaitForDecisionOptions,
} from "./client.js";
export type { ScheduleInput, Out } from "./resources.js";
export { OPERATIONS } from "./generated/operations.js";
export type { OperationId } from "./generated/operations.js";
export { HttpClient, IDEMPOTENT_POST_PATHS, SEND_POST_PATHS, SDK_VERSION, buildPath, buildQuery, retryAfterMs } from "./http.js";
export type { ClientOptions, RequestOptions, ApiResponse, FetchLike } from "./http.js";
export {
	TapetideError,
	TapetideError as CloudmailError,
	AuthenticationError,
	PermissionDeniedError,
	NotFoundError,
	ConflictError,
	ApprovalChangedError,
	ValidationError,
	RateLimitError,
	ServerError,
	APIConnectionError,
	retryAfterSeconds,
} from "./errors.js";
export type { ErrorInit } from "./errors.js";
export {
	EventsResource,
	SseParser,
	StreamRevokedError,
	CLOSE_CREDENTIAL_REVOKED,
	CLOSE_REAUTHENTICATE,
	CLOSE_AUTH_UNAVAILABLE,
	CLOSE_SLOW_CONSUMER,
} from "./events.js";
export type { SubscribeOptions, StreamEvent, ControlFrame, Subscription, WebSocketLike, WebSocketFactory, SseMessage } from "./events.js";
export {
	verifyWebhook,
	signWebhookPayload,
	WebhookVerificationError,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
	DEFAULT_TOLERANCE_SECONDS,
} from "./webhooks.js";
export type { VerifyOptions, HeaderSource } from "./webhooks.js";
export { isPendingApproval } from "./types.js";
export type * from "./types.js";
