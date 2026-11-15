import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_BUNDLE_ID,
  APP_BUNDLE_NAME,
  APP_DISPLAY_NAME,
  buildDoctorAppAppleScript,
  buildDoctorAppBridgeScript,
  buildDoctorAppRunnerScript,
  installDoctorApp,
  resolveInstallDestinations,
} from '../install-doctor-app.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('resolveInstallDestinations defaults to Desktop and Applications and supports flags', () => {
  const fakeHome = '/tmp/cindy-home';
  const def = resolveInstallDestinations([], fakeHome);
  assert.deepEqual(def.destinations, [
    path.join(fakeHome, 'Desktop', APP_BUNDLE_NAME),
    path.join('/Applications', APP_BUNDLE_NAME),
  ]);

  const desktopOnly = resolveInstallDestinations(['--desktop-only'], fakeHome);
  assert.deepEqual(desktopOnly.destinations, [path.join(fakeHome, 'Desktop', APP_BUNDLE_NAME)]);

  const appsOnly = resolveInstallDestinations(['--applications-only'], fakeHome);
  assert.deepEqual(appsOnly.destinations, [path.join('/Applications', APP_BUNDLE_NAME)]);

  const customDir = resolveInstallDestinations(['--dest', '/tmp/custom-apps'], fakeHome);
  assert.deepEqual(customDir.destinations, [path.resolve('/tmp/custom-apps', APP_BUNDLE_NAME)]);

  const customApp = resolveInstallDestinations(['--dest=/tmp/MyDoctor.app'], fakeHome);
  assert.deepEqual(customApp.destinations, [path.resolve('/tmp/MyDoctor.app')]);

  assert.throws(
    () => resolveInstallDestinations(['--desktop-only', '--applications-only'], fakeHome),
    /mutually exclusive/,
  );
});

test('generated runner, bridge, and AppleScript preserve quoted repo root and safe preview contract', () => {
  const spacedRoot = '/Users/example/=ai space=/=Projects_Main=/Cindy';
  const runner = buildDoctorAppRunnerScript(spacedRoot);
  assert.match(runner, /\/opt\/homebrew\/opt\/node@22\/bin/);
  assert.match(runner, /export CINDY_DOCTOR_REPO_ROOT='\/Users\/example\/=ai space=\/=Projects_Main=\/Cindy'/);
  assert.match(runner, /v22\.\*/);

  const bridge = buildDoctorAppBridgeScript();
  assert.match(bridge, /scripts', 'cindy-doctor\.mjs/);
  assert.match(bridge, /pbcopy/);
  assert.match(bridge, /last-app-report\.txt/);

  const script = buildDoctorAppAppleScript();
  assert.match(script, /Run checks \(fast\)/);
  assert.match(script, /Create redacted incident bundle/);
  assert.match(script, /Apply a reversible fix\.\.\./);
  assert.match(script, /Confirm Fix — /);
});

test('installDoctorApp compiles a macOS .app bundle cleanly into a temp destination', { skip: process.platform !== 'darwin' }, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-doctor-app-test-'));
  try {
    const destApp = path.join(tmpDir, APP_BUNDLE_NAME);
    const res = installDoctorApp({ repoRoot: REPO_ROOT, destinations: [destApp] });
    assert.deepEqual(res.installed, [destApp]);

    const runnerPath = path.join(destApp, 'Contents', 'Resources', 'run-doctor-bridge.sh');
    const bridgePath = path.join(destApp, 'Contents', 'Resources', 'doctor-app-bridge.mjs');
    const plistPath = path.join(destApp, 'Contents', 'Info.plist');
    const iconPath = path.join(destApp, 'Contents', 'Resources', 'applet.icns');

    assert.equal(fs.existsSync(runnerPath), true);
    assert.equal(fs.existsSync(bridgePath), true);
    assert.equal(fs.existsSync(plistPath), true);
    assert.equal(fs.existsSync(iconPath), true);

    const bundleName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleName', plistPath], {
      encoding: 'utf8',
    }).trim();
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath], {
      encoding: 'utf8',
    }).trim();
    assert.equal(bundleName, APP_DISPLAY_NAME);
    assert.equal(bundleId, APP_BUNDLE_ID);

    // Exercise unknown bridge subcommand under minimal Finder PATH
    const unknownOut = spawnSync(runnerPath, ['unknown-cmd'], {
      env: { HOME: tmpDir, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      encoding: 'utf8',
    });
    assert.equal(unknownOut.status, 0);
    assert.match(unknownOut.stdout, /^Cindy Doctor — Error/m);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
