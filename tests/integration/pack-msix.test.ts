import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error -- plain ESM script, Node built-ins only (it runs in the release jobs that install nothing).
import { fillManifest, findSdkBin, packagePaths, parseArgs, priConfig, toolArgs } from '../../scripts/win/pack-msix.mjs';

// Release/win-unpacked + our manifest + logos,
// makepri, makeappx, and a signed copy for test installs. These are its pure parts; the packing itself runs on the PC
// and in the release's Windows jobs.
const root = join(__dirname, '../..');

test('arguments: --version and --out, --sign only with --password-env (a name, never the password itself)', () => {
  expect(parseArgs(['--version', '0.2.0-beta.15', '--out', 'release'])).toEqual({ version: '0.2.0-beta.15', out: 'release', sign: null, passwordEnv: null });
  expect(parseArgs(['--out', 'o', '--version', '0.2.0', '--sign', 'C:\\t\\test.pfx', '--password-env', 'PFX_PASSWORD']))
    .toEqual({ version: '0.2.0', out: 'o', sign: 'C:\\t\\test.pfx', passwordEnv: 'PFX_PASSWORD' });
  expect(() => parseArgs(['--out', 'o'])).toThrow(/--version/);
  expect(() => parseArgs(['--version', '0.2.0'])).toThrow(/--out/);
  expect(() => parseArgs(['--version', '0.2.0', '--out', 'o', '--sign', 'x.pfx'])).toThrow(/--password-env/);
  expect(() => parseArgs(['--version', '0.2.0', '--out', 'o', '--password-env', 'P'])).toThrow(/--sign/);
  expect(() => parseArgs(['--version', '0.2.0', '--out', 'o', '--sign', 'x.pfx', '--password-env', 'not a name'])).toThrow(/variable name/);
  expect(() => parseArgs(['--version', '0.2.0', '--out', 'o', '--dry'])).toThrow(/unknown argument --dry/);
  expect(() => parseArgs(['--version', '--out', 'o'])).toThrow(/--version/);
  // A bad version is refused before anything is staged.
  expect(() => parseArgs(['--version', '0.2.0-rc.1', '--out', 'o'])).toThrow(/X\.Y\.Z/);
});

test('package names: the Store upload and the signed test copy, named by the release version', () => {
  expect(packagePaths('C:\\out', '0.2.0-beta.15')).toEqual({
    msix: join('C:\\out', 'Atelier-0.2.0-beta.15-x64.msix'),
    test: join('C:\\out', 'Atelier-0.2.0-beta.15-x64-test.msix')
  });
});

test('manifest: the version filled in, everything else byte for byte', () => {
  const template = readFileSync(join(root, 'build/appx/AppxManifest.xml'), 'utf8');
  const filled = fillManifest(template, '0.2.15.0');
  expect(filled).toBe(template.replace('Version="__VERSION__"', 'Version="0.2.15.0"'));
  expect(filled).not.toContain('__VERSION__');
  expect(() => fillManifest('<Package/>', '0.2.15.0')).toThrow(/__VERSION__/);
  expect(() => fillManifest(template, '0.2.15')).toThrow(/four numbers/);
});

test('manifest: the Store identity, Windows 10 2004+, deferred updates, full trust, no alias, app id Atelier', () => {
  const m = readFileSync(join(root, 'build/appx/AppxManifest.xml'), 'utf8');
  expect(m).toContain('<Identity Name="FrancescoMusso.AtelierIDE" Publisher="CN=F5719CFD-083A-4791-AA97-9440062FF386" Version="__VERSION__" ProcessorArchitecture="x64" />');
  expect(m).toContain('<DisplayName>Atelier IDE</DisplayName>');
  expect(m).toContain('MinVersion="10.0.19041.0"');
  expect(m).toContain('<uap17:UpdateWhileInUse>defer</uap17:UpdateWhileInUse>');
  expect(m).toContain('<rescap:Capability Name="runFullTrust" />');
  expect(m).toMatch(/<Application Id="Atelier" Executable="Atelier\.exe" EntryPoint="Windows\.FullTrustApplication">/);
  expect(m).toMatch(/<uap:VisualElements DisplayName="Atelier"/);
  expect(m).not.toMatch(/uap10|AppExecutionAlias/);
});

// makepri names a resource by its path from the index root (startIndexAt rebases it: Files/X.png, which the manifest's
// assets\X.png never finds), so it indexes a project folder that holds only assets/, never Electron's own files.
test('makepri config: the whole project folder indexed from its root, file names as qualifiers, defaults scale-100 and targetsize-256', () => {
  const xml = priConfig();
  expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
  expect(xml).toContain('<index root="\\" startIndexAt="\\">');
  expect(xml).toContain('<indexer-config type="folder" foldernameAsQualifier="true" filenameAsQualifier="true" qualifierDelimiter="."/>');
  expect(xml).toContain('<qualifier name="Language" value="en-US"/>');
  expect(xml).toContain('<qualifier name="Scale" value="100"/>');
  expect(xml).toContain('<qualifier name="TargetSize" value="256"/>');
  // A single package: no split resource packages.
  expect(xml).not.toContain('autoResourcePackage');
});

test('SDK tools: the newest Windows Kits version with makepri, makeappx and signtool for x64', () => {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const have = new Set([
    ...['makepri.exe', 'makeappx.exe', 'signtool.exe'].map((t) => join(kits, '10.0.9600.0', 'x64', t)),
    ...['makepri.exe', 'makeappx.exe', 'signtool.exe'].map((t) => join(kits, '10.0.22621.0', 'x64', t)),
    // Newest by number, but without signtool: not complete.
    ...['makepri.exe', 'makeappx.exe'].map((t) => join(kits, '10.0.26100.0', 'x64', t))
  ]);
  const dirs = ['10.0.22621.0', '10.0.9600.0', '10.0.26100.0', 'x64', 'arm64'];
  // By number, not by string ("10.0.9600.0" sorts after "10.0.22621.0" as text).
  expect(findSdkBin(kits, dirs, (p: string) => have.has(p))).toBe(join(kits, '10.0.22621.0', 'x64'));
  expect(findSdkBin(kits, [], () => true)).toBeNull();
  expect(findSdkBin(kits, ['x64'], () => true)).toBeNull();
});

test('tool command lines: makepri, makeappx, signtool (the password from the named variable, SHA256)', () => {
  const t = toolArgs({ work: 'W', stage: 'W\\pkg', msix: 'O\\a.msix', test: 'O\\a-test.msix', pfx: 'C\\t.pfx', password: 'p@ss' });
  expect(t.makepri).toEqual(['new', '/pr', join('W', 'pri'), '/cf', join('W', 'priconfig.xml'), '/mn', join('W\\pkg', 'AppxManifest.xml'), '/of', join('W\\pkg', 'resources.pri'), '/o']);
  expect(t.makeappx).toEqual(['pack', '/o', '/d', 'W\\pkg', '/p', 'O\\a.msix']);
  expect(t.signtool).toEqual(['sign', '/fd', 'SHA256', '/f', 'C\\t.pfx', '/p', 'p@ss', 'O\\a-test.msix']);
});

test('test-cert.ps1: the throwaway certificate carries the manifest publisher, trusted in TrustedPeople, no key left behind', () => {
  const ps = readFileSync(join(root, 'scripts/win/test-cert.ps1'), 'utf8');
  const publisher = /Publisher="([^"]+)"/.exec(readFileSync(join(root, 'build/appx/AppxManifest.xml'), 'utf8'))![1];
  expect(ps).toContain(`$publisher = '${publisher}'`);
  expect(ps).toMatch(/param\(\[Parameter\(Mandatory\)\] \[string\] \$Out, \[Parameter\(Mandatory\)\] \[string\] \$PasswordEnv\)/);
  expect(ps).toContain('Cert:\\LocalMachine\\TrustedPeople');
  // -Path first: Windows PowerShell 5.1 binds the certificate provider's -DeleteKey only from an explicit path.
  expect(ps).toContain('Remove-Item -Path "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -DeleteKey -Force');
  // The sideload packer it replaces is gone (pack-msix.mjs --sign signs the test copy).
  expect(existsSync(join(root, 'scripts/win/pack-sideload.ps1'))).toBe(false);
});
