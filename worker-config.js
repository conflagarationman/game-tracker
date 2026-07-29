// Shared by add.html and index.html so the Worker URL/key only need to be filled in once,
// in one committed file, instead of duplicated per page. Ships empty on purpose — both
// pages check for this being unconfigured and disable their write features harmlessly
// until it's filled in. See worker/README.md for deployment steps.
//
// This key is committed to a public repo, so it's public — same model as
// steph-tv-tracker's SYNC_KEY. It deters drive-by writes, it does not authenticate anyone.
// The real safety net is git history: every write is a commit, so anything unwanted is one
// `git revert` away.
const WORKER = {
  url: 'https://game-tracker-admin.jonny-wilczynski.workers.dev',
  key: '0d463ff6987e6bb655092bfd89a8f4d3',
};
