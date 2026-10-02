# Security

## Secrets

Do not commit or attach any of the following:

- Anthropic OAuth access or refresh tokens;
- `CLAUDE_CODE_DEVICE_ID` values;
- `CLAUDE_CODE_ACCOUNT_UUID` values;
- `CLAUDE_CODE_ATIS` or `x-cc-atis` values;
- intercepted request captures;
- extracted private prompts or local Claude state.

The package reads matching identity and ATIS values from Claude Code's local state in memory when available. It does not copy, log or persist them. Pi Black adds ATIS only to direct HTTPS requests for `api.anthropic.com`. It also honours an explicit `CLAUDE_CODE_ATIS` runtime override. CI never reads local Claude state, performs a live provider request, or requires provider secrets.

`scripts/verify.sh` fails the build if it finds anything resembling a credential or private identifier in the tree.

## Reporting

Use a private GitHub security advisory for vulnerabilities that could expose credentials or identifiers. Do not include live credentials or captures in reports.
