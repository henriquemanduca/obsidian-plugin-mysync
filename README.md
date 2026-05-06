# MySync

Basic Obsidian plugin scaffold for syncing with MySync.

## Development

This project expects Node.js 22.22 or newer.

```sh
npm install
npm run dev
```

`npm run dev` watches `src/main.ts` and emits the plugin files into `dist/` for Obsidian.

For a production build:

```sh
npm run build
```

## Manual Install During Development

Place this project directory in your vault under:

```text
VaultFolder/.obsidian/plugins/mysync
```

Then run `npm run dev`, copy the files from `dist/` into that plugin directory if needed, reload Obsidian, and enable the plugin from community plugin settings.
