# Arcals test fixtures

`@arcals/test-fixtures` contains public, unsigned test vectors shared by the
protocol, SDK, CLI and RandomX tools:

- `golden`: protocol inputs, golden digests and invalid cases;
- `events`: contract event samples, including the ERC-4906 `MetadataUpdate`
  story;
- `api`: Work API response stories;
- `cli`: one `CliEnvelope` story per CLI command, plus the non-spending one-Mint
  Agent preview with its exact wallet, project value, Controller, Vault and
  Treasury destinations and authorization scope;
- `pi`: a short Pi prefix archive and sparse 20-level membership fixtures;
- `randomx`: the public Arcals RandomX salt vector;
- `manifests`: a local deployment manifest.

Fixtures contain no private keys or wallet signatures; any keys or signatures a
test needs are generated at runtime and never committed or printed. Every
fixture marked `local-fixture` is for tests only; its Pi roots and Targets are
not production dataset roots or production parameters.
