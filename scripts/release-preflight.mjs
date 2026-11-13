import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve('.');
const failures = [];
const requiredFiles = [
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'docs/compatibility.md',
  'docs/release-checklist.md',
];
for (const file of requiredFiles)
  if (!existsSync(join(root, file)))
    failures.push(`missing required release file: ${file}`);
const packageDirs = (
  await readdir(join(root, 'packages'), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const names = new Set();
for (const directory of packageDirs) {
  const file = join(root, 'packages', directory, 'package.json');
  if (!existsSync(file)) continue;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^@tenantguard\/[a-z0-9-]+$/.test(manifest.name))
    failures.push(`${directory}: invalid package name`);
  if (names.has(manifest.name))
    failures.push(`${directory}: duplicate package name`);
  names.add(manifest.name);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
    failures.push(`${manifest.name}: version must be semver before publishing`);
  if (manifest.private)
    failures.push(`${manifest.name}: package must not be private`);
  if (manifest.engines?.node !== '>=22.16.0')
    failures.push(`${manifest.name}: Node engine must be >=22.16.0`);
  if (!manifest.files?.includes('dist'))
    failures.push(`${manifest.name}: publish files must include dist`);
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ]) {
    for (const [dependency, version] of Object.entries(
      manifest[section] ?? {},
    )) {
      if (
        dependency.startsWith('@tenantguard/') &&
        !/^workspace:\^\d+\.\d+\.\d+$/.test(version)
      )
        failures.push(
          `${manifest.name}: ${section}.${dependency} must use workspace:^<release-version> for deterministic packing`,
        );
    }
  }
}
if (!existsSync(join(root, 'LICENSE')))
  failures.push('LICENSE is required before publication');
if (failures.length) {
  console.error(failures.map((value) => `- ${value}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        version: 1,
        packages: names.size,
        node: process.version,
        status: 'ready-for-versioning-and-credentialed-release',
      },
      null,
      2,
    ),
  );
}
