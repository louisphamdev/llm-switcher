// ============================================================
// ensure-ca-bundle.mjs — the shim's one call into Node (R2, R4)
//
// The shim must point NODE_EXTRA_CA_CERTS at a bundle holding BOTH the user's own CA and the
// switcher's ca.pem, so trusting the interceptor never costs the user a certificate they
// already had. Building that bundle means reading files, comparing content byte for byte and
// renaming atomically — none of which belongs in a shell script, and none at all in cmd.exe.
//
// It is a FILE rather than `node -e "..."` on purpose: cmd.exe re-parses quotes and reads %2
// inside a percent-encoded URL, so a space anywhere in the checkout path would corrupt the
// program or its arguments.
//
// argv: <inherited NODE_EXTRA_CA_CERTS> <switcher ca.pem> <state dir>
// stdout: the bundle path, and nothing else — the shim compares it against -f before exporting.
// exit 1 on any failure: the reason is already on stderr, and the shim then keeps the inherited
// value and exports no path to a file that does not exist.
// ============================================================

import { ensureClaudeCaBundle } from './state.mjs';

const [, , inheritedCa, switcherCaPath, stateDir] = process.argv;
const result = ensureClaudeCaBundle(inheritedCa, switcherCaPath, stateDir);

if (result && result.ok && result.path) {
  process.stdout.write(result.path);
  process.exit(0);
}
process.exit(1);
