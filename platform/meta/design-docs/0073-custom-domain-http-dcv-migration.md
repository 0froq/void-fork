---
title: Custom Domain HTTP Certificate Validation
status: implemented
---

# Custom domain HTTP certificate validation

Custom domains use HTTP certificate validation and a separate DNS ownership check. The user publishes a traffic CNAME and a per-host _cf-custom-hostname TXT value. The platform activates routing only after Cloudflare reports the hostname and certificate active and no ownership challenge remains. The certificate method itself is not the ownership proof. This prevents an unrelated wildcard CNAME from authorizing someone else to attach the hostname.

HTTP validation removes user-managed _acme-challenge records and lets Cloudflare renew certificates without new DNS tokens. Existing TXT-validated domains can still pass the method-independent activation gate. Pending registrations are cleaned up after seven days. The [domain routes](../../packages/api/src/routes/domains.ts), [Cloudflare API wrapper](../../packages/api/src/provisioning/cloudflare-api.ts), and [CLI reference](../../../docs/reference/cli.md) define the current flow.
