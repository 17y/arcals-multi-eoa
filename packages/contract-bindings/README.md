# Arcals contract bindings

`@arcals/contract-bindings` provides the JSON ABI, typed `as const` exports and
a digest manifest for the Arcals contracts. The bindings are generated from
the compiled Solidity interfaces in
[`ArcalsCircle/arcals-contracts`](https://github.com/ArcalsCircle/arcals-contracts)
and are not edited by hand.

The interface surface covers the Mint and conversion actions, the Vault
`circulatingSupply()` view, and the complete ERC-4906 event surface used by the
Mirror.
