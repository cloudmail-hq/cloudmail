// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * The global authentication Durable Object.
 *
 * One instance (`idFromName("global")`) holds every account, session and
 * token. A single object is what makes the invariants cheap: "create the owner
 * only if no user exists", single-use links and lockout counters are plain
 * SQLite transactions instead of distributed coordination. Load is small —
 * validation is one indexed read — and the expensive part, scrypt, runs in the
 * stateless Worker before the call ever arrives.
 *
 * All logic lives in `AuthStore` (`store-core.ts`) so it can be unit tested
 * without `cloudflare:workers`; this class only adapts storage and exposes each
 * method over RPC.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { AuthStore } from "./store-core";
import { SendingHealthStore } from "../lib/sending-health-store";
import { UsageStore, type AiProviderUsageRow, type AiRoleUsageRow } from "../lib/usage-store";
import type { AiUsageEntry } from "../lib/ai-usage";
import type { AiFeature, BudgetKind, UsageBudget, UsageBudgetPatch } from "../../shared/usage";
import type { HealthNotification, SendingDomainHealth, SpamRateEvaluation } from "../../shared/sending-health";
import {
	beginIdempotent,
	completeIdempotent,
	releaseIdempotent,
	type IdempotencyBeginInput,
	type IdempotencyBeginResult,
	type IdempotencyCompleteInput,
	type IdempotencyReleaseInput,
} from "../lib/idempotency-store";
import {
	DomainStore,
	type CreateDomainResult,
	type DomainDetailRecord,
	type DomainPatch,
	type DomainRecord,
	type SetAliasesResult,
} from "../lib/domain-store";
import { ImportCredentialStore } from "../lib/import-credential-store";
import {
	CloudflareConnectionStore,
	type CloudflareConnectionPatch,
	type CloudflareConnectionRecord,
	type PutCloudflareConnectionInput,
} from "../lib/cf-connection-store";
import { DnsChangeLogStore, type RecordDnsChangeInput } from "../lib/dns-change-log";
import { DeploymentOriginStore } from "../lib/deployment-origin-store";
import { LicenceStore, type LicenceRecord } from "../lib/licence-store";
import type { CfDnsChange } from "../../shared/cf-setup";
import { ProductStore, type ProductInput, type ProductWriteResult } from "../lib/product-store";
import { PushStore, type PushSubscriptionRecord, type PushTarget } from "../lib/push-store";
import type { PushPrefs, PushPrefsPatch, ThrottleDecision } from "../../shared/push-policy";
import type { Product } from "../../shared/products";
import type {
	AcceptInviteResult,
	ApiTokenInfo,
	AuthStoreApi,
	AuthUser,
	CreateOwnerResult,
	InviteInfo,
	InviteRole,
	IssueEmailResetResult,
	LoginCandidate,
	LockState,
	OAuthGrantInfo,
	PasskeyCredential,
	PasskeyInfo,
	SessionInfo,
	SuppressionEntryInput,
	SuppressionListOptions,
	SuppressionPage,
	SuppressionRecord,
	SuppressionStoreApi,
	TotpState,
	WebAuthnPurpose,
	ExportJobRecord,
	PrivacyStoreApi,
} from "./types";

export class AuthDO extends DurableObject<Env> implements AuthStoreApi, SuppressionStoreApi, PrivacyStoreApi {
	// Assigned inside blockConcurrencyWhile, which runs before any request.
	private store!: AuthStore;
	// Same database; the domain tables are created by AuthStore's migrations.
	private domains!: DomainStore;
	private products!: ProductStore;
	// Spam-rate circuit breaker; table created by AuthStore's 0012 migration.
	private health!: SendingHealthStore;
	// Usage tab counters and budget; tables from 0019_ai_usage_and_budget.
	private usage!: UsageStore;
	// Web Push; tables created by AuthStore's 0018 migration.
	private push!: PushStore;
	// IMAP import passwords (ciphertext only); table from migration 0020.
	private importCredentials!: ImportCredentialStore;
	// The Cloudflare API token (ciphertext only); table from migration 0022.
	private cloudflare!: CloudflareConnectionStore;
	// Cloudflare onboarding change log; table from migration 0023.
	private dnsChanges!: DnsChangeLogStore;
	// The deployment origin; table from migration 0024.
	private origin!: DeploymentOriginStore;
	// The licence; table from migration 0025.
	private licence!: LicenceStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.store = new AuthStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.domains = new DomainStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.products = new ProductStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.health = new SendingHealthStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.usage = new UsageStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.push = new PushStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.importCredentials = new ImportCredentialStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.cloudflare = new CloudflareConnectionStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.dnsChanges = new DnsChangeLogStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.origin = new DeploymentOriginStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
			this.licence = new LicenceStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
		});
	}

	// Usage and budget. See workers/lib/usage.ts.

	async recordAiCall(feature: AiFeature, day: string, calls = 1): Promise<void> {
		this.usage.recordAiCall(feature, day, calls);
	}

	async aiUsage(fromDay: string, today: string) {
		return this.usage.aiCalls(fromDay, today);
	}

	/** One model request per provider and role (from the router). Invalid entries are ignored. */
	async recordAiUsage(entry: AiUsageEntry): Promise<void> {
		this.usage.recordAiUsage(entry);
	}

	async aiUsageByProvider(fromDay: string, today: string): Promise<AiProviderUsageRow[]> {
		return this.usage.aiUsageByProvider(fromDay, today);
	}

	async aiUsageByRole(fromDay: string, today: string): Promise<AiRoleUsageRow[]> {
		return this.usage.aiUsageByRole(fromDay, today);
	}

	async pruneAiUsage(today: string): Promise<void> {
		this.usage.pruneAiCalls(today);
	}

	async getUsageBudget(): Promise<UsageBudget> {
		return this.usage.getBudget();
	}

	async setUsageBudget(patch: UsageBudgetPatch, by: string | null, now: number): Promise<UsageBudget> {
		return this.usage.setBudget(patch, by, now);
	}

	async claimBudgetAlert(month: string, kind: BudgetKind, projected: number, threshold: number, now: number): Promise<boolean> {
		return this.usage.claimBudgetAlert(month, kind, projected, threshold, now);
	}

	async firedBudgetAlerts(month: string) {
		return this.usage.firedAlerts(month);
	}

	async claimBudgetCheck(now: number, intervalMs: number): Promise<boolean> {
		return this.usage.claimBudgetCheck(now, intervalMs);
	}

	// Sending health (spam-rate circuit breaker). See workers/lib/sending-health.ts.

	async listSendingHealth(): Promise<SendingDomainHealth[]> {
		return this.health.list();
	}

	async isBulkPaused(domain: string): Promise<{ paused: boolean; reason: string | null }> {
		return this.health.isBulkPaused(domain);
	}

	async recordSendingHealth(
		domain: string,
		evaluation: SpamRateEvaluation & { source: string; providerStatus?: string | null },
		now: number,
	): Promise<{ health: SendingDomainHealth; notify: HealthNotification }> {
		return this.health.record(domain, evaluation, now);
	}

	async resumeBulkSending(domain: string, by: string | null, now: number): Promise<SendingDomainHealth | null> {
		return this.health.resume(domain, by, now);
	}

	async pauseBulkSending(domain: string, reason: string, now: number): Promise<SendingDomainHealth> {
		return this.health.pause(domain, reason, now);
	}

	async claimSendingHealthRun(now: number, intervalMs: number): Promise<boolean> {
		return this.health.claimEvaluation(now, intervalMs);
	}

	// Web Push. See workers/lib/push-store.ts and workers/lib/push.ts.

	async pushUpsertSubscription(input: Parameters<PushStore["upsertSubscription"]>[0]): Promise<PushSubscriptionRecord> {
		return this.push.upsertSubscription(input);
	}

	async pushListSubscriptions(userKey: string): Promise<PushSubscriptionRecord[]> {
		return this.push.listSubscriptions(userKey);
	}

	async pushDeleteSubscription(userKey: string, ref: { id?: string; endpoint?: string }): Promise<boolean> {
		return this.push.deleteSubscription(userKey, ref);
	}

	async pushReplaceSubscription(input: Parameters<PushStore["replaceSubscription"]>[0]): Promise<PushSubscriptionRecord | null> {
		return this.push.replaceSubscription(input);
	}

	async pushRecordDelivery(
		id: string,
		outcome: { ok: true } | { ok: false; status: number; error: string },
		now: number,
	): Promise<"ok" | "removed" | "failed"> {
		return this.push.recordDelivery(id, outcome, now);
	}

	async pushListTargets(): Promise<PushTarget[]> {
		return this.push.listTargets();
	}

	async pushGetPrefs(userKey: string): Promise<PushPrefs> {
		return this.push.getPrefs(userKey);
	}

	async pushUpdatePrefs(userKey: string, patch: PushPrefsPatch, now: number): Promise<PushPrefs> {
		return this.push.updatePrefs(userKey, patch, now);
	}

	async pushClaimSlot(userKey: string, threadKey: string | null, now: number): Promise<ThrottleDecision> {
		return this.push.claimSlot(userKey, threadKey, now);
	}

	async pushSpendToken(jti: string, expiresAt: number, now: number): Promise<boolean> {
		return this.push.spendToken(jti, expiresAt, now);
	}

	async pushAccountFlags(userKey: string): Promise<{ isOwner: boolean; disabled: boolean }> {
		return this.push.accountFlags(userKey);
	}

	// IMAP import credentials. See workers/lib/import-credential-store.ts.

	async putImportCredential(input: { jobId: string; mailboxId: string; secretEnc: string; now: number }): Promise<void> {
		this.importCredentials.put(input);
	}

	async getImportCredential(jobId: string, mailboxId: string): Promise<string | null> {
		return this.importCredentials.get(jobId, mailboxId);
	}

	async deleteImportCredential(jobId: string): Promise<boolean> {
		return this.importCredentials.delete(jobId);
	}

	async deleteImportCredentialsForMailbox(mailboxId: string): Promise<number> {
		return this.importCredentials.deleteForMailbox(mailboxId.toLowerCase());
	}

	// Cloudflare connection. See workers/lib/cf-connection-store.ts.

	async getCloudflareConnection(): Promise<CloudflareConnectionRecord | null> {
		return this.cloudflare.get();
	}

	async putCloudflareConnection(input: PutCloudflareConnectionInput): Promise<CloudflareConnectionRecord> {
		return this.cloudflare.put(input);
	}

	async updateCloudflareConnection(patch: CloudflareConnectionPatch, now: number): Promise<CloudflareConnectionRecord | null> {
		return this.cloudflare.update(patch, now);
	}

	async deleteCloudflareConnection(): Promise<boolean> {
		return this.cloudflare.delete();
	}

	// Cloudflare onboarding change log. See workers/lib/dns-change-log.ts.

	async recordDnsChange(input: RecordDnsChangeInput): Promise<CfDnsChange> {
		return this.dnsChanges.record(input);
	}

	async getDnsChange(id: string): Promise<CfDnsChange | null> {
		return this.dnsChanges.get(id);
	}

	async listDnsChanges(limit: number, zoneId?: string): Promise<CfDnsChange[]> {
		return this.dnsChanges.list(limit, zoneId);
	}

	async markDnsChangeReverted(id: string, by: string | null, now: number): Promise<CfDnsChange | null> {
		return this.dnsChanges.markReverted(id, by, now);
	}

	async clearDnsChangeReverted(id: string): Promise<void> {
		this.dnsChanges.clearReverted(id);
	}

	// Licence. See workers/lib/licence.ts. Times are Unix seconds.

	async getLicence(): Promise<LicenceRecord> {
		return this.licence.get(Math.floor(Date.now() / 1000), () => `dep_${crypto.randomUUID()}`);
	}

	async storeLicenceToken(token: string, refreshAfter: number | null): Promise<LicenceRecord | null> {
		this.licence.get(Math.floor(Date.now() / 1000), () => `dep_${crypto.randomUUID()}`);
		return this.licence.storeToken(token, refreshAfter, Math.floor(Date.now() / 1000));
	}

	async recordLicenceFailure(serverStatus: string | null, serverReason: string | null): Promise<LicenceRecord | null> {
		return this.licence.recordFailure(Math.floor(Date.now() / 1000), serverStatus, serverReason);
	}

	async clearLicenceToken(): Promise<LicenceRecord | null> {
		return this.licence.clearToken(Math.floor(Date.now() / 1000));
	}

	async claimLicenceRefresh(minIntervalSeconds: number): Promise<boolean> {
		return this.licence.claimRefresh(Math.floor(Date.now() / 1000), minIntervalSeconds);
	}

	// Deployment origin. See workers/lib/deployment-origin.ts.

	async getDeploymentOrigin(): Promise<{ origin: string; rank: number } | null> {
		const row = this.origin.get();
		return row ? { origin: row.origin, rank: row.rank } : null;
	}

	async recordDeploymentOrigin(origin: string, rank: number, source: string, now: number): Promise<{ origin: string; changed: boolean }> {
		return this.origin.record(origin, rank, source, now);
	}

	async isSetupRequired(): Promise<boolean> {
		return this.store.isSetupRequired();
	}

	async ensureGeneratedSetupToken(): Promise<string> {
		return this.store.ensureGeneratedSetupToken();
	}

	async createOwner(input: {
		email: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<CreateOwnerResult> {
		return this.store.createOwner(input);
	}

	async recoverOwner(input: { passwordHash: string; now: number }): Promise<{ email: string } | null> {
		return this.store.recoverOwner(input);
	}

	async getRecoveryLock(now: number): Promise<LockState> {
		return this.store.getRecoveryLock(now);
	}

	async recordRecoveryFailure(now: number): Promise<LockState & { failures: number }> {
		return this.store.recordRecoveryFailure(now);
	}

	async getLoginCandidate(email: string): Promise<LoginCandidate | null> {
		return this.store.getLoginCandidate(email);
	}

	async getLoginLock(email: string, ip: string, now: number): Promise<LockState> {
		return this.store.getLoginLock(email, ip, now);
	}

	async recordLoginFailure(
		email: string,
		ip: string,
		now: number,
	): Promise<LockState & { accountAlert: boolean }> {
		return this.store.recordLoginFailure(email, ip, now);
	}

	async recordLoginSuccess(userId: string, ip: string, now: number): Promise<void> {
		return this.store.recordLoginSuccess(userId, ip, now);
	}

	async createSession(input: {
		userId: string;
		tokenHash: string;
		ip: string | null;
		userAgent: string | null;
		now: number;
	}): Promise<SessionInfo> {
		return this.store.createSession(input);
	}

	async validateSession(tokenHash: string,
		now: number,): Promise<{ user: AuthUser; session: SessionInfo; epoch?: number } | null> {
		return this.store.validateSession(tokenHash, now);
	}

	async deleteSession(tokenHash: string): Promise<void> {
		return this.store.deleteSession(tokenHash);
	}

	async listSessions(userId: string, now: number): Promise<SessionInfo[]> {
		return this.store.listSessions(userId, now);
	}

	async revokeSession(userId: string, sessionId: string): Promise<boolean> {
		return this.store.revokeSession(userId, sessionId);
	}

	async revokeOtherSessions(userId: string, keepTokenHash: string | null): Promise<number> {
		return this.store.revokeOtherSessions(userId, keepTokenHash);
	}

	async createMfaChallenge(input: { userId: string; challengeHash: string; now: number }): Promise<void> {
		return this.store.createMfaChallenge(input);
	}

	async useMfaChallenge(challengeHash: string, now: number): Promise<{ userId: string } | null> {
		return this.store.useMfaChallenge(challengeHash, now);
	}

	async deleteMfaChallenge(challengeHash: string): Promise<void> {
		return this.store.deleteMfaChallenge(challengeHash);
	}

	async getMfaLock(userId: string, now: number): Promise<LockState> {
		return this.store.getMfaLock(userId, now);
	}

	async recordMfaFailure(userId: string, now: number): Promise<LockState> {
		return this.store.recordMfaFailure(userId, now);
	}

	async getTotp(userId: string): Promise<TotpState> {
		return this.store.getTotp(userId);
	}

	async setPendingTotp(userId: string, secretEnc: string): Promise<void> {
		return this.store.setPendingTotp(userId, secretEnc);
	}

	async enableTotp(userId: string, step: number, recoveryCodeHashes: string[]): Promise<void> {
		return this.store.enableTotp(userId, step, recoveryCodeHashes);
	}

	async disableTotp(userId: string): Promise<void> {
		return this.store.disableTotp(userId);
	}

	async recordTotpStep(userId: string, step: number): Promise<boolean> {
		return this.store.recordTotpStep(userId, step);
	}

	async replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
		return this.store.replaceRecoveryCodes(userId, hashes);
	}

	async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
		return this.store.consumeRecoveryCode(userId, hash);
	}

	async countRecoveryCodes(userId: string): Promise<number> {
		return this.store.countRecoveryCodes(userId);
	}

	async getUser(userId: string): Promise<AuthUser | null> {
		return this.store.getUser(userId);
	}

	async getUserByEmail(email: string): Promise<AuthUser | null> {
		return this.store.getUserByEmail(email);
	}

	async listUsers(): Promise<AuthUser[]> {
		return this.store.listUsers();
	}

	async updatePassword(userId: string, passwordHash: string, now: number): Promise<void> {
		return this.store.updatePassword(userId, passwordHash, now);
	}

	async updateProfile(userId: string, patch: { name?: string }): Promise<AuthUser | null> {
		return this.store.updateProfile(userId, patch);
	}

	async setDisabled(userId: string, disabled: boolean): Promise<boolean> {
		return this.store.setDisabled(userId, disabled);
	}

	async deleteUser(userId: string): Promise<boolean> {
		return this.store.deleteUser(userId);
	}

	async createInvite(input: {
		tokenHash: string;
		email: string;
		role: InviteRole;
		mailboxes: string[];
		createdBy: string | null;
		expiresAt: number;
		now: number;
	}): Promise<InviteInfo> {
		return this.store.createInvite(input);
	}

	async getInvite(tokenHash: string, now: number): Promise<InviteInfo | null> {
		return this.store.getInvite(tokenHash, now);
	}

	async listInvites(now: number): Promise<InviteInfo[]> {
		return this.store.listInvites(now);
	}

	async revokeInvite(inviteId: string): Promise<boolean> {
		return this.store.revokeInvite(inviteId);
	}

	async acceptInvite(input: {
		tokenHash: string;
		name: string;
		passwordHash: string;
		now: number;
	}): Promise<AcceptInviteResult> {
		return this.store.acceptInvite(input);
	}

	async createPasswordReset(input: {
		userId: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<void> {
		return this.store.createPasswordReset(input);
	}

	async issueEmailPasswordReset(input: {
		email: string;
		tokenHash: string;
		expiresAt: number;
		now: number;
	}): Promise<IssueEmailResetResult> {
		return this.store.issueEmailPasswordReset(input);
	}

	async getPasswordReset(tokenHash: string, now: number): Promise<{ userId: string; email: string } | null> {
		return this.store.getPasswordReset(tokenHash, now);
	}

	async consumePasswordReset(input: {
		tokenHash: string;
		passwordHash: string;
		now: number;
	}): Promise<{ userId: string } | null> {
		return this.store.consumePasswordReset(input);
	}

	async createApiToken(input: {
		id: string;
		userId: string;
		name: string;
		secretHash: string;
		expiresAt: number | null;
		now: number;
		scopes?: string[] | null;
		mailboxes?: string[] | null;
		parentId?: string | null;
	}): Promise<ApiTokenInfo> {
		return this.store.createApiToken(input);
	}

	async listApiTokens(userId: string): Promise<ApiTokenInfo[]> {
		return this.store.listApiTokens(userId);
	}

	async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
		return this.store.revokeApiToken(userId, tokenId);
	}

	async validateApiToken(tokenId: string,
		secretHash: string,
		now: number,
		ip: string | null = null,): Promise<{ user: AuthUser; token: ApiTokenInfo; epoch?: number } | null> {
		return this.store.validateApiToken(tokenId, secretHash, now, ip);
	}

	async createOAuthGrant(input: {
		userId: string;
		clientId: string;
		clientName: string;
		redirectHost: string;
		now: number;
	}): Promise<OAuthGrantInfo> {
		return this.store.createOAuthGrant(input);
	}

	async validateOAuthGrant(
		grantId: string,
		userId: string,
		now: number,
	): Promise<{ user: AuthUser; grant: OAuthGrantInfo; epoch?: number } | null> {
		return this.store.validateOAuthGrant(grantId, userId, now);
	}

	/** In memory in the store: an RPC with no storage read. See session-cache.ts. */
	async getAuthEpoch(): Promise<number> {
		return this.store.getAuthEpoch();
	}

	async listOAuthGrants(userId: string): Promise<OAuthGrantInfo[]> {
		return this.store.listOAuthGrants(userId);
	}

	async setOAuthGrantSendAuto(userId: string, grantId: string, sendAuto: boolean): Promise<OAuthGrantInfo | null> {
		return this.store.setOAuthGrantSendAuto(userId, grantId, sendAuto);
	}

	async revokeOAuthGrant(userId: string, grantId: string): Promise<boolean> {
		return this.store.revokeOAuthGrant(userId, grantId);
	}

	async createWebAuthnChallenge(input: {
		challengeHash: string;
		purpose: WebAuthnPurpose;
		userId: string | null;
		now: number;
	}): Promise<boolean> {
		return this.store.createWebAuthnChallenge(input);
	}

	async consumeWebAuthnChallenge(
		challengeHash: string,
		purpose: WebAuthnPurpose,
		userId: string | null,
		now: number,
	): Promise<boolean> {
		return this.store.consumeWebAuthnChallenge(challengeHash, purpose, userId, now);
	}

	async addPasskey(input: {
		userId: string;
		credentialId: string;
		publicKey: string;
		counter: number;
		transports: string[];
		aaguid: string;
		deviceType: "singleDevice" | "multiDevice";
		backedUp: boolean;
		name: string;
		now: number;
	}): Promise<PasskeyInfo> {
		return this.store.addPasskey(input);
	}

	async listPasskeys(userId: string): Promise<PasskeyInfo[]> {
		return this.store.listPasskeys(userId);
	}

	async listPasskeyCredentials(userId: string): Promise<PasskeyCredential[]> {
		return this.store.listPasskeyCredentials(userId);
	}

	async getPasskeyByCredentialId(
		credentialId: string,
	): Promise<{ passkey: PasskeyCredential; user: AuthUser } | null> {
		return this.store.getPasskeyByCredentialId(credentialId);
	}

	async recordPasskeyUse(input: {
		credentialId: string;
		newCounter: number;
		backedUp: boolean;
		now: number;
	}): Promise<boolean> {
		return this.store.recordPasskeyUse(input);
	}

	async renamePasskey(userId: string, passkeyId: string, name: string): Promise<PasskeyInfo | null> {
		return this.store.renamePasskey(userId, passkeyId, name);
	}

	async deletePasskey(userId: string, passkeyId: string): Promise<boolean> {
		return this.store.deletePasskey(userId, passkeyId);
	}

	async getSessionAuthenticatedAt(tokenHash: string): Promise<number | null> {
		return this.store.getSessionAuthenticatedAt(tokenHash);
	}

	async markSessionAuthenticated(tokenHash: string, now: number): Promise<boolean> {
		return this.store.markSessionAuthenticated(tokenHash, now);
	}

	async getOrInitMeta(key: string, fallback: string): Promise<string> {
		return this.store.getOrInitMeta(key, fallback);
	}

	// -- domains and aliases (see workers/lib/domain-store.ts) -----------------

	async listDomains(): Promise<DomainRecord[]> {
		return this.domains.listDomains();
	}

	async getDomain(idOrHostname: string): Promise<DomainDetailRecord | null> {
		return this.domains.getDomain(idOrHostname);
	}

	async createDomain(input: {
		hostname: string;
		displayName?: string;
		zoneId?: string | null;
		catchAllMailbox?: string | null;
		now: number;
	}): Promise<CreateDomainResult> {
		return this.domains.createDomain(input);
	}

	async seedDomains(zones: { domain: string; name: string; zoneId?: string }[], now: number): Promise<number> {
		return this.domains.seedDomains(zones, now);
	}

	/** Seed then list in one round trip: what a cold isolate's first request needs. */
	async seedAndListDomains(
		zones: { domain: string; name: string; zoneId?: string }[],
		now: number,
	): Promise<DomainRecord[]> {
		return this.domains.seedAndListDomains(zones, now);
	}

	async updateDomain(id: string, patch: DomainPatch, now: number): Promise<DomainDetailRecord | null> {
		return this.domains.updateDomain(id, patch, now);
	}

	async deleteDomain(id: string): Promise<boolean> {
		return this.domains.deleteDomain(id);
	}

	async listAliases(mailboxId: string): Promise<string[]> {
		return this.domains.listAliases(mailboxId);
	}

	async allAliases(): Promise<Record<string, string>> {
		return this.domains.allAliases();
	}

	async setAliases(mailboxId: string, addresses: string[], now: number): Promise<SetAliasesResult> {
		return this.domains.setAliases(mailboxId, addresses, now);
	}

	async forgetMailbox(mailboxId: string, now: number): Promise<void> {
		this.domains.forgetMailbox(mailboxId, now);
	}

	async routingLookup(addresses: string[]): Promise<{ aliases: Record<string, string>; catchAll: Record<string, string> }> {
		return this.domains.routingLookup(addresses);
	}

	// Products. See workers/lib/product-store.ts.

	async listProducts(): Promise<Product[]> {
		return this.products.listProducts();
	}

	/** Create a default product for every domain without one, then list. */
	async ensureAndListProducts(now: number): Promise<Product[]> {
		const domains = this.domains.listDomains().map((d) => ({ hostname: d.hostname, displayName: d.displayName }));
		return this.products.ensureDefaultProducts(domains, now);
	}

	async getProduct(idOrSlug: string): Promise<Product | null> {
		return this.products.getProduct(idOrSlug);
	}

	async createProduct(input: ProductInput & { name: string }, now: number): Promise<ProductWriteResult> {
		return this.products.createProduct(input, now);
	}

	async updateProduct(idOrSlug: string, input: ProductInput, now: number): Promise<ProductWriteResult> {
		return this.products.updateProduct(idOrSlug, input, now);
	}

	async deleteProduct(idOrSlug: string): Promise<Product | null> {
		return this.products.deleteProduct(idOrSlug);
	}

	async setProductLogo(idOrSlug: string, mimeType: string | null, now: number): Promise<Product | null> {
		return this.products.setProductLogo(idOrSlug, mimeType, now);
	}

	// Suppression list. See workers/lib/suppressions.ts.

	async listSuppressions(options?: SuppressionListOptions): Promise<SuppressionPage> {
		return this.store.listSuppressions(options);
	}

	async addSuppressions(
		entries: SuppressionEntryInput[],
		now: number,
	): Promise<{ added: number; existing: number; items: SuppressionRecord[] }> {
		return this.store.addSuppressions(entries, now);
	}

	async deleteSuppression(id: string): Promise<boolean> {
		return this.store.deleteSuppression(id);
	}

	async findSuppressions(addresses: string[], domain?: string | null): Promise<SuppressionRecord[]> {
		return this.store.findSuppressions(addresses, domain);
	}

	// Privacy: tracking opt-outs, account deletion, exports. See workers/lib/account-privacy.ts.

	async addTrackingOptOut(input: { address: string; scope: string; source: string; now: number }): Promise<boolean> {
		return this.store.addTrackingOptOut(input);
	}

	async findTrackingOptOuts(addresses: string[], domain?: string | null): Promise<{ address: string; scope: string }[]> {
		return this.store.findTrackingOptOuts(addresses, domain);
	}

	async scheduleAccountDeletion(input: { userId: string; now: number; graceMs: number; mailboxes: string[] }) {
		return this.store.scheduleAccountDeletion(input);
	}

	async getAccountDeletion(userId: string) {
		return this.store.getAccountDeletion(userId);
	}

	async cancelAccountDeletion(userId: string): Promise<boolean> {
		return this.store.cancelAccountDeletion(userId);
	}

	async listDueAccountDeletions(now: number, limit?: number) {
		return this.store.listDueAccountDeletions(now, limit);
	}

	async completeAccountDeletion(userId: string, now: number): Promise<boolean> {
		return this.store.completeAccountDeletion(userId, now);
	}

	async createExportJob(input: { id: string; userId: string; now: number; expiresAt: number; state: string }): Promise<ExportJobRecord> {
		return this.store.createExportJob(input);
	}

	async getExportJob(id: string): Promise<ExportJobRecord | null> {
		return this.store.getExportJob(id);
	}

	async listExportJobs(userId: string): Promise<ExportJobRecord[]> {
		return this.store.listExportJobs(userId);
	}

	async listActiveExportJobs(limit?: number): Promise<ExportJobRecord[]> {
		return this.store.listActiveExportJobs(limit);
	}

	async updateExportJob(id: string, patch: Parameters<AuthStore["updateExportJob"]>[1]): Promise<ExportJobRecord | null> {
		return this.store.updateExportJob(id, patch);
	}

	async takeExpiredExportJobs(now: number, limit?: number): Promise<ExportJobRecord[]> {
		return this.store.takeExpiredExportJobs(now, limit);
	}

	async escalateSuppression(entry: SuppressionEntryInput): Promise<boolean> {
		return this.store.escalateSuppression(entry);
	}

	// Idempotency keys for instance-level creates. See workers/lib/idempotency.ts.
	// Synchronous SQL inside one RPC, so the check-and-set cannot interleave.

	async idempotencyBegin(input: IdempotencyBeginInput): Promise<IdempotencyBeginResult> {
		return beginIdempotent(this.ctx.storage.sql, input);
	}

	async idempotencyComplete(input: IdempotencyCompleteInput): Promise<boolean> {
		return completeIdempotent(this.ctx.storage.sql, input);
	}

	async idempotencyRelease(input: IdempotencyReleaseInput): Promise<void> {
		releaseIdempotent(this.ctx.storage.sql, input);
	}
}

/** Stub for the single global `AuthDO`. */
export function authStore(env: Env): DurableObjectStub<AuthDO> {
	// Typed explicitly: the generated binding type only knows the class once
	// workers/app.ts re-exports it, and this helper should not depend on that.
	const ns = env.AUTH_STORE as unknown as DurableObjectNamespace<AuthDO>;
	return ns.get(ns.idFromName("global"));
}
