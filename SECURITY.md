# Security

## Secrets

Do not commit or attach any of the following:

- Anthropic OAuth access or refresh tokens;
- `CLAUDE_CODE_DEVICE_ID` values;
- `CLAUDE_CODE_ACCOUNT_UUID` values;
- `CLAUDE_CODE_ATIS` or `x-cc-atis` values;
- intercepted request captures;
- extracted private prompts or local Claude state.

The package reads matching identity and ATIS values from Claude Code's local state in memory when available. It does not copy, log or persist them. Pi Black adds ATIS only to direct HTTPS requests for `api.anthropic.com`. The retained patch can also read explicit runtime environment values. CI never reads local Claude state, performs a live provider request, or requires provider secrets.

## Release verification

Every release contains `SHA256SUMS`. Verify an extracted download before use:

```sh
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256` if GNU `sha256sum` is unavailable. The standalone installer verifies its selected archive and launcher against this manifest. On later interactive starts, the launcher compares the installed archive digest with the latest release and verifies a downloaded installer before offering to apply it. Network or update failures do not block the installed binary.

The checksum manifest and assets are served by the same GitHub Release; checksums detect corruption but are not an independent signature. Release binaries are produced by Bun and are not Apple-notarized unless release notes explicitly state otherwise.

## Reporting

Use a private GitHub security advisory for vulnerabilities that could expose credentials or identifiers. Do not include live credentials or captures in reports.
