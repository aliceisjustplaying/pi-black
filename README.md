# Pi Black

Use your Claude subscription with Pi.

## Requirements

- Pi 1.0.0 or newer
- A Claude subscription (Max or Pro)

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-black
```

Then log in:

```text
/login anthropic
```

## Update

```sh
pi update --extensions
```

To pin a version, install a tag instead of the branch:

```sh
pi install git:github.com/aliceisjustplaying/pi-black@v1.0.0
```

## Development

```sh
npm ci --ignore-scripts
npm run check
```

## Notes

This project is unofficial and is not affiliated with or endorsed by Anthropic
or the Pi project. You supply your own account credentials and are responsible
for whether your use complies with the applicable terms.

MIT licensed.