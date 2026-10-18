# Journal domain route

Target: `https://christopherli.dev/journal/` without leaving the personal domain.
The public site remains on GitHub Pages. The Worker supports both its existing
root address and the `/journal/` mount. Assets and API requests resolve relative
to that mount; authentication and the current database/password are unchanged.

## Active state

- Cloudflare zone: `f9f4663f2c9a415c689bed42271f0eac`, Free Website plan, active.
- Production Worker route: `christopherli.dev/*`, declared in `wrangler.jsonc`.
  `/journal/` serves the private app. Other paths fetch the existing GitHub Pages
  origin after removing the journal session cookie; unrelated cookies are retained.
- `/journal` redirects to `/journal/` on the same host, preserving its query.
- Public paths, including `/journalism`, pass through to the GitHub Pages origin.
- The GitHub Pages `journal/index.html` redirect remains a migration fallback;
  the active Cloudflare route supersedes it for clients using the new DNS.
- Nameservers assigned by Cloudflare: `carter.ns.cloudflare.com` and
  `nucum.ns.cloudflare.com`.
- With the owner's explicit approval, Squarespace saved the two Cloudflare
  nameservers on October 18, 2026 at 12:25 a.m. America/Los_Angeles. Its dashboard
  confirmed the update. The previous delegation was `ns-cloud-e1.googledomains.com`
  through `ns-cloud-e4.googledomains.com`.
- The registry now delegates to the assigned Cloudflare nameservers. Cloudflare
  activated the zone and issued an Active Universal SSL certificate before the
  five website records were switched to Proxied. `_domainconnect` and the GitHub
  verification TXT record remain DNS-only.

## DNS review

The complete Squarespace DNS list was reviewed on October 18, 2026. Cloudflare's
scan found six records; the existing GitHub Pages verification TXT record was
also copied unchanged. All seven records are preserved:

| Name | Type | Target | Active proxy status |
| --- | --- | --- | --- |
| @ | A | 185.199.108.153 | On |
| @ | A | 185.199.109.153 | On |
| @ | A | 185.199.110.153 | On |
| @ | A | 185.199.111.153 | On |
| www | CNAME | christopherlii.github.io | On |
| _domainconnect | CNAME | _domainconnect.domains.squarespace.com | Off |
| _github-pages-challenge-christopherlii | TXT | Existing GitHub verification value, copied unchanged | Off |

All seven records stayed DNS-only during the nameserver migration, so visitors
continued directly to GitHub Pages until the Cloudflare certificate became
Active. The five web records are now proxied; both metadata records remain
DNS-only. This followed Cloudflare's
[Universal SSL migration guidance](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl/).

Public lookups found no apex MX, TXT, AAAA, CAA, or DS records. The full registrar
list contains the seven records above and no mail records. Bot Preference Sync was disabled during
onboarding to preserve the existing robots.txt. Full (strict) origin TLS is configured and verified in the dashboard; GitHub
Pages already has a valid certificate for the personal domain.

## Activation sequence

1. Verify the complete existing DNS list in Squarespace Domains and preserve
   any additional records before proceeding.
2. Verify all records remain DNS-only and origin TLS is Full (strict). The
   zone must have an active edge certificate before proxying.
3. Completed with the owner's approval: replace the four Google Domains nameservers in
   Squarespace with the two assigned Cloudflare nameservers. No registrar
   transfer or paid Cloudflare plan is required.
4. Wait for Cloudflare activation and an Active Universal SSL certificate, then
   enable the five web-record proxies. Check the public homepage,
   writing, favorites, and www redirect; then verify `/journal/` remains on the
   personal domain, renders its assets, and rejects anonymous private API reads.
5. Sign in once on the new host. Its host-only cookie is separate from the old
   workers.dev cookie; the same password and seven-day session duration apply.

## Verification

The native route was verified through the active Cloudflare edge with normal
TLS hostname/certificate validation. `/journal` returns a same-host 308 with its
query preserved; `/journal/` returns the journal HTML without changing host.
JavaScript, CSS, and both fonts return 200. Anonymous session state is ready but
unauthenticated; thought reads, individual reading links, drafts, and export
return 401. The homepage and www canonical redirect still return the existing
public site, and the public writing source exposes the one published snapshot.

Some local DNS caches still held the previous GitHub Pages addresses during
verification. Fresh authoritative/1.1.1.1 lookups returned Cloudflare addresses;
normal cached clients can use the existing fallback until their DNS expires.
The workers.dev journal also remains available.

Public passthrough uses the standard Workers
[route-to-origin fetch behavior](https://developers.cloudflare.com/workers/configuration/routing/routes/).
Tests verify that the journal cookie is removed before this fetch, while
unrelated cookies and public responses are preserved.
