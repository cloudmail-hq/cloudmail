# Upgrade, back up and uninstall

## Back up

Mailbox data lives in Durable Objects (one SQLite database per mailbox), not in
a database you can download directly. The export is the backup.

1. Sign in as an admin.
2. **Settings → Account & security → Your data → Export my data.**
3. The export runs in the background. When it is ready, download the zip:
   `account.json` (profile, sessions, token metadata, mailbox access and
   settings, never secrets) plus one `.mbox` file per mailbox. An admin's
   export contains every mailbox. The link works for 24 hours.

An `.mbox` opens in Thunderbird or Apple Mail and imports back into cloudmail
(Settings → Import), into Gmail, or into most other providers.

Export before every upgrade and on a regular schedule. Also keep, in a password
manager: `SETUP_TOKEN`, `AUTH_SECRET` (without it, 2FA secrets and the stored
Cloudflare token can't be decrypted) and your licence key.

## Upgrade

Releases are published on [cloudmail-hq/cloudmail](https://github.com/cloudmail-hq/cloudmail).
Read the release notes first: they say when a release changes `wrangler.jsonc`
(a new binding, Durable Object class or migration) or needs a manual step.

### If you deployed with the button

The button made a copy of the repository in your GitHub or GitLab account and
connected it to Workers Builds, so a push to that copy redeploys. To upgrade,
bring the new release into your copy and push.

Your copy's `wrangler.jsonc` is the one file that is yours: the deploy wrote
your resource ids and names into it. Keep it, and add only what the release
adds.

```bash
git clone <your copy's URL> cloudmail && cd cloudmail
git remote add upstream https://github.com/cloudmail-hq/cloudmail.git
git fetch upstream

cp wrangler.jsonc /tmp/wrangler.mine.jsonc
git rm -rq . && git checkout upstream/main -- .     # take the release as a whole
git diff --cached --stat                             # what changes
git diff HEAD upstream/main -- wrangler.jsonc        # what the release changed in the config
cp /tmp/wrangler.mine.jsonc wrangler.jsonc           # put yours back ...
# ... then copy into it any new bindings, vars, "durable_objects" entries and
# "migrations" entries from the diff above. Never remove or rename an existing
# migration tag or Durable Object class: that deletes mailbox data.

git add -A && git commit -m "Upgrade cloudmail to <version>"
git push
```

Workers Builds builds and deploys the push. Watch it under your Worker →
**Deployments** (or **Builds**).

### If you deploy from the command line

```bash
git fetch upstream && git merge upstream/main     # or the same steps as above
npm ci
npm run deploy
```

### What happens on the first request

Each mailbox's SQLite schema migrates itself the first time the new version
opens it, and the accounts database migrates on the first request. You don't
run anything. Migrations run forward only, in order.

### Check it

- Open the app, sign in, open a mailbox, send yourself a message.
- **Settings → Licence** still shows the licence as active.
- Worker → **Logs** shows no errors.

### Roll back

Dashboard → your Worker → **Deployments** → pick the previous version →
**Rollback**, or `npx wrangler rollback <version-id>`. Rolling back code is safe
for configuration and UI changes. If the release migrated data (the notes say
so), an older version may not understand the newer tables. Restore from your
export instead of rolling back across such a release, or ask on GitHub first.

## Uninstall

Do these in order. Deleting the Worker deletes every mailbox in it, and there
is no undo.

1. **Export** everything (see [Back up](#back-up)).
2. **Move your mail.** If the domain should keep receiving mail, set up the new
   provider and change the MX records to it, or point the Email Routing
   catch-all elsewhere: dashboard → your domain → **Email** → **Email Routing**
   → **Routing rules**. While the catch-all still points at a deleted Worker,
   mail to the domain is lost.
3. **Free the licence:** Settings → Licence → **Deactivate** (with the key), so
   you can use it on another deployment.
4. **Delete the Cloudflare resources** (dashboard, or with Wrangler):

   ```bash
   npx wrangler delete cloudmail                          # the Worker and its Durable Objects
   # R2 only deletes an empty bucket: first add a lifecycle rule that deletes
   # objects after 1 day (dashboard → R2 → cloudmail → Settings), or delete them
   # in the dashboard, then:
   npx wrangler r2 bucket delete cloudmail
   npx wrangler kv namespace list                                   # find the id of cloudmail-oauth-kv
   npx wrangler kv namespace delete --namespace-id <id>
   npx wrangler vectorize delete cloudmail-semantic --force
   ```

5. **Clean up DNS and sending** if you no longer use them: the DMARC record the
   setup added (`_dmarc`), the sending domain under **Email → Email Sending**
   (it removes its `cf-bounce` records), and Email Routing itself.
6. **Revoke the API token** you connected (My Profile → API Tokens), and delete
   your copy of the repository.
