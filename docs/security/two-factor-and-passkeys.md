# Passkeys, two-factor sign-in and recovery codes: research and plan

Date: 2026-11-23. Code read: `main` at 349070e. Status: the design in section 4 is being built in stages; PR 1 (#193, #194) covers the sign-in gate, recovery codes, the wrong-code cap, the last-factor rule and the admin reset. PR 2 (#195) adds the security emails. PR 3 adds the step-up with an existing factor.

## 1. What main already does

| Feature | Where | Notes |
|---|---|---|
| Passkey sign-in (no email needed) | `workers/auth/passkeys.ts`, `app/routes/login.tsx` | Autofill in the email field plus a "Sign in with a passkey" button. User verification (fingerprint, face or PIN) is required, so a passkey sign-in counts as two factors and skips the code step. |
| Authenticator app (TOTP) | `workers/auth/totp.ts`, `TwoFactorSettings.tsx` | RFC 6238, 6 digits, 30 s steps, ±1 step. A used code is refused (replay check). The QR code is drawn in the browser. The secret is encrypted with AES-GCM under `AUTH_SECRET`. |
| Second step after the password | `POST /api/auth/login` → `/login/mfa` or `/passkeys/mfa/*` | Accepts a TOTP code, a recovery code or a passkey. **Only runs when TOTP is on.** |
| Recovery codes | `generateRecoveryCodes` | 10 codes `xxxxx-xxxxx` (50 bits each), SHA-256 hashed, single use, Copy and Download. **Only issued with TOTP.** |
| Lockouts | `store-core.ts` | Password: per email+IP. Second factor: per account, 5 free tries, then 30 s doubling up to 15 min. 5 tries per sign-in attempt. |
| Step-up check | `session_step_ups`, 15 min | Required to add a passkey, export or delete the account, and change the Cloudflare connection. Since PR 3, factor changes need a second factor from the last 5 minutes instead (`session_factor_proofs`). |
| Org policy | "Require two-factor for everyone" | A passkey **or** TOTP satisfies it. |
| Owner break-glass | `/recover` with `SETUP_TOKEN` | Resets the owner's password and turns off TOTP. |

## 2. Gaps found in the code

1. **Passkey-only accounts have no second step on password sign-in.** The login gate checks `totpEnabled` only (`routes.ts:521`). Someone who added a passkey but no app can still sign in with just the password.
2. **The org policy is weaker than it looks.** `hasSecondFactor` counts a passkey as two-factor (`security-policy.ts`), so a passkey-only member passes "require two-factor" while their password still opens the account by itself.
3. **No recovery codes without TOTP.** A passkey-only user who loses the passkey has no way back in except a password reset, and that reset does not touch two-factor.
4. **Recovery codes are 50 bits with plain SHA-256.** NIST SP 800-63B-4 §4.2 asks for at least 64 bits for saved recovery codes. Below 112 bits it wants a salted, slow or keyed hash. A leaked AuthDO could be brute-forced offline at about a day per code on one GPU.
5. **No "codes left" count, no low-codes warning, no Print.** `countRecoveryCodes` exists in the store but nothing uses it.
6. **Factor changes are not all protected.** Regenerating codes asks for the password only, not a second factor. Deleting a passkey has no step-up at all. Nothing stops removing the last factor while the org policy requires one.
7. **No security emails.** NIST §4.6 says adding an authenticator SHALL trigger a notice, and recovery always does. OWASP says to notify on every factor change. Today these changes only go to the admin audit log.
8. **No admin "reset two-factor".** A member who loses both the phone and the codes is stuck. Only the owner has `/recover`.
9. **No hard limit on wrong codes.** The backoff caps at 15 min, so guessing never stops (about 96 tries a day, roughly 10% success within a year once the password is known). NIST §3.2.2 caps consecutive failures at 100.
10. **Passkey polish is missing.** Passkeys show as "Passkey 2" rather than "iCloud Keychain". There is no Signal API, so a deleted passkey lingers in the password manager. Nothing prompts "add a passkey" after a password sign-in.

## 3. What the standards and big services say

- **NIST SP 800-63B-4 (2025).** Synced passkeys are allowed up to AAL2 when user verification is checked. TOTP is not phishing-resistant, each code is accepted once, and consecutive failures are capped at 100. Recovery codes need ≥64 bits and hashed storage. Users must be notified when an authenticator is added and on recovery. https://pages.nist.gov/800-63-4/sp800-63b.html
- **OWASP MFA cheat sheet.** Issue recovery codes at setup. Require an existing factor, not just the session, before changing factors. Treat turning MFA off as sensitive. Notify on every change. https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html
- **Google and GitHub.** A passkey sign-in skips the second step, and any passkey can be the second step after a password. Codes: Google 10, GitHub 16. A new set voids the old one. GitHub offers Download, Print and Copy.
  - https://support.google.com/accounts/answer/13548313
  - https://docs.github.com/en/authentication/authenticating-with-a-passkey/about-passkeys
- **FIDO passkey UX (Passkey Central).** Autofill sign-in works best and a clear button is the fallback. Show the provider name, created and last-used dates. After a password sign-in, offer a dismissible "Sign in faster next time" prompt. https://www.passkeycentral.org/launch-and-grow/passkey-rubric
- **2026 attacks.** Phishing kits (Tycoon2FA) relay password+TOTP. Attackers who steal a session then **enrol their own passkey** (Okta, O-UNC-066). The defences are step-up with an existing factor and an email on every new factor.
  - https://www.microsoft.com/en-us/security/blog/2026/03/04/inside-tycoon2fa-how-a-leading-aitm-phishing-kit-operated-at-scale/
  - https://fidoalliance.org/security-boulevard-attackers-cant-steal-passkeys-so-theyre-enrolling-their-own/
- **Browser support for WebAuthn Level 3.**
  - Signal API: Chrome/Edge 132+ and Safari 26, not Firefox.
  - Automatic passkey upgrade (conditional create): Chrome 136+ and Safari 18, not Firefox.
  - SimpleWebAuthn browser 14 already has `sendSignal` and `useAutoRegister`.
  - The community AAGUID name list stops serving data on 2027-01-06, so a small bundled table of names is the safer source. https://github.com/passkeydeveloper/passkey-authenticator-aaguids

## 4. Proposed design

**Rule:** two-factor is on when the account has an authenticator app **or** at least one passkey. Then:

- **Passkey sign-in:** goes straight in (already the case).
- **Email + password sign-in:** always needs a second step, which is a passkey, an app code or a recovery code. The step screen leads with what the account has: "Use your passkey" for passkey-only accounts, the code box for app users.
- **Recovery codes** are issued with the first factor of either kind. There are 10 codes of 16 characters (`xxxx-xxxx-xxxx-xxxx`, 80 bits), stored as HMAC-SHA256 keyed by `AUTH_SECRET` and the user id. Old 10-character codes keep working until the set is regenerated. Settings shows the count left and warns at 3 or fewer. Copy, Download and Print are offered.
- **Changing a factor needs proof from a factor you already have.** This covers adding or deleting a passkey, turning the app on or off, and regenerating codes.
  - The proof is a passkey or an app code made in the last 5 minutes. Signing in with a passkey, an app code or a recovery code counts, so someone who lost their passkeys signs in with a recovery code and changes things within 5 minutes.
  - Turning the app off already asks for an app code or a recovery code in the same request.
  - Accounts with no second factor yet use the password.
  - You can't remove your last factor while the org requires two-factor.
- **Security emails** go to the account address through the existing reset-email path. They are sent when two-factor is turned on or off, a passkey is added or deleted, codes are regenerated, a recovery code is used to sign in, the password changes, and when the second step locks after wrong codes. The lock email means the password is known to someone, so it says to change it.
- **Wrong codes are capped at 100.** After 100 in a row, app codes stop working for 24 hours after the last wrong one, or until the user signs in with a passkey or a recovery code, or an admin resets two-factor. The 24-hour expiry keeps an owner with no other way in from being shut out for good, while guessing stays at about one try a day.
- **Admins get "Reset two-factor".** It removes the member's app, passkeys and codes, signs them out everywhere and emails them. It needs a fresh step-up. Only the owner can reset another admin; the owner uses `/recover`.
- **Passkey polish:**
  - Provider name from the AAGUID ("Apple Passwords", "Google Password Manager", "1Password", "YubiKey 5" …) becomes the default name, numbered when taken. The table (`shared/passkey-providers.ts`) is trimmed from the community list at github.com/passkeydeveloper/passkey-authenticator-aaguids, which exists for naming passkeys in settings. An AAGUID is self-reported, so it is used for display only. The passkey list shows the provider when the name doesn't.
  - The Signal API is used after a delete (`signalAllAcceptedCredentials` with the ids that remain) and on an unknown credential (`signalUnknownCredential` after `passkey_unknown`). Chrome 132+ and Safari 26+; elsewhere it does nothing, and a failure never blocks the delete or the error message.
  - A dismissible "Add a passkey" prompt appears under the top bar for a password-session user with no passkey, on a device with a fingerprint, face or PIN (`isUserVerifyingPlatformAuthenticatorAvailable`). It links to Settings → Passkeys, which does the step-up. "Not now" hides it in this browser for 30 days, per account (localStorage). It never adds a passkey by itself.
- **Trust this browser for 30 days** (added after the first round, at the owner's request). A box on the second step, off by default, like Google's "Don't ask again on this device" and Microsoft's "Don't ask again for 30 days". The browser gets a separate random token in an `HttpOnly`, `SameSite=Strict` `__Host-` cookie, stored as a hash. A password sign-in on it for the same account skips the second step until 30 days after it was ticked; using it does not extend that. The password is still checked, and such a session is not a second-factor proof, so changing factors from it still needs a passkey or code. It leaves the wrong-code count alone, so an owner signing in cannot reset it for someone guessing elsewhere. Settings lists trusted browsers with Forget. Signing a session out from Settings forgets the browser it ran in, the lost-laptop case. "Sign out all others", a password change, and removing the app or a passkey forget all but this one; a reset, `/recover`, disable, delete, admin reset and losing the last factor forget all.
- **Not doing now:** silent automatic passkey creation. It turns on two-factor without the user choosing to and needs registration without user verification. A second email address for notices is also left out.

**Effect on live users:** anyone on mailer.tapetide.com who has a passkey but no authenticator app will be asked for that passkey (or a recovery code) the next time they sign in with a password. Signing in with the passkey directly is unchanged. They will see a one-time "Save your recovery codes" prompt in Settings.
