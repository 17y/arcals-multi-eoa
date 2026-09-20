import { keccak256, stringToHex } from "viem";

export const PROTOCOL_VERSION = 1;
export const MAX_ARCALS = 1_000_000n;
/** Public Mint issues IDs 1..990,000; the final 10,000 IDs are reserved. */
export const PUBLIC_MAX_ARCALS = 990_000n;
export const RESERVE_FIRST_ID = 990_001n;
export const RESERVE_COUNT = 10_000n;
export const PI_DIGITS_PER_ARCAL = 360;
export const PACKED_PI_BYTES = 180;
export const PI_TREE_HEIGHT = 20;
export const PI_TREE_LEAF_COUNT = 1 << PI_TREE_HEIGHT;

export const MINT_FEE_NATIVE = 100_000_000_000_000_000n;
export const UNIT = 360_000_000_000_000_000_000n;
export const ARCL_MAX = 360_000_000_000_000_000_000_000_000n;

/**
 * How far behind the head block a Challenge and its Work Certificate are dated.
 *
 * The controller rejects a Challenge whose `validAfter` is newer than the block
 * executing it, and a Certificate whose `issuedAt` is. The backend reads its
 * timestamps from the most current Arc node it knows, so an executing wallet
 * whose own node is even slightly behind would reject work that is perfectly
 * valid on chain. Dating both a margin into the past absorbs that difference.
 * It costs the Certificate the same margin of its life, which must stay well
 * clear of the window a client needs to send one.
 */
export const EXECUTOR_LAG_MARGIN_SECONDS = 120n;

export const EIP712_DOMAIN_NAME = "ArcalsMint";
export const EIP712_DOMAIN_VERSION = "1";

export const EIP712_DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
export const CHALLENGE_TYPE =
  "Challenge(uint32 protocolVersion,bytes32 configDigest,bytes32 challengeId,uint64 epochId,address minter,uint256 mintNonce,bytes32 challengeInput,uint256 mintFee,uint64 validAfter,uint64 expiresAt,uint64 signerVersion)";
export const WORK_CERTIFICATE_TYPE =
  "WorkCertificate(uint32 protocolVersion,bytes32 challengeHash,uint64 workNonce,bytes32 randomxHash,uint64 issuedAt,uint64 expiresAt,uint64 signerVersion)";
export const WORK_CONFIG_TYPE =
  "WorkConfigV1(uint32 protocolVersion,bytes32 algorithmId,bytes32 parameterDigest,uint64 epochSeconds,uint64 keyLeadSeconds,uint64 maxChallengeTtl,uint64 maxCertificateTtl,uint256 target,uint64 effectiveEpoch)";

export const EIP712_DOMAIN_TYPEHASH = keccak256(
  stringToHex(EIP712_DOMAIN_TYPE),
);
export const CHALLENGE_TYPEHASH = keccak256(stringToHex(CHALLENGE_TYPE));
export const WORK_CERTIFICATE_TYPEHASH = keccak256(
  stringToHex(WORK_CERTIFICATE_TYPE),
);
export const WORK_CONFIG_TYPEHASH = keccak256(stringToHex(WORK_CONFIG_TYPE));

export const CHALLENGE_DOMAIN = keccak256(stringToHex("ARCALS_WORK_INPUT_V1"));
export const EPOCH_KEY_DOMAIN = keccak256(
  stringToHex("ARCALS_RANDOMX_EPOCH_V1"),
);
export const RANDOMX_ALGORITHM_ID = keccak256(
  stringToHex("ARCALS_RANDOMX_V2_SALT_V1"),
);

export const UINT32_MAX = (1n << 32n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;
