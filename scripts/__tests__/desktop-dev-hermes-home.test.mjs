import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DESKTOP_DEV_HERMES_HOME,
  resolveDesktopDevHermesHome,
} from '../shared/desktop-dev-hermes-home.mjs';

const HOME = path.join(os.tmpdir(), 'cindy-dev-hermes-home-fixture');
const CINDY_HOME = path.join(HOME, DEFAULT_DESKTOP_DEV_HERMES_HOME);

test('defaults to Cindy own home when the launcher exports nothing', () => {
  assert.equal(resolveDesktopDevHermesHome({}, HOME), CINDY_HOME);
  assert.equal(resolveDesktopDevHermesHome({ HERMES_HOME: '   ' }, HOME), CINDY_HOME);
});

test('never lets the daily Hermes home reach the dev app', () => {
  const daily = path.join(HOME, '.hermes');

  for (const configured of [daily, `${daily}${path.sep}`, path.join(daily, 'nested')]) {
    assert.equal(resolveDesktopDevHermesHome({ HERMES_HOME: configured }, HOME), CINDY_HOME);
  }
});

test('discards a non-daily home that only differs by case on a case-folding platform', () => {
  const caseOnly = path.join(HOME, '.HERMES');
  const expected =
    process.platform === 'darwin' || process.platform === 'win32' ? CINDY_HOME : caseOnly;

  assert.equal(resolveDesktopDevHermesHome({ HERMES_HOME: caseOnly }, HOME), expected);
});

test('keeps an explicit dedicated scratch home', () => {
  const scratch = path.join(os.tmpdir(), 'cindy-hermes-probe');

  assert.equal(resolveDesktopDevHermesHome({ HERMES_HOME: scratch }, HOME), scratch);
});

test('does not mutate the environment it reads', () => {
  const env = { HERMES_HOME: path.join(HOME, '.hermes') };
  resolveDesktopDevHermesHome(env, HOME);

  assert.equal(env.HERMES_HOME, path.join(HOME, '.hermes'));
});
