import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Only committed Git content enters a release. Unrelated working-tree edits and
// local secrets are never copied. No registry, push, deployment or tag promotion.
const root = resolve('.');
function run(command, args, { cwd = root, visible = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600000,
    maxBuffer: 16 * 1024 * 1024, stdio: visible ? 'inherit' : 'pipe' });
  assert.equal(result.status, 0, `Release operation failed: ${command}`);
  return result.stdout?.trim();
}
const ref = process.argv[2] || 'HEAD';
assert.match(ref, /^[a-zA-Z0-9_./-]+$/);
const commit = run('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
assert.match(commit, /^[a-f0-9]{40}$/);
const tree = run('git', ['rev-parse', `${commit}^{tree}`]);
const version = JSON.parse(run('git', ['show', `${commit}:package.json`])).version;
assert.match(version, process.argv.includes('--ci') ? /^\d+\.\d+\.\d+(?:-rc\.[1-9][0-9]*)?$/ : /^2\.0\.0-rc\.[1-9][0-9]*$/,
  'Only an explicitly committed release version is accepted.');
const destination = resolve('.tmp', 'releases', `${version}-${commit.slice(0, 12)}`);
assert.equal(existsSync(destination), false, 'Do not overwrite an existing candidate.');
mkdirSync(destination, { recursive: true });
const snapshot = join(destination, 'source'); mkdirSync(snapshot);
const archive = join(destination, 'source.tar');
run('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', `--output=${archive}`, commit]);
run('tar', ['-xf', archive, '-C', snapshot]);
const runtimeRoots = ['src/', 'scripts/', 'db/', 'panel/', 'portal/', 'public/'];
const files = run('git', ['ls-tree', '-r', '--name-only', commit]).split('\n')
  .filter((p) => runtimeRoots.some((dir) => p.startsWith(dir)) || ['package.json', 'package-lock.json', 'Dockerfile'].includes(p));
const hashes = Object.fromEntries(files.map((p) => [p, createHash('sha256').update(readFileSync(join(snapshot, p))).digest('hex')]));
const baseMetadata = JSON.parse(run('docker', ['image', 'inspect', 'node:22-alpine']))[0];
const base = baseMetadata.RepoDigests?.find((value) => /^node@sha256:[a-f0-9]{64}$/.test(value));
assert.ok(base, 'Pull and verify Node22 first; a floating base is refused for RC.');
const image = `waia:${version}-${commit.slice(0, 12)}`;
run('docker', ['build', '--target', 'release', '--build-arg', `NODE_IMAGE=${base}`,
  '--build-arg', `SOURCE_REVISION=${commit}`, '--build-arg', `RELEASE_VERSION=${version}`, '-t', image, '.'], { cwd: snapshot, visible: true });
const metadata = JSON.parse(run('docker', ['image', 'inspect', image]))[0];
assert.equal(metadata.Config.Labels['org.opencontainers.image.revision'], commit);
assert.equal(metadata.Config.Labels['org.opencontainers.image.version'], version);
assert.equal(metadata.Config.User, 'node');
const imageId = metadata.Id;
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
// Hash every copied runtime/asset file in the exact image, not in a validation
// image. Files absent in the release (including tests) fail this verification.
const verifier = `const fs=require('fs'),crypto=require('crypto');let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const m=JSON.parse(b);for(const [p,h]of Object.entries(m)){if(crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')!==h)throw Error('Source mismatch');}if(fs.existsSync('/app/test')||fs.existsSync('/app/.secrets'))throw Error('Unexpected private/test files');console.log(JSON.stringify({status:'passed',files:Object.keys(m).length,version:require('/app/package.json').version}));});`;
// Dockerfile itself is a build input, not a file copied into the release.
const copiedHashes = { ...hashes }; delete copiedHashes.Dockerfile;
const check = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', imageId, 'node', '-e', verifier], { input: JSON.stringify(copiedHashes), encoding: 'utf8', timeout: 120000 });
assert.equal(check.status, 0, 'Release source verification failed.');
const imageArchive = join(destination, 'waia-image.tar');
run('docker', ['image', 'save', '-o', imageArchive, imageId]);
const digest = createHash('sha256');
for await (const chunk of createReadStream(imageArchive)) digest.update(chunk);
const archiveSha256 = digest.digest('hex');
writeFileSync(join(destination, 'waia-image.tar.sha256'), `${archiveSha256}  waia-image.tar\n`);
// Reload the export and prove identity; no removal or replacement of other tags.
run('docker', ['image', 'load', '-i', imageArchive]);
assert.equal(JSON.parse(run('docker', ['image', 'inspect', imageId]))[0].Id, imageId);
const proof = { status: 'passed', version, commit, tree, image, imageId,
  // The modern local image store may populate RepoDigests during a local build.
  // None is proof of publication to a registry, which this tool never performs.
  registryDigest: null, localRepoDigests: metadata.RepoDigests || [], base, archiveSha256,
  files: hashes, copiedFiles: Object.keys(copiedHashes).length,
  exportedAndLoaded: true, registryPublished: false, createdAt: new Date().toISOString() };
writeFileSync(join(destination, 'manifest.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: proof.status, version, commit, imageId, registryDigest: proof.registryDigest,
  archiveSha256, copiedFiles: proof.copiedFiles, manifest: join(destination, 'manifest.json') }));
