import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const destination = await mkdtemp(join(tmpdir(), 'tenantguard-release-pack-'));
const packages = [];
try {
  for (const name of await readdir(join(root, 'packages'))) {
    const manifestFile = join(root, 'packages', name, 'package.json');
    try {
      packages.push(JSON.parse(await readFile(manifestFile, 'utf8')));
    } catch {
      /* non-package directory */
    }
  }
  for (const manifest of packages) {
    execFileSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: join(root, 'packages', manifest.name.slice('@tenantguard/'.length)),
      stdio: 'pipe',
    });
  }
  const archives = (await readdir(destination)).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (archives.length !== packages.length)
    throw new Error(
      `Expected ${packages.length} archives, found ${archives.length}`,
    );
  for (const archive of archives) {
    const listing = execFileSync(
      'tar',
      ['-xOf', join(destination, archive), 'package/package.json'],
      { encoding: 'utf8' },
    );
    const packed = JSON.parse(listing);
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
    ])
      for (const [dependency, version] of Object.entries(packed[section] ?? {}))
        if (
          dependency.startsWith('@tenantguard/') &&
          String(version).startsWith('workspace:')
        )
          throw new Error(
            `${archive}: ${section}.${dependency} retained ${version}`,
          );
    if (!packed.files?.includes('dist'))
      throw new Error(`${archive}: dist is not included in publish files`);
  }
  console.log(
    JSON.stringify(
      {
        version: 1,
        packages: packages.length,
        archives: archives.length,
        status: 'packed-manifests-valid',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(destination, { recursive: true, force: true });
}
