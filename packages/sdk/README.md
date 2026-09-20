# Arcals SDK

`@arcals/sdk` provides wallet-independent building blocks for Arcals clients:

- pure transaction builders for Mint, NFT/ARCL approval, liquify, reform and
  related protocol calls, plus read-model freshness helpers;
- `ArcalsWorkApiClient`, a schema-validating Work API client with wallet
  authentication sessions, typed API errors, queued job inspection,
  operation/transaction association, and typed config, Mint and Vault reads;
- the shared `WalletAdapter` interface with discriminated transaction,
  provider-operation and user-operation handles, capability evidence,
  policy-configuration requests, simulation and fee types.

The SDK never owns a wallet secret and never retries `submitCall`
automatically. Wallet implementations live in the
[Arcals CLI](../../apps/cli/README.md); they journal a request ID and any
prepared transaction hash and nonce before the first broadcast attempt.
