import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPublicAddress, validatePublicImageUrl, createPublicImageAgent, readLocalImage, prepareOutputPath, writeOutputImage, imageMimeType, MAX_IMAGE_BYTES } from '../dist/io-safety.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
test('image URLs exclude private networks, credentials and alternate transports', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8','2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://example.com/a.png','https://localhost/a','https://127.1/a','https://[::1]/a','https://user:pass@example.com/a','https://example.com:8443/a']) assert.throws(() => validatePublicImageUrl(url));
  assert.equal(validatePublicImageUrl('https://example.com/a.png').hostname, 'example.com');
});
test('DNS validates and pins the exact socket addresses; mixed private results fail', async () => {
  const lookup = async (addresses, all) => {
    const agent = createPublicImageAgent((_host, options, cb) => {
      assert.equal(options.all, true);
      cb(null, addresses);
    });
    try { return await new Promise((resolve, reject) => agent.options.lookup('example.com', { all }, (err, result) => err ? reject(err) : resolve(result))); }
    finally { agent.destroy(); }
  };
  const addresses = [{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}];
  assert.deepEqual(await lookup(addresses, true), addresses);
  assert.equal(await lookup(addresses, false), '8.8.8.8');
  await assert.rejects(lookup([...addresses,{address:'127.0.0.1',family:4}], true));
});
test('workspace reads/writes enforce containment, image signatures and no clobber', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-safety-'));
  const oldRoot = process.env.NANOBANANA_WORKSPACE_ROOT;
  const oldOverwrite = process.env.NANOBANANA_ALLOW_OVERWRITE;
  try {
    const root = path.join(temp,'workspace'); fs.mkdirSync(root);
    process.env.NANOBANANA_WORKSPACE_ROOT = root;
    process.env.NANOBANANA_ALLOW_OVERWRITE = '0';
    fs.writeFileSync(path.join(root,'input.png'),png);
    fs.writeFileSync(path.join(temp,'outside.png'),png);
    fs.writeFileSync(path.join(root,'fake.png'),'private text');
    assert.equal(readLocalImage('input.png').mimeType,'image/png');
    assert.throws(() => readLocalImage('../outside.png'), /outside/);
    assert.throws(() => readLocalImage('fake.png'), /supported image/);
    assert.throws(() => imageMimeType(Buffer.alloc(MAX_IMAGE_BYTES+1)), /size limit/);
    assert.throws(() => prepareOutputPath('../output.png'), /outside/);
    const output = writeOutputImage('generated/new.png',png);
    assert.deepEqual(fs.readFileSync(output),png);
    assert.throws(() => prepareOutputPath('generated/new.png'), /already exists/);
    assert.throws(() => writeOutputImage('generated/new.png',Buffer.from('overwrite')), /already exists/);
    assert.deepEqual(fs.readFileSync(output),png);
    fs.symlinkSync(temp,path.join(root,'escape'),process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readLocalImage('escape/outside.png'), /outside/);
    assert.throws(() => prepareOutputPath('escape/new.png'), /outside/);
    process.env.NANOBANANA_ALLOW_OVERWRITE = '1';
    writeOutputImage('generated/new.png',png);
  } finally {
    if (oldRoot === undefined) delete process.env.NANOBANANA_WORKSPACE_ROOT; else process.env.NANOBANANA_WORKSPACE_ROOT=oldRoot;
    if (oldOverwrite === undefined) delete process.env.NANOBANANA_ALLOW_OVERWRITE; else process.env.NANOBANANA_ALLOW_OVERWRITE=oldOverwrite;
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
