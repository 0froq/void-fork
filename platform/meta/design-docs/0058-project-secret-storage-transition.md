---
title: Project Secret Storage Transition
status: implemented
---

# Project secret storage

The platform stores project secrets as encrypted records in PostgreSQL, keyed by project and secret name. The API lists names without returning plaintext values. Secret values are decrypted only when needed for a deployment and are included as Worker secret bindings in the versioned script upload; request handling reads the Worker binding rather than the platform database.

This source of truth lets a new deployment receive the project's existing secrets without reading them back from a previous Worker. Auth-enabled projects can persist BETTER_AUTH_SECRET in the same store. Encryption uses an installation keyring with versioned keys so retained records can be decrypted during key rotation and recovery.

The implementation is in [project secret cryptography](../../../platform/packages/api/src/project-secrets.ts), [secret routes](../../../platform/packages/api/src/routes/secrets.ts), and [deployment assembly](../../../platform/packages/api/src/routes/deploy.ts).
