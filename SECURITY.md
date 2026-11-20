# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem.

- Use **Report a vulnerability** on this repository's [Security tab](https://github.com/cloudmail-hq/cloudmail/security/advisories/new), or
- email **security@trycloudmail.com**.

Include what you found, how to reproduce it, and the version (the commit or
release) you tested. Never include real tokens, keys or other people's mail.

We acknowledge reports within three working days, keep you updated while we
fix it, and credit you in the release notes if you want.

## Supported versions

Security fixes go into the latest 1.x release. Upgrade with
[docs/upgrade.md](docs/upgrade.md).

## Scope

In scope: this repository's code as deployed by the Deploy to Cloudflare
button or `npm run deploy`. Out of scope: Cloudflare's own platform (report to
[Cloudflare](https://www.cloudflare.com/disclosure/)), and deployments whose
operators changed the code or configuration in a way that causes the issue.

How cloudmail protects accounts and mail is described in
[docs/reference.md](docs/reference.md#security-model). Operators handling an
incident can follow [docs/security/breach-runbook.md](docs/security/breach-runbook.md).
