---
outline: deep
---

# Install a Void Platform

A Void platform lets your team deploy apps into a shared Cloudflare account. As an administrator, you install and maintain the platform. Developers connect the Void CLI to its URL, sign in through an enabled login method, and deploy their apps.

If you're deploying an app for yourself, [deploy directly to Cloudflare](/integrations/cloudflare#deploy-to-your-own-cloudflare-account). You don't need to install a platform first.

The core platform supports GitHub, Google, generic OIDC, and Cloudflare Access login, CLI deploys, D1, KV, R2, Queues, cron jobs, Workers AI, WebSockets, SSE, ISR, routing, logs, and rollback.

The core installation includes managed Sandboxes and an email gateway; email is enabled when you configure a shared mail domain and zone. The user dashboard, GitHub builds and webhooks, build Containers, and custom project domains aren't part of the core installation. Source-built platforms that add the optional GitHub services should follow the [isolated webhook ingress setup](/guide/platform/development/runtime#optional-github-webhook-ingress-for-access-protected-apis) when Access protects the API.

## Installation Guides

- [Prerequisites](/guide/platform/installation/prerequisites)
- [Credentials](/guide/platform/installation/credentials)
- [Install and Configure Login](/guide/platform/installation/setup)
- [First Deployment](/guide/platform/installation/first-deployment)
- [Domains and Resources](/guide/platform/installation/domains)
- [Maintenance and Recovery](/guide/platform/installation/maintenance)
- [Install from CI](/guide/platform/installation/ci)
- [Disable and Uninstall](/guide/platform/installation/uninstall)

<details>
<summary>All topics</summary>

- <span id="prerequisites"></span>[Before You Start](/guide/platform/installation/prerequisites#prerequisites)
- <span id="_1-prepare-your-cloudflare-account-and-domain"></span>[Prepare Your Cloudflare Account and Domain](/guide/platform/installation/prerequisites#prepare-your-cloudflare-account-and-domain)
- <span id="preview-the-installation"></span>[Install the CLI and Preview](/guide/platform/installation/prerequisites#preview-the-installation)
- <span id="platform-database"></span>[Create the Platform Database](/guide/platform/installation/prerequisites#platform-database)
- <span id="_4-prepare-credentials"></span>[Credentials](/guide/platform/installation/credentials)
- <span id="runtime-token-permissions"></span>[Cloudflare API Tokens](/guide/platform/installation/credentials#runtime-token-permissions)
- <span id="r2-upload-credentials"></span>[R2 Upload Credentials](/guide/platform/installation/credentials#r2-upload-credentials)
- <span id="signing-and-encryption-keys"></span>[Signing and Encryption Keys](/guide/platform/installation/credentials#signing-and-encryption-keys)
- <span id="install"></span>[Install and Configure Login](/guide/platform/installation/setup#install)
- <span id="configure-github-oauth"></span>[Choose login methods](/guide/platform/installation/setup#configure-github-oauth)
- <span id="connect-and-deploy-an-app"></span>[First Deployment](/guide/platform/installation/first-deployment#connect-and-deploy-an-app)
- <span id="managing-access"></span>[Managing Access](/guide/platform/installation/first-deployment#managing-access)
- <span id="add-a-domain-later"></span>[Adding a Domain](/guide/platform/installation/domains#adding-a-domain)
- <span id="what-changes-in-testing-mode"></span>[What Changes in Testing Mode?](/guide/platform/installation/domains#what-changes-in-testing-mode)
- <span id="other-domain-options"></span>[Other Domain Options](/guide/platform/installation/domains#other-domain-options)
- <span id="using-a-nested-application-domain"></span>[Using a Nested Application Domain](/guide/platform/installation/domains#using-a-nested-application-domain)
- <span id="cloudflare-footprint"></span>[Cloudflare footprint](/guide/platform/installation/domains#cloudflare-footprint)
- <span id="resume-repair-recover-and-upgrade"></span>[Resume, repair, recover, and upgrade](/guide/platform/installation/maintenance#resume-repair-recover-and-upgrade)
- <span id="resume-an-installation"></span>[Resume an installation](/guide/platform/installation/maintenance#resume-an-installation)
- <span id="cloudflare-access"></span>[Cloudflare Access blocks the health check](/guide/platform/installation/maintenance#cloudflare-access)
- <span id="expired-administrator-setup-code"></span>[Expired administrator setup code](/guide/platform/installation/maintenance#expired-administrator-setup-code)
- <span id="repair-missing-resources"></span>[Repair missing resources](/guide/platform/installation/maintenance#repair-missing-resources)
- <span id="upgrade-the-platform"></span>[Upgrade the platform](/guide/platform/installation/maintenance#upgrade-the-platform)
- <span id="manage-an-installation-from-another-machine"></span>[Manage an installation from another machine](/guide/platform/installation/maintenance#manage-an-installation-from-another-machine)
- <span id="prepare-for-disaster-recovery"></span>[Prepare for disaster recovery](/guide/platform/installation/maintenance#prepare-for-disaster-recovery)
- <span id="where-local-state-lives"></span>[Where local state lives](/guide/platform/installation/maintenance#where-local-state-lives)
- <span id="install-from-ci"></span>[Install from CI](/guide/platform/installation/ci#install-from-ci)
- <span id="continuously-deploy-a-source-build"></span>[Customize the Platform](/guide/platform/installation/ci#continuously-deploy-a-source-build)
- <span id="disable-and-safely-uninstall"></span>[Disable and Uninstall](/guide/platform/installation/uninstall)
- <span id="uninstall"></span>[Uninstall](/guide/platform/installation/uninstall#uninstall)

</details>
