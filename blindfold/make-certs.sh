#!/usr/bin/env bash
# Build the private CA and the leaf certificate that blindfold.mjs presents.
#
# Windows: run this from Git Bash. The openssl that ships with Git for Windows works.
# macOS: /usr/bin/openssl is LibreSSL. Use only options that LibreSSL also has (it has no `x509 -ext`).
# The earlier attempt used PowerShell New-SelfSignedCertificate, whose leaf was refused
# with "unsuitable certificate purpose" because it carried no serverAuth extended key
# usage. The extension files below are what fix that, so do not drop them.
#
# Subjects come from a config file instead of -subj: Git Bash rewrites any argument
# that starts with a slash, so "/CN=..." would arrive as "C:/Program Files/Git/CN=...".
#
# Nothing here touches a system trust store. Codex trusts this CA through the
# CODEX_CA_CERTIFICATE environment variable, which the switcher exports for you.
set -euo pipefail

HOST="${1:-chatgpt.com}"
# The default must match the folder the gateway reads (state.mjs paths.blindfoldCA): an npm
# install keeps its data in ~/.llm-switcher, a git checkout next to the code.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${LLM_SWITCHER_BLINDFOLD_CERTS:-}" ]; then DEFAULT_OUT="$LLM_SWITCHER_BLINDFOLD_CERTS"
elif [ -n "${LLM_SWITCHER_HOME:-}" ]; then DEFAULT_OUT="$LLM_SWITCHER_HOME/blindfold/certs"
elif [ -d "$ROOT/.git" ]; then DEFAULT_OUT="$ROOT/blindfold/certs"
else DEFAULT_OUT="$HOME/.llm-switcher/blindfold/certs"; fi
OUT_DIR="${2:-$DEFAULT_OUT}"
CA_DAYS=3650
LEAF_DAYS=825

# Every file here is private, and the CA key signs for any host. A directory that another
# account created first (the /tmp recipe) could expose the key or hold planted symlinks.
umask 077
mkdir -p "$OUT_DIR"
OWNER="$(stat -c %u "$OUT_DIR" 2>/dev/null || stat -f %u "$OUT_DIR")"
if [ "$OWNER" != "$(id -u)" ]; then
  echo "[blindfold] refused: $OUT_DIR is owned by uid $OWNER, not by you. Use a directory you own." >&2
  exit 1
fi
chmod 700 "$OUT_DIR"

# Build in a private work directory and move the results into place last. A failed run then
# keeps the previous working set, and mv replaces a planted symlink instead of writing through it.
WORK="$(mktemp -d "$OUT_DIR/.build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "[blindfold] host   : $HOST"
echo "[blindfold] output : $OUT_DIR"

cat > "$WORK/ca.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca

[dn]
CN = LLM Switcher Local CA

[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
# Codex trusts this CA for every host. The constraint limits a leaked ca.key to HOST and its subdomains.
nameConstraints = critical,permitted;DNS:$HOST
EOF

cat > "$WORK/leaf.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn

[dn]
CN = $HOST
EOF

cat > "$WORK/leaf.ext" <<EOF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$HOST,DNS:*.$HOST
EOF

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/ca.key"
openssl req -x509 -new -key "$WORK/ca.key" -sha256 -days "$CA_DAYS" \
  -config "$WORK/ca.cnf" -out "$WORK/ca.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/leaf.key"
openssl req -new -key "$WORK/leaf.key" -config "$WORK/leaf.cnf" -out "$WORK/leaf.csr"
openssl x509 -req -in "$WORK/leaf.csr" \
  -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$WORK/leaf.ext" \
  -out "$WORK/leaf.pem"

mv -f "$WORK/ca.key" "$WORK/ca.pem" "$WORK/leaf.key" "$WORK/leaf.pem" "$OUT_DIR/"

echo "[blindfold] CA     : $OUT_DIR/ca.pem"
echo "[blindfold] leaf   : $OUT_DIR/leaf.pem"
openssl x509 -in "$OUT_DIR/leaf.pem" -noout -text | grep -A1 -E "Extended Key Usage|Subject Alternative Name"
