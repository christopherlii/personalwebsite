# Journal domain route

Target: `https://christopherli.dev/journal/` without leaving the personal domain.
The public site remains on GitHub Pages. The Worker supports both its existing
root address and the `/journal/` mount. Assets and API requests resolve relative
to that mount; authentication and the current database/password are unchanged.

## Prepared state

- Cloudflare zone: `f9f4663f2c9a415c689bed42271f0eac`, Free Website plan, pending activation.
- Production Worker route: `christopherli.dev/journal*`, declared in `wrangler.jsonc`.
- `/journal` redirects to `/journal/` on the same host, preserving its query.
- Paths such as `/journalism` pass through to the existing GitHub Pages origin.
- The GitHub Pages `journal/index.html` redirect remains a migration fallback;
  the Cloudflare route supersedes it after activation.
- Nameservers assigned by Cloudflare: `carter.ns.cloudflare.com` and
  `nucum.ns.cloudflare.com`.
- Existing delegation remains `ns-cloud-e1.googledomains.com` through
  `ns-cloud-e4.googledomains.com` until the registrar is updated.

## DNS review

Cloudflare scanned six existing records. Preserve these targets:

| Name | Type | Target | Proxy after certificate activation |
| --- | --- | --- | --- |
| @ | A | 185.199.108.153 | On |
| @ | A | 185.199.109.153 | On |
| @ | A | 185.199.110.153 | On |
| @ | A | 185.199.111.153 | On |
| www | CNAME | christopherlii.github.io | On |
| _domainconnect | CNAME | _domainconnect.domains.squarespace.com | Off |

All six records are staged as DNS-only during the nameserver migration, so
visitors continue directly to GitHub Pages while Cloudflare issues its edge
certificate. Turn on the five web records only after that certificate is Active;
keep `_domainconnect` DNS-only. This follows Cloudflare's
[Universal SSL migration guidance](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/).

Public lookups found no apex MX, TXT, AAAA, CAA, or DS records. This is not a
complete inventory of possible custom subdomains: compare the full registrar
DNS list before switching nameservers. Bot Preference Sync was disabled during
onboarding to preserve the existing robots.txt. Full (strict) origin TLS is configured and verified in the dashboard; GitHub
Pages already has a valid certificate for the personal domain.

## Activation

1. Verify the complete existing DNS list in Squarespace Domains and preserve
   any additional records before proceeding.
2. Verify all records remain DNS-only and origin TLS is Full (strict). The
   pending zone does not yet have an active edge certificate.
3. With the owner's approval, replace the four Google Domains nameservers in
   Squarespace with the two assigned Cloudflare nameservers. No registrar
   transfer or paid Cloudflare plan is required.
4. Wait for Cloudflare activation and an Active Universal SSL certificate, then
   enable the five web-record proxies. Check the public homepage,
   writing, favorites, and www redirect; then verify `/journal/` remains on the
   personal domain, renders its assets, and rejects anonymous private API reads.
5. Sign in once on the new host. Its host-only cookie is separate from the old
   workers.dev cookie; the same password and seven-day session duration apply.

Until delegation and TLS are verified, do not describe the personal-domain
mount as active. The existing workers.dev journal remains available.
