# Arcals RandomX worker

The worker pins RandomX v2.0.1 at
`aaafe71322df6602c21a5c72937ac284724ae561` as a clean Git submodule. The
result-affecting Arcals fork is the two-line
[`0001-arcals-argon-salt.patch`](patches/0001-arcals-argon-salt.patch), which
changes `RANDOMX_ARGON_SALT` from upstream `RandomX\x03` to
`Arcals-RandomX-v1` in the C/C++ and Windows assembly configurations. The build
copies the pinned source into ignored output and applies the patch there; it
never edits the submodule.

## Commands

From the repository root:

```text
pnpm randomx:build
pnpm randomx:check
```

`randomx:build` compiles the patched worker. `randomx:check` runs all 107
unmodified upstream tests and the upstream vector probe, builds the patched
worker, and then runs `tools/benchmark/src/integration.ts`, which checks:

- the 40-byte `challengeInput || nonceLE64` input byte-for-byte;
- Arcals salt output against the public fixture;
- Fast/JIT, Fast/interpreter, Light/JIT and Light/interpreter agreement;
- big-endian Target equality and one-below rejection;
- invalid algorithm and invalid input rejection;
- asynchronous search cancellation after real work;
- two cached Epoch contexts and clean process restart.

Fast is the mining mode. Light exists for explicit verification and
cross-checking; the CLI must never silently downgrade a user from Fast because
memory is unavailable. JIT, hardware AES and large pages are result-neutral
optimizations. Requested large pages fall back explicitly and the response
reports what was actually used.

## JSONL protocol

stdin accepts one bounded flat JSON object per line; stdout returns one JSON
object per line. stderr is reserved for process diagnostics. The maximum input
line is 64 KiB. Unknown commands, fields, algorithms, malformed hex and invalid
ranges fail closed.

Required common fields:

```text
protocolVersion = 1
jobId            = caller correlation ID
command          = prepare | hash | search | cancel | status
```

`prepare` requires the frozen `algorithmId`, a 32-byte `epochKey`, a 32-byte
`parameterDigest`, and explicit `fast|light` mode. Optional settings are JIT,
hardware AES, large pages, secure JIT and Dataset initialization threads.
Contexts are keyed by `epochKey + parameterDigest`; at most two are retained.

`hash` accepts exactly 40 raw input bytes. `search` accepts a 32-byte
challengeInput, 32-byte big-endian Target, decimal uint64 startNonce/stride,
maxHashes and thread count. Thread `k` searches `startNonce+k` and increments by
the thread count. Search runs asynchronously and emits `started`, `progress`,
then `solution`, `exhausted`, `cancelled` or `error`. `cancel` targets the active
job ID without blocking stdin.

No wallet key, signer, shell command, URL or arbitrary executable path enters
this protocol.

## Resources

Before allocating, Linux builds read `MemAvailable`; Fast preparation requires
room for Cache, the 2,181,038,016-byte Dataset and a safety margin. Responses
include actual Dataset size, available memory, resident memory and large-page
fallback state. One Fast context uses about 2.45 GB RSS and two use about
4.90 GB.

The release manifest in `release/manifest.json` records `algorithmId`,
`parameterDigest`, the upstream commit, the patch hash and the public vectors.
A local benchmark measures only the machine it runs on and is not a protocol
Target.

## Platform builds

Compiled workers differ per platform and toolchain, so users do not build their
own trusted worker. An Agent manifest lists one trusted build per platform
under `worker.platforms` (published keys `linux-x64`, `linux-arm64`,
`darwin-arm64`, `win32-x64`), each with `binarySha256` and an HTTPS
`binaryUrl`. The CLI selects the entry for
`${process.platform}-${process.arch}` and stops with
`WORKER_PLATFORM_UNSUPPORTED` when none exists. Intel macOS is not published.

The CLI downloads the selected build into `~/.arcals/workers/<sha256>/`, checks
the bytes against `binarySha256` before making them executable, and ignores any
local build. Release binaries are GitHub Release assets of
`ArcalsCircle/arcals-agent`, produced by the repository's public
`Release RandomX worker` GitHub Actions workflow. The workflow builds
from the pinned source and runs the upstream suite, the vector probe and the
Arcals vectors on each platform before publishing the binary and its hash. A
platform hash enters a manifest only from such a release build, never by
editing a manifest at runtime.

Apple Developer ID signing and notarization are not used or needed. The CLI
downloads the worker without the browser quarantine attribute and trusts it
only through the manifest SHA-256; the linker's ad-hoc signature satisfies
Apple Silicon's code-signing requirement.

On Apple Silicon the JIT must use `RANDOMX_FLAG_SECURE` (W^X). The Arcals
worker always requests it, and the upstream vector probe adds it on
`__APPLE__ && __aarch64__`, which avoids a SIGBUS in the probe. Secure JIT does
not change hashes.
