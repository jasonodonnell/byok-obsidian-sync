# BYOK Sync

Sync writing from your [Bring Your Own Keyboard](https://byok.io/device) (BYOK) device into your Obsidian vault.

When you run a sync with the BYOK connected in disk mode, the plugin finds the device and copies each project's documents into a folder in your vault. Each project becomes a subfolder, and each document becomes a note.

```
BYOK device                              Your vault
Projects/Foo/Bar.txt     ──▶             BYOK/Foo/Bar.md
```

## Usage

1. Install and enable **BYOK Sync**.
2. Connect your BYOK to your computer and put it in disk mode.
3. Run **BYOK Sync: Sync now** from the command palette, or select **Sync now** in the plugin's settings.
4. A notice shows how many notes were created or updated in the target folder (`BYOK` by default).

The plugin only syncs when you ask it to. It doesn't watch for the device or sync on startup.

## Settings

| Setting | Description |
| --- | --- |
| Target folder | Vault folder that projects are synced into. Defaults to `BYOK`. |
| Sync all projects | Turn off to pick which projects to sync. The list shows the projects found on your device. |
| Convert indentation | The BYOK saves each tab as spaces. When on, leading spaces are converted to match your editor's indentation settings (**Settings → Editor → Indent using tabs** and **Tab indent size**). |
| BYOK tab size | How many spaces the BYOK writes for one tab. Defaults to 5. |
| Note extension | Save documents as Markdown notes (`.md`) or plain text (`.txt`). |
| Mount path override | Full path to the mounted device, if automatic detection doesn't find it. |

## How syncing works

Sync is one-way, from the device to your vault. The plugin never writes to the device.

- New documents on the device are created as notes.
- If a document changed on the device and you haven't edited its note, the note is updated.
- If you edited the note in Obsidian and the document didn't change on the device, your edits are kept.
- If both changed, your note is kept and the device version is saved next to it as `Name (BYOK <date time>).md`.
- Deleting a document on the device doesn't delete its note.

## Device detection

The plugin looks for a mounted volume that contains a `Projects` folder and a `Sync/library.json` file, which is how the BYOK lays out its storage. It checks these locations:

- **macOS:** `/Volumes/*`
- **Linux:** `/media/<user>/*`, `/run/media/<user>/*`, and `/mnt/*`
- **Windows:** drive letters `D:` through `Z:`

If your device is mounted somewhere else, set **Mount path override**.

## Disclosures

- **Accesses files outside your vault.** To find and sync your device, this plugin lists mounted volumes in the locations above and reads files from the BYOK's `Projects` folder. It only reads from the device and never modifies it. This is required because the BYOK appears as a separate USB drive, outside your vault.
- **No network use.** The plugin doesn't make any network requests or collect any data.

## Requirements

Desktop only (macOS, Windows, Linux). The plugin uses Node.js file system APIs, which aren't available on mobile.

## Development

```sh
make install    # install dependencies
npm run dev     # watch and rebuild main.js
make build      # type-check and build for production
make lint
make deploy VAULT="/path/to/vault"   # build and install into a vault
```

### Releasing

Write the release notes in a Markdown file, then run:

```sh
make release VERSION=1.0.1 NOTES=notes.md
```

This checks that `main` is clean and in sync with `origin/main`. It then sets the version in `manifest.json`, `versions.json`, and `package.json`, lints and builds, commits, and pushes `main` along with an annotated `1.0.1` tag containing the notes. Pushing the tag runs the release workflow, which builds the plugin and publishes the GitHub release with `main.js` and `manifest.json` attached. If you leave out `NOTES`, the release notes are just "Release 1.0.1".

Don't create releases by hand on GitHub. If one already exists for the tag, the workflow attaches the files to it, but it doesn't update its notes.

## License

[MIT](LICENSE)
