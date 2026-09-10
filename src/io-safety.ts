import * as dns from 'node:dns';
import * as fs from 'node:fs';
import * as https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import * as path from 'node:path';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export class InputSafetyError extends Error {}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
// Restrict IPv6 to global unicast, excluding special/documentation ranges.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  if (isIP(address) === 6) {
    return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  }
  return false;
}

export function validatePublicImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new InputSafetyError('Invalid image URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') ||
      host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      (isIP(host) !== 0 && !isPublicAddress(host))) {
    throw new InputSafetyError('Reference URL must point to a public HTTPS image');
  }
  return url;
}

// Validate the SAME addresses the socket uses, rather than checking DNS and
// then allowing a second, potentially rebound lookup. Proxy/redirect bypasses
// are disabled on the downloader that owns this agent.
export function createPublicImageAgent(resolveHost: typeof dns.lookup = dns.lookup): https.Agent {
  const lookup: LookupFunction = (hostname, options, callback) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      callback(new Error('Image host lookup timed out'), '', 4);
    }, 5_000);
    resolveHost(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || !addresses?.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        callback(new Error('Image host is not a public address'), '', 4);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  return new https.Agent({ lookup, keepAlive: false });
}

export function imageMimeType(bytes: Buffer): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new InputSafetyError('Reference image exceeds the size limit or is empty');
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new InputSafetyError('Reference content is not a supported image');
}

function workspaceRoot(): string | undefined {
  const configured = process.env.NANOBANANA_WORKSPACE_ROOT;
  if (configured === undefined) return undefined; // Legacy installations explicitly retain host filesystem access.
  if (!configured.trim()) throw new InputSafetyError('NANOBANANA_WORKSPACE_ROOT must name an existing directory');
  try {
    const root = fs.realpathSync(path.resolve(configured));
    if (!fs.statSync(root).isDirectory()) throw new Error();
    return root;
  } catch { throw new InputSafetyError('NANOBANANA_WORKSPACE_ROOT must name an existing directory'); }
}
function requireInside(root: string | undefined, target: string): void {
  if (!root) return;
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InputSafetyError('File path is outside the configured workspace');
  }
}

export function readLocalImage(filePath: string): { bytes: Buffer; mimeType: string } {
  let fd: number | undefined;
  try {
    const root = workspaceRoot();
    const real = fs.realpathSync(path.resolve(root ?? process.cwd(), filePath));
    requireInside(root, real);
    if (!fs.statSync(real).isFile()) throw new InputSafetyError('Reference must be a regular image within the size limit');
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new InputSafetyError('Reference must be a regular image within the size limit');
    // Never read an unbounded file, including a file that grows after stat().
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length);
    return { bytes, mimeType: imageMimeType(bytes) };
  } catch (error) {
    if (error instanceof InputSafetyError) throw error;
    throw new InputSafetyError('Unable to read reference image');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function prepareOutputPath(filePath: string): string {
  try {
    const root = workspaceRoot();
    const target = path.resolve(root ?? process.cwd(), filePath);
    requireInside(root, target);
    let ancestor = path.dirname(target);
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new InputSafetyError('Invalid output directory');
      ancestor = parent;
    }
    requireInside(root, fs.realpathSync(ancestor));
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new InputSafetyError('Output must be a regular file');
      requireInside(root, fs.realpathSync(target));
      if (process.env.NANOBANANA_ALLOW_OVERWRITE !== '1') throw new InputSafetyError('Output already exists; choose a new filename');
    }
    return target;
  } catch (error) {
    if (error instanceof InputSafetyError) throw error;
    throw new InputSafetyError('Invalid output directory');
  }
}

export function writeOutputImage(filePath: string, bytes: Buffer): string {
  let fd: number | undefined;
  try {
    const target = prepareOutputPath(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Recheck newly created parents and use O_EXCL to avoid races with another
    // generation saving the same filename. This is an application guard, not an OS sandbox.
    prepareOutputPath(target);
    const overwrite = process.env.NANOBANANA_ALLOW_OVERWRITE === '1';
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT |
      (overwrite ? fs.constants.O_TRUNC : fs.constants.O_EXCL) | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(target, flags, 0o600);
    fs.writeFileSync(fd, bytes);
    return target;
  } catch (error) {
    if (error instanceof InputSafetyError) throw error;
    throw new InputSafetyError('Unable to save image; choose a writable new filename');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
