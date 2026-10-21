# 1n9 OCR

Read documents, check them against your rules, keep the ones that pass, and get a LINE alert for the ones that don't. It runs on top of the same 1n9 central engine that powers the 1n9 chatbot.

1. **Upload** images (JPG, PNG, WEBP) or PDFs. Scanned pages and tables are read by AI.
2. Each document is **checked by code against your rules**: the fields it must contain, and a minimum confidence for what was read. No AI writes a verdict.
3. A document that passes is saved as a record (and can be approved automatically). One that doesn't waits for a person to **review, correct and approve** it, and you get a **LINE message** with the file name and the names of the fields that have problems.

Original files are not kept. Only the text that was read and the fields are stored, on your machine. **Final decisions stay with people.**

The UI is available in English, ไทย, 日本語 and 中文 (switch at the top right) and works on phones and tablets.

## How it fits together

```
browser ──▶ 1n9 OCR (this repo, your machine) ──▶ 1n9 central (reads the document)
                   │                                     │
                   └── data/node.db (settings,           └── your AI provider (BYOK)
                       rules, results)
```

- This app is thin. Reading the document runs on central, using the AI key you provide (BYOK). Central stores nothing.
- No vector database and no embedding model are needed. One AI model that can read images is enough.
- The app only calls out to central and to LINE. No inbound port or public IP is needed.

## Run with Docker

```bash
cp .env.example .env     # set CENTRAL_URL, LICENSE_KEY, NODE_PASSWORD
docker compose up -d --build
```

Open http://127.0.0.1:8083. The first-run setup asks for your license and your AI connection. Then:

- **Rules**: list the fields a document must contain, set a minimum confidence, and choose whether documents that pass are approved automatically. You can keep several rule sets and pick one per upload.
- **Settings → LINE alerts**: enter a LINE Official Account channel access token and the receivers' IDs (users or groups) one at a time with an optional name, up to 10, then press **Send a test**. Receivers are added and removed immediately. The page has a short step-by-step guide.
  - Create a LINE Official Account and enable Messaging API. In the LINE Developers console, issue a long-lived *Channel access token*.
  - Everyone who should get alerts must add the Official Account as a friend first.
  - A user ID (starts with `U`, 32 characters after it) is shown under *Basic settings → Your user ID*. A group ID (starts with `C`) arrives through the channel's webhook when someone writes in the group.
  - The Official Account ID that starts with `@` is only for searching and adding friends. It cannot send messages.

To open it to other machines on your network, set `NODE_BIND=0.0.0.0`. Always set `NODE_PASSWORD`, because the documents you read can be confidential.

Data lives in the `ocr-data` volume. Back up `node.db` and `secret.key` together.

## Run on this machine without Docker

```bash
./run-local.sh        # Windows: .\run-local.ps1
```

Needs Python 3.11+ and Node.js 20+.

## Use the results somewhere else

The records are yours. Read them however suits you:

- **CSV**: `GET /api/docs/export.csv`
- **JSON**: `GET /api/docs` (list) and `GET /api/docs/{id}` (one record with all fields and the full text)
- **Database**: `data/node.db` is SQLite. The `docs` table has one JSON document per row.

Both endpoints use the same login as the web page (Basic Auth with `NODE_USER` / `NODE_PASSWORD`).

## License

One license = one installed system. If the same key is used on a second installation, the most recent one wins and the other disconnects.

The code in this repository is released under the MIT License, see [LICENSE](LICENSE). Using it with the 1n9 AI service still requires a valid license key.

The "1n9 AI" name and logo are trademarks of the owner and are not covered by the MIT License. If you redistribute or modify the code, use your own name and logo.

## Develop

```bash
pip install -r requirements.txt
uvicorn app:app --reload --port 8080          # backend
cd frontend && npm install && npm run dev     # UI on :3000 (set NEXT_PUBLIC_API_URL=http://127.0.0.1:8080)
```

All UI text lives in `frontend/locales/{en,th,ja,zh}.json`. `npm run build` fails if a component contains hard-coded Thai/CJK text or if a language is missing a key. Server errors return `{code, message, params}`, and the UI translates `errors.<code>`.
