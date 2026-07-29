# Admin write endpoint

Backs `../add.html` — the page that adds, edits, and deletes games without hand-editing
`games.json` through GitHub's web UI.

Until this is deployed and `WORKER` in `add.html` is filled in, that page just shows a
setup notice. Nothing else breaks by leaving it unconfigured — the main tracker
(`index.html`) doesn't depend on this Worker at all, it only ever reads `games.json`
directly.

## Why a Worker at all

The page can't commit to GitHub itself. Committing needs a token, and anything the page
holds is public (the site is a public static repo), so a token in the page means anyone
can push to it. The Worker holds the token as a server-side secret; the browser never
sees it. Same architecture as steph-tv-tracker's `worker/`.

## How it works

- `add.html` fetches `games.json` directly (same URL `index.html` uses) for its own
  reference — there's no `GET` route on this Worker, reads don't need it.
- Add/edit/delete all POST to this Worker. Each one reads the current file fresh, applies
  the change, and writes back with a sha check, retrying if the write is rejected — safe
  against racing `sync-games.yml`/`backfill-covers.yml`, which commit to this same file.
- Writes land on **`main`**, not a separate branch like steph-tv-tracker's `data` branch.
  That split exists there because marking an episode watched happens constantly; adding or
  editing a game here happens rarely enough that a Pages rebuild per edit isn't a real
  cost, and `main` means the edit is live immediately, nothing to merge first.
- Every write is a commit, so the restore path for anything — bug, bad edit, vandalism —
  is `git revert` or `git checkout` at any point in history.
- A successful **add** also dispatches `sync-games.yml` and `backfill-covers.yml`
  immediately, instead of leaving the new game to wait for their daily/weekly schedules.
  This is best-effort: if a dispatch fails (bad token scope, GitHub hiccup), the add still
  succeeds — the response just carries `triggers: [{workflow, ok, error?}, ...]` so
  `add.html` can show a soft warning instead of pretending both runs definitely fired.
  `edit`/`delete` never trigger this, only `add`.

## Setup

**1. Create a GitHub token.** github.com → Settings → Developer settings → Personal access
tokens → **Fine-grained tokens** → Generate new:
- Repository access: **Only select repositories** → `game-tracker`
- Permissions → Repository permissions → **Contents: Read and write**
- Permissions → Repository permissions → **Actions: Read and write** (needed to trigger
  `sync-games.yml`/`backfill-covers.yml` on add — GitHub's fine-grained token UI has no
  write-only tier, so pick "Read and write" here, not "Read-only", or dispatch will 403)
- Nothing else. This token can only touch this one repo's files and workflow runs.

**2. Deploy the Worker:**

```bash
cd worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # paste the token from step 1
npx wrangler secret put SYNC_KEY         # any random string, e.g. `openssl rand -hex 16`
npx wrangler deploy
```

Note the deployed URL, e.g. `https://game-tracker-admin.<subdomain>.workers.dev`.

**3. Point the pages at it.** In `../worker-config.js` (shared by `add.html` and
`index.html`'s edit mode, filled in once):

```js
const WORKER = { url: 'https://game-tracker-admin.<subdomain>.workers.dev', key: '<the SYNC_KEY>' };
```

Commit and push. `add.html`'s setup notice disappears and the form is live; `index.html`
gets an Edit mode toggle for drag-and-drop.

## About the sync key

It's in a public page, so it's public. It deters drive-by writes; it does not
authenticate anyone. The safety net is the git history — anything unwanted is one
`git revert` away.

## Tests

```bash
npm test        # index.test.mjs, no network or token needed
```

`index.test.mjs` stubs the GitHub contents API, so the read-modify-write path and its
conflict retry are covered offline.

## Restoring by hand

```bash
git log --oneline -- games.json     # every add/edit/delete/sync, in order
git show <sha>:games.json           # any past state
git revert <sha>                    # undo one specific change
```
