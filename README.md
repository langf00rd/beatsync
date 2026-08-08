# beatsync

beatsync is a desktop app for backing up Beat screenplay projects to the cloud. It watches a local folder for screenplay files, syncs changes automatically, and keeps your work protected with end-to-end encryption.

## features

- secure sign-in and account creation
- automatic local folder watching for screenplay files
- cloud backup and restore for screenplay projects
- end-to-end encryption for protected file handling
- desktop app experience with a custom app icon and polished UI

## requirements

- node.js 20+
- a Supabase project with a URL and anonymous key

## setup

1. clone the repository
2. install dependencies:
   ```bash
   npm install
   ```
3. create a `.env` file based on `.env.example` and add your Supabase values:
   ```bash
   cp .env.example .env
   ```
4. start the app:
   ```bash
   npm start
   ```

## development

run the app in development mode:

```bash
npm run dev
```

## build

build desktop app packages:

```bash
npm run build
```

## notes

- the app will prompt you to choose a local sync directory the first time you start watching a folder.
- sync support is designed for all screenplay file formats.
