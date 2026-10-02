# Pi Black

Use your Claude Max (or Pro) subscription with Pi.

Pi Black is an unofficial Pi package that routes Anthropic OAuth requests through your existing Claude subscription usage by applying Claude Code 2.1.287 request conventions.

## Install

Pi Black has three independently versioned compatibility surfaces:

| Component | Compatible version |
| --- | --- |
| Pi package | Pi 1.0.0 or newer |
| Claude Code protocol | 2.1.287 |

The Pi package requires Pi 1.0.0 or newer, with no upper version limit. Future Pi releases are trusted until an incompatibility is identified; the package peer dependencies are `"*"` because Pi supplies its core packages at runtime.

Pi Black is a Pi extension only. The earlier standalone native build and its patch series have been removed; see [Migrating from the patch series](#migrating-from-the-patch-series).

```sh
pi install git:github.com/aliceisjustplaying/pi-black
```

Pi checks unpinned Git packages for updates in the background. When a newer Pi Black commit is available, Pi displays a package-update notice; apply it with:

```sh
pi update --extensions
```

For a reproducible install, pin a release tag:

```sh
pi install git:github.com/aliceisjustplaying/pi-black@v0.1.0
```

Pinned packages do not move automatically. Install a newer tagged ref explicitly when you are ready to upgrade.

Then use Pi's normal Anthropic login:

```text
/login anthropic
```

The package replaces only the built-in Anthropic provider implementation and only transforms OAuth-token requests. It preserves Pi's credential storage, OAuth refresh, model behavior, tools, retries, streaming, and usage accounting. API-key requests and non-Anthropic providers pass through unchanged.

## Claude Code state discovery

No identity environment variables are required. When Claude Code state exists, Pi Black reads the installation ID, account UUID and newest model-specific ATIS assignment from `~/.claude.json` (or the location selected by `CLAUDE_CONFIG_DIR`) in memory. It does not copy, print or persist those values.

The ATIS assignment is latched per model ID on the first OAuth request for that model, because assignments are model-specific. Pi Black adds `x-cc-atis` only to direct HTTPS requests for `api.anthropic.com`; it never adds the header to custom base URLs. Set `CLAUDE_CODE_ATIS` only when an explicit in-memory override is needed.

Pi Black also adds Claude Code's verified model identity and knowledge-cutoff context for Fable 5.1 (June 2026), Opus 5 (May 2026), Opus 5.5 (June 2026), Sonnet 5 (January 2026) and Sonnet 5.5 (June 2026). It omits model context when the exact Claude Code metadata has not been verified.

Subscription routing can still work when optional identity metadata is unavailable. If no matching ATIS assignment exists, Pi Black omits the header rather than forwarding an assignment for a different model.

## What it changes

For Anthropic OAuth requests, Pi Black reproduces the version-specific SDK-CLI request shape:

- exact billing and Agent SDK system-block ordering;
- the prompt-dependent `cc_version` suffix;
- structure-aware `cch` calculation using seeded XXH64;
- per-request `x-client-request-id` values;
- Claude Code session headers, including the latched `x-cc-atis` assignment for first-party requests;
- verified model identity and knowledge-cutoff context for Fable 5.1, Opus 5, Opus 5.5, Sonnet 5 and Sonnet 5.5;
- automatically discovered identity metadata when available.

The checksum implementation validates and updates only the first billing system block. User content, tool results, descriptions, and nested `model` or `max_tokens` fields cannot redirect the placeholder patch.

## Verify the package

```sh
npm ci --ignore-scripts
npm run check
```

Public CI uses fake transports only. It never makes provider requests and requires no credentials.

## Migrating from the patch series

Pi Black used to ship two surfaces: the Pi package, and a patch series under `patches/` that rewrote `packages/ai/src/api/anthropic-claude-code.ts` inside Pi's own source to build a standalone native binary.

The patch series duplicated every behavior the package already implemented in `src/`, and it stopped tracking it. At removal it still declared Claude Code protocol `2.1.277` against the package's `2.1.287`, and still carried a process-wide ATIS latch that suppressed `x-cc-atis` for one model whenever a model with no assignment made the first request. Every fix had to be written twice, and the second copy silently drifted.

It is removed along with `install.sh`, `launcher.sh`, `config/pi.env`, `BUILD.md`, `RELEASE.md` and the standalone release workflow. There is no standalone binary to install. Use the package:

```sh
pi install git:github.com/aliceisjustplaying/pi-black
```

If you previously installed a `pi-black` binary through `install.sh`, remove it and install the package instead. Your Claude Code login is untouched; `/login anthropic` still applies.

## Status and terms

This project is unofficial and is not affiliated with or endorsed by Anthropic or the upstream Pi project. Users must provide their own valid account credentials and determine whether use complies with applicable service terms. The compatibility mechanism is version-specific and must be revalidated when Claude Code or Pi changes.

No OAuth tokens, identifiers, captures, or private Claude state are included in the package. Pi Black is distributed under the MIT license; see [`LICENSE`](LICENSE).
