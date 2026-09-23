#!/usr/bin/env bash
# Build the private CA and the leaf certificate that blindfold.mjs presents.
#
# Windows: run this from Git Bash. The openssl that ships with Git for Windows works.
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
OUT_DIR="${2:-$(cd "$(dirname "$0")" && pwd)/certs}"
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
( cd "$OUT_DIR" && rm -f ca.cnf leaf.cnf leaf.ext ca.key ca.pem leaf.key leaf.csr leaf.pem ca.srl )

echo "[blindfold] host   : $HOST"
echo "[blindfold] output : $OUT_DIR"

cat > "$OUT_DIR/ca.cnf" <<EOF
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
EOF

cat > "$OUT_DIR/leaf.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn

[dn]
CN = $HOST
EOF

cat > "$OUT_DIR/leaf.ext" <<EOF
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:$HOST,DNS:*.$HOST
EOF

openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_DIR/ca.key"
openssl req -x509 -new -key "$OUT_DIR/ca.key" -sha256 -days "$CA_DAYS" \
  -config "$OUT_DIR/ca.cnf" -out "$OUT_DIR/ca.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$OUT_DIR/leaf.key"
openssl req -new -key "$OUT_DIR/leaf.key" -config "$OUT_DIR/leaf.cnf" -out "$OUT_DIR/leaf.csr"
openssl x509 -req -in "$OUT_DIR/leaf.csr" \
  -CA "$OUT_DIR/ca.pem" -CAkey "$OUT_DIR/ca.key" -CAcreateserial \
  -days "$LEAF_DAYS" -sha256 -extfile "$OUT_DIR/leaf.ext" \
  -out "$OUT_DIR/leaf.pem"

rm -f "$OUT_DIR/leaf.csr" "$OUT_DIR/ca.cnf" "$OUT_DIR/leaf.cnf" "$OUT_DIR/leaf.ext" "$OUT_DIR/ca.srl"
chmod 600 "$OUT_DIR"/*.key 2>/dev/null || true

echo "[blindfold] CA     : $OUT_DIR/ca.pem"
echo "[blindfold] leaf   : $OUT_DIR/leaf.pem"
openssl x509 -in "$OUT_DIR/leaf.pem" -noout -ext extendedKeyUsage,subjectAltName
