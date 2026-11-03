// Stand-in for `electron` in the portable tests. They import paths.ts and
// desktop-identity.ts, which read `app` at import time; this file only has to
// cover the fields those two touch.
export const app = {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0',
  getLocale: () => 'en',
}
