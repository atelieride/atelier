// The MSIX version of a release: four 16-bit numbers, the last 0 (the Store's rule), always
// increasing across betas and stables. X.Y.Z-beta.N → X.Y.(Z·1000+N).0, X.Y.Z → X.Y.(Z·1000+999).0: a flight only
// receives packages newer than the public one, and a stable outranks its betas. Windows shows this number in
// Settings › Apps; the app itself shows package.json's version.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

/** `0.2.0-beta.15` → `0.2.15.0`, `0.2.0` → `0.2.999.0`; throws for anything it can't map in order. */
export function msixVersion(version) {
  const m = typeof version === 'string' ? SEMVER.exec(version) : null;
  if (!m) throw new Error(`not a release version (X.Y.Z or X.Y.Z-beta.N): ${version}`);
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  const beta = m[4] === undefined ? null : Number(m[4]);
  if (major > 65535 || minor > 65535) throw new Error(`major and minor must be at most 65535: ${version}`);
  if (patch > 64) throw new Error(`patch must be at most 64 (Z·1000+999 fits in 16 bits): ${version}`);
  if (beta !== null && beta > 998) throw new Error(`beta number must be at most 998 (999 is the stable's): ${version}`);
  return `${major}.${minor}.${patch * 1000 + (beta ?? 999)}.0`;
}
