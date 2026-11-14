// Clears browser state left behind by features that were removed (the rupee shop's worn mask and
// Hestu forest skin). Loaded by every page that loads korok.js, BEFORE it: korok.js still knows how
// to paint a skin named in localStorage `korok:all:skin` (it can't be edited from this repo, and
// Steph's TV log loads it live too), so the way to retire a skin is to make sure the key is gone
// before korok.js reads it. Safe to run every load: a missing key is a no-op, and a blocked
// localStorage is ignored. The Korok Forest toggle itself (`korok:all:forest`) is untouched.
(function () {
  try {
    localStorage.removeItem('korok:all:skin');
    localStorage.removeItem('gt_mask');
  } catch (e) {}
})();
