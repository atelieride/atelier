#!/bin/bash
# Creates the "Atelier Local" certificate in the login keychain, used to sign local Atelier builds.
# Why: with ad-hoc signing macOS identifies the app by its fingerprint, which changes on every build, and asks for
# permissions again (e.g. the Documents folder) after every update. With a fixed certificate the identity stays the same.
# For code signing only (no other use), valid for 10 years; the private key never leaves the keychain.
# Run it once, by hand: bash scripts/create-signing-cert.sh
# Trade-off: with -T /usr/bin/codesign (and "Always Allow") any process running as the user can sign
# with this key without prompting, and so build an app with Atelier's identity that inherits its permissions
# (e.g. Documents). Safer: a separate keychain with its own password, unlocked only during the build.
set -euo pipefail

NAME="Atelier Local"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "\"$NAME\" is already in the login keychain: nothing to do."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
O = Atelier (local builds)
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 3650 -config "$WORK/cert.cnf" 2>/dev/null
PASS=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" -out "$WORK/cert.p12" -passout "pass:$PASS"
# -T: codesign can use the key without asking every time.
security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null

echo "Created \"$NAME\" in the login keychain:"
security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME" || true
