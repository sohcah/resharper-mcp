import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export const cacheDirectory = process.env.RESHARPER_MCP_CACHE_DIR ?? join(homedir(), '.cache', 'resharper-mcp');
export function platformId(platform = process.platform, arch = process.arch): string {
  const os = ({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Record<string, string>)[platform];
  if (!os || !['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  return `${os}-${arch}`;
}
export function archivePath(root: string, name: string): string {
  const target = resolve(root, name);
  if (name.includes('\\') || /^[a-z]:/i.test(name) || !target.startsWith(resolve(root) + sep)) throw new Error(`Unsafe archive entry: ${name}`);
  return target;
}
export async function extractZip(archive: string, destination: string): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => error ? fail(error) : ok(zip!)));
  await new Promise<void>((ok, fail) => {
    zip.on('error', fail); zip.on('end', ok);
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const path = archivePath(destination, entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0xf000) === 0xa000) throw new Error(`Archive symlink rejected: ${entry.fileName}`);
        if (entry.fileName.endsWith('/')) await mkdir(path, { recursive: true });
        else {
          await mkdir(dirname(path), { recursive: true });
          const stream = await new Promise<Readable>((ok, fail) => zip.openReadStream(entry, (error, stream) => error ? fail(error) : ok(stream!)));
          await pipeline(stream, createWriteStream(path));
          if (mode & 0o111) await chmod(path, 0o755);
        }
        zip.readEntry();
      })().catch(error => { zip.close(); fail(error); });
    });
    zip.readEntry();
  });
}
async function response(url: string) {
  const result = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!result.ok) throw new Error(`Download failed (${result.status}): ${url}`);
  return result;
}
async function download(url: string, path: string) {
  console.error(`Downloading ${url}`);
  const result = await response(url);
  if (!result.body) throw new Error('Download returned an empty body');
  await pipeline(Readable.fromWeb(result.body as never), createWriteStream(path));
}
async function verify(path: string, expected: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.trim().split(/\s+/)[0].toLowerCase()) throw new Error(`SHA-256 mismatch: ${path}`);
}
let installation: Promise<string> | undefined;
export function ensureBackend(): Promise<string> {
  return installation ??= install().catch(error => { installation = undefined; throw error; });
}
async function install(): Promise<string> {
  if (process.env.RESHARPER_MCP_BACKEND) { await access(process.env.RESHARPER_MCP_BACKEND); return resolve(process.env.RESHARPER_MCP_BACKEND); }
  const platform = platformId();
  const target = join(cacheDirectory, platform);
  const executable = join(target, 'backend', platform, process.platform === 'win32' ? 'JetBrains.VsCode.Backend.exe' : 'JetBrains.VsCode.Backend');
  try { await access(join(target, 'installation.json')); await access(executable); return executable; } catch { /* first boot */ }
  await mkdir(cacheDirectory, { recursive: true });
  const stage = await mkdtemp(join(cacheDirectory, '.install-'));
  try {
    const metadata = await (await response('https://open-vsx.org/api/JetBrains/resharper-code/latest')).json() as { version: string; files: { download: string; sha256: string } };
    await download(metadata.files.download, join(stage, 'extension.vsix'));
    await verify(join(stage, 'extension.vsix'), await (await response(metadata.files.sha256)).text());
    await extractZip(join(stage, 'extension.vsix'), join(stage, 'vsix'));
    const extension = join(stage, 'vsix', 'extension');
    const manifest = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8')) as { cdn: string; backendVersionTemplate: string };
    const [os, arch] = platform.split('-');
    const archive = manifest.backendVersionTemplate.replace('${os}', os).replace('${arch}', arch);
    if (!/^JetBrains\.VsCode\.Backend\.[\w.-]+\.zip$/.test(archive)) throw new Error('Unsupported backend archive name');
    const cdn = new URL(manifest.cdn);
    if (cdn.protocol !== 'https:' || cdn.hostname !== 'download.jetbrains.com') throw new Error('Unexpected backend CDN');
    await download(new URL(archive, cdn).href, join(stage, 'backend.zip'));
    await verify(join(stage, 'backend.zip'), await readFile(join(extension, 'digests', `${archive}.sha256`), 'utf8'));
    await extractZip(join(stage, 'backend.zip'), join(stage, 'backend'));
    const stagedExecutable = join(stage, 'backend', platform, process.platform === 'win32' ? 'JetBrains.VsCode.Backend.exe' : 'JetBrains.VsCode.Backend');
    await access(stagedExecutable);
    if (process.platform !== 'win32') await chmod(stagedExecutable, 0o755);
    await writeFile(join(stage, 'installation.json'), JSON.stringify({ version: metadata.version, archive }));
    await rm(join(stage, 'extension.vsix')); await rm(join(stage, 'backend.zip'));
    // Concurrent installers may finish first; keep their complete installation.
    try { await rename(stage, target); } catch (error) { await access(executable); await access(join(target, 'installation.json')); }
    return executable;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
