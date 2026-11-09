import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
// @ts-expect-error: .mjs script without types
import { releaseMeta, wackReport } from '../../scripts/release-ci.mjs';

// The Windows side of scripts/release-ci.mjs: the MSIX's name, and the verdict on the
// Windows App Certification Kit's report in check-win.

test('release metadata names the MSIX next to the ZIP and the DMG (Atelier-<version>-x64.msix)', () => {
  expect(releaseMeta({ tag: 'v0.2.0-beta.15', pkgVersion: '0.2.0-beta.15', changelog: '## 0.2.0-beta.15\n- x\n' }).msix).toBe('Atelier-0.2.0-beta.15-x64.msix');
  expect(releaseMeta({ tag: 'v0.2.0', pkgVersion: '0.2.0', changelog: '## 0.2.0\n- x\n' }).msix).toBe('Atelier-0.2.0-x64.msix');
});

const wackTest = (index: number, name: string, result: string, optional?: boolean, message?: string) =>
  `      <TEST INDEX="${index}" NAME="${name}" DESCRIPTION="d"${optional === undefined ? '' : ` OPTIONAL="${optional ? 'TRUE' : 'FALSE'}"`} EXECUTIONTIME="00h:00m:01s.00ms">
        <RESULT><![CDATA[${result}]]></RESULT>
        <MESSAGES>${message ? `<MESSAGE TEXT="${message}" />` : ''}</MESSAGES>
      </TEST>`;

const report = (o: { overall?: string; partial?: string; version?: string; tests?: string[] } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<REPORT OVERALL_RESULT="${o.overall ?? 'PASS'}" VERSION="10.0.26100.1742" TOOLSET_ARCHITECTURE="x64" APP_TYPE="Desktop" PARTIAL_RUN="${o.partial ?? 'FALSE'}" LCID="1033" VALIDATION_TYPE="CommandLine" APP_NAME="FrancescoMusso.AtelierIDE" APP_VERSION="${o.version ?? '0.2.15.0'}">
  <REQUIREMENTS>
    <REQUIREMENT NUMBER="1" TITLE="Package compliance test" RATIONALE="r">
${(o.tests ?? [wackTest(1, 'App manifest', 'PASS', false), wackTest(2, 'Debug configuration', 'PASS', false)]).join('\n')}
    </REQUIREMENT>
  </REQUIREMENTS>
</REPORT>
`;

test('WACK: every required test passed → no problem; an optional failure is a warning (Blocked executables: the app starts shells)', () => {
  expect(wackReport(report(), { version: '0.2.0-beta.15' })).toMatchObject({ problems: [], warnings: [], tests: 2 });
  // What the test PC saw: overall WARNING, every required test PASS, the optional one failed.
  const r = wackReport(report({ overall: 'WARNING', tests: [wackTest(1, 'App manifest', 'PASS', false), wackTest(88, 'Blocked executables', 'FAIL', true, 'Uses cmd.exe')] }), { version: '0.2.0-beta.15' });
  expect(r.problems).toEqual([]);
  expect(r.warnings).toEqual([expect.stringMatching(/Blocked executables.*Uses cmd\.exe/)]);
});

test('WACK: the real report of the certified Store preview passes, Blocked executables a warning (APP_VERSION left empty)', () => {
  // appcert -packagefullname leaves APP_VERSION="" (found on the review, 2026-10-18): an empty one is not "another version".
  const xml = readFileSync(join(__dirname, '../fixtures/wack/store-preview-0.1.0.0.xml'));
  const r = wackReport(xml, { version: '0.2.0-beta.16' });
  expect(r).toMatchObject({ problems: [], tests: 24, overall: 'WARNING' });
  expect(r.warnings).toEqual([expect.stringMatching(/^Optional WACK test \[88\] Blocked executables failed/)]);
});

test('WACK: a required failure, an overall FAIL, a partial run, another version or no tests at all are problems', () => {
  const v = { version: '0.2.0-beta.15' };
  const failed = wackReport(report({ overall: 'FAIL', tests: [wackTest(1, 'App manifest', 'PASS'), wackTest(7, 'Supported API', 'FAIL', false, 'Bad API')] }), v);
  expect(failed.problems).toEqual(expect.arrayContaining([expect.stringMatching(/overall result FAIL/), expect.stringMatching(/\[7\] Supported API.*Bad API/)]));
  // A test without the OPTIONAL attribute counts as required.
  expect(wackReport(report({ overall: 'WARNING', tests: [wackTest(3, 'Something', 'FAIL')] }), v).problems).toEqual([expect.stringMatching(/\[3\] Something/)]);
  expect(wackReport(report({ partial: 'TRUE' }), v).problems).toEqual([expect.stringMatching(/partial/i)]);
  expect(wackReport(report({ version: '0.2.14.0' }), v).problems).toEqual([expect.stringMatching(/0\.2\.14\.0.*0\.2\.15\.0/)]);
  expect(wackReport(report({ tests: [] }), v).problems).toEqual([expect.stringMatching(/no test/i)]);
  expect(wackReport(report({ overall: 'MAYBE' }), v).problems).toEqual([expect.stringMatching(/MAYBE/)]);
  expect(wackReport('<html>nope</html>', v).problems).toEqual([expect.stringMatching(/not a WACK report/)]);
});

test('WACK: the report may be UTF-16 (with its byte order mark)', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(report(), 'utf16le')]);
  expect(wackReport(utf16, { version: '0.2.0-beta.15' })).toMatchObject({ problems: [], tests: 2 });
  expect(wackReport(Buffer.from(`﻿${report()}`, 'utf8'), { version: '0.2.0-beta.15' })).toMatchObject({ problems: [], tests: 2 });
});
