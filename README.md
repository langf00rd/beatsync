# beatsync

beatsync is a desktop app for backing up Beat screenplay projects to the cloud. It watches a local folder for screenplay files, syncs changes automatically, and keeps your work protected with end-to-end encryption.

## screenshots
<img width="1281" height="953" alt="Screenshot 2026-08-09 at 4 33 23 PM" src="https://github.com/user-attachments/assets/0af3fb68-15ba-4f08-a0bc-c14fc65e605c" />
<img width="1211" height="1039" alt="Screenshot 2026-08-09 at 4 33 39 PM" src="https://github.com/user-attachments/assets/23ae5bfd-df07-4c60-8f8e-92e40860b765" />
<img width="432" height="217" alt="Screenshot 2026-08-09 at 4 34 00 PM" src="https://github.com/user-attachments/assets/3139d504-31ba-458b-a455-177db3734e17" />
<img width="1288" height="943" alt="Screenshot 2026-08-09 at 4 33 09 PM" src="https://github.com/user-attachments/assets/6665e2c9-2656-4b8b-89b2-fd4e0a6c503e" />


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
