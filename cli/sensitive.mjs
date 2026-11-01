// The file names a config backup refuses to keep. Its own file, with no imports, so cli/rules.mjs can use it without loading library.mjs.
// A file whose NAME says credentials is left out, whatever it holds. Case-insensitive, checked before the extension.
// It also catches harmless names (token-bucket.md); they are reported as skipped, which is the safe side.
export const SENSITIVE_FILE = /^\.env|\.pem$|\.key$|^id_rsa|credential|secret|token|password|api[-_ ]?keys?|service[-_ ]?account/i
