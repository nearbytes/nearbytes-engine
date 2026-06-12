#!/usr/bin/env node
/**
 * When NEARBYTES_LOCAL_DEPS is set, point nearbytes-* deps at sibling ../ dirs
 * that exist; leave missing siblings on their github: specs from package.json.
 * No-op when unset (CI / production installs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const enabled =
  process.env.NEARBYTES_LOCAL_DEPS === '1' ||
  process.env.NEARBYTES_LOCAL_DEPS === 'true';

if (!enabled) {
  console.log('[local-deps] NEARBYTES_LOCAL_DEPS unset — using package.json specs');
  process.exit(0);
}

/** Package root — dev-bootstrap runs with cwd set here. */
const root = process.cwd();
const codeRoot = resolve(root, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const githubNearbytes = /^github:nearbytes\/([^#]+)/;
const httpsNearbytes = /github\.com\/nearbytes\/([^/.]+)/;

function isNearbytesGithubSpec(spec) {
  return typeof spec === 'string' && (githubNearbytes.test(spec) || httpsNearbytes.test(spec));
}

const targets = new Set();
for (const section of [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'resolutions',
]) {
  const deps = pkg[section];
  if (!deps || typeof deps !== 'object') continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (!name.startsWith('nearbytes-') || !isNearbytesGithubSpec(spec)) continue;
    targets.add(name);
  }
}

const toLink = [];
for (const name of targets) {
  const localDir = resolve(codeRoot, name);
  if (!existsSync(resolve(localDir, 'package.json'))) continue;
  const rel = relative(root, localDir);
  toLink.push(`${name}@file:${rel}`);
}

if (toLink.length === 0) {
  console.log('[local-deps] no sibling nearbytes-* repos found — using github specs');
  process.exit(0);
}

console.log(`[local-deps] linking ${toLink.length} package(s) from ${codeRoot}`);
const r = spawnSync('yarn', ['up', ...toLink], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
process.exit(r.status ?? 1);
