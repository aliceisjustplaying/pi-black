# Pi Black

Use your Claude Max (or Pro) subscription with Pi.

Pi Black is an unofficial Pi extension that makes Anthropic OAuth requests look
like Claude Code's, so your existing subscription covers Pi usage.

## Requirements

| Surface | Version |
| --- | --- |
| Pi | 1.0.0 or newer |
| Claude Code protocol | 2.1.287 |

Pi Black follows Pi releases until an incompatibility is identified; its peer
dependencies are `"*"` because Pi supplies its own core packages at runtime.

The protocol version is the part that moves. Every Claude Code release can
change the request conventions Pi Black reproduces, so a Pi Black release tracks
one specific Claude Code version rather than a range. Bump it deliberately.

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-black
```

Then log in with Pi's normal Anthropic flow:

```text
/login anthropic
```

Pi checks unpinned Git packages for updates in the background and shows an
update notice; apply it with `pi update --extensions`.

To pin a version:

```sh
pi install git:github.com/aliceisjustplaying/pi-black@v1.0.0
```

Pinned installs do not move on their own.

## What it does

For Anthropic OAuth requests, Pi Black reproduces Claude Code's SDK-CLI request
shape:

- billing and Agent SDK system blocks, in Claude Code's order;
- the prompt-dependent `cc_version` suffix;
- the `cch` body checksum, computed with seeded XXH64;
- a fresh `x-client-request-id` per request;
- Claude Code session headers, including the `x-cc-atis` assignment for
  first-party requests;
- model identity and knowledge-cutoff context, where the metadata is verified.

It replaces only the built-in Anthropic provider, and only for OAuth-token
requests. Credential storage, token refresh, tools, retries, streaming, usage
accounting and every other provider are untouched. API-key requests pass
through unmodified.

## Claude Code state

Pi Black reads three things from `~/.claude.json` (or `CLAUDE_CONFIG_DIR`), in
memory only: the installation ID, the account UUID, and the newest ATIS
assignment matching the model in use. It does not copy, print or persist them,
and `SECURITY.md` records what must never appear in a commit.

ATIS assignments are per-model, so Pi Black resolves one per model ID on that
model's first OAuth request. An earlier version latched a single assignment for
the whole process, which silently dropped the header for every model after one
that had no assignment.

`x-cc-atis` is only ever sent to `https://api.anthropic.com`. Requests to a
custom base URL never carry it. `CLAUDE_CODE_ATIS` overrides discovery in memory
for one process if you need to.

If no assignment matches the model, the header is omitted rather than sending
another model's assignment.

## Limits worth knowing

- **The checksum is verified, the wire is not.** `xxHash64` is tested against
  the reference implementation across three seeds, and the `cc_version`
  fingerprint is derived the same way Claude Code derives it. Nothing in CI
  contacts Anthropic, so "matches Claude Code" means "matches Claude Code's
  implementation", not "accepted by the API".
- **A redirect could carry the ATIS header.** The first-party check covers the
  request's initial URL. A cross-origin redirect from Anthropic would forward
  it. No such redirect has been observed.
- **Model context is only added where verified.** Unknown models get no
  identity or cutoff text rather than a guess.
- **The feedback command can decline.** Payloads over 8 MiB are refused rather
  than truncated, matching Claude Code. A session with very large error
  metadata can hit this.

## Development

```sh
npm ci --ignore-scripts
npm run check          # tsc --noEmit && vitest --run
./scripts/verify.sh    # the above, plus a credential scan
```

CI runs the same checks plus a compatibility pass. Everything uses fake
transports; no test makes a provider request or needs credentials.

Known gaps are tracked in [`TODO.md`](TODO.md).

## Migrating from the patch series

Pi Black used to also ship a patch series under `patches/` that rewrote Pi's own
`packages/ai/src/api/anthropic-claude-code.ts` to build a standalone binary.

That series duplicated everything the package implements, and drifted: at
removal it still declared protocol `2.1.277` against the package's `2.1.287`,
and still carried the single-assignment ATIS latch described above. Every fix
had to be written twice and the second copy went stale.

It and the standalone installer are gone. If you installed a `pi-black` binary,
remove it and use `pi install` above. Your Claude Code login is unaffected.

## Status

Unofficial, and not affiliated with or endorsed by Anthropic or the Pi project.
You supply your own account credentials and are responsible for whether your
use complies with the applicable terms.

The compatibility mechanism is version-specific by nature. Treat a Claude Code
or Pi update as something to re-check Pi Black against.

MIT licensed; see [`LICENSE`](LICENSE).