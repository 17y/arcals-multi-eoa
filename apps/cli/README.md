# EOA runner internals

The public entry point is `multi-eoa.mjs`. It uses the TypeScript package in
this directory as a library for manifest verification, RandomX work,
crash-recoverable SQLite operation journals and EOA transaction recovery.

The runner has no hosted-wallet adapter. Funding and Mint transactions are
signed by local EOA keys stored in owner-only files. See the repository
`README.md` for the supported workflow and safety boundaries.
