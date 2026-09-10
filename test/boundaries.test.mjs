import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AxiosError } from 'axios';
import { GeminiClient, estimateGeminiCost, getRuntimeDefaults } from '../dist/gemini-client.js';

const defaults = getRuntimeDefaults({
  NANOBANANA_DEFAULT_MODEL: 'gemini-3.1-flash-image',
  NANOBANANA_DEFAULT_IMAGE_SIZE: '1K',
});
const ref = { source: 'inline', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' };
const imageResponse = { candidates: [{ content: { parts: [
  { thought: true, inlineData: { mimeType: 'image/png', data: 'dGhvdWdodA==' } },
  { text: 'Result' },
  { inlineData: { mimeType: 'image/png', data: ref.base64 } },
] } }] };
function reply(config, data, headers = {}) {
  return { config, data, headers, status: 200, statusText: 'OK' };
}

// Adapters replace the real transport: none of these tests uses Google or a key.
test('generation uses cohort model and sends only supported provider options', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  const calls = [];
  client.api.defaults.adapter = async (config) => {
    calls.push(config);
    return reply(config, imageResponse);
  };
  const result = await client.generateImage({
    prompt: 'Synthetic test', negativeSeed: 19, seed: 7,
    referenceMode: 'style', referenceStrength: 0.5, mimeType: 'image/jpeg',
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /models\/gemini-3\.1-flash-image:generateContent$/);
  const body = JSON.parse(calls[0].data);
  assert.equal(body.generationConfig.imageConfig.imageSize, '1K');
  assert.equal(body.generationConfig.seed, 7);
  assert.equal(body.generationConfig.imageConfig.negativeSeed, undefined);
  assert.equal(body.generationConfig.imageConfig.outputMimeType, undefined);
  assert.equal(result.model, 'gemini-3.1-flash-image');
});

test('2.5 model omits unsupported imageSize and malformed model never calls transport', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  const calls = [];
  client.api.defaults.adapter = async (config) => { calls.push(config); return reply(config, imageResponse); };
  await client.generateImage({ prompt: 'Synthetic test', model: 'gemini-2.5-flash-image', imageSize: '1K' });
  assert.equal(JSON.parse(calls[0].data).generationConfig.imageConfig.imageSize, undefined);
  await assert.rejects(client.generateImage({ prompt: 'Synthetic test', model: '__proto__' }), /Unsupported model/);
  assert.equal(calls.length, 1);
});

test('cost estimates account for thought output and 2.5 image input', () => {
  const flash = estimateGeminiCost('gemini-3.1-flash-image', {
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }],
    thoughtsTokenCount: 1000,
  });
  assert.equal(flash.total, 0.0702);
  assert.equal(estimateGeminiCost('gemini-3.1-flash-image', { candidatesTokenCount: 1120, thoughtsTokenCount: 1000 }).total, 0.0702);
  const legacy = estimateGeminiCost('gemini-2.5-flash-image', {
    promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 1000 }],
  });
  assert.equal(legacy.total, 0.0003);
});

test('provider failures expose status without request or response content and do not retry', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  let calls = 0;
  client.api.defaults.adapter = async (config) => {
    calls++;
    throw new AxiosError('PRIVATE_REQUEST_DETAILS', 'ERR_BAD_REQUEST', config, {}, {
      config, data: { error: { message: 'PRIVATE_PROVIDER_DETAILS' } },
      status: 429, statusText: 'Too Many Requests', headers: {},
    });
  };
  await assert.rejects(client.generateImage({ prompt: 'PRIVATE_PROMPT' }), (error) => {
    assert.match(error.message, /429/);
    assert.doesNotMatch(error.message, /PRIVATE_|test-key/);
    return true;
  });
  assert.equal(calls, 1);
});

test('resumable upload uses two bounded calls and repeated reference is cached', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  const calls = [];
  client.api.defaults.adapter = async (config) => {
    calls.push(config);
    if (calls.length === 1) return reply(config, {}, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=synthetic' });
    return reply(config, { file: { name: 'files/synthetic', uri: 'https://generativelanguage.googleapis.com/v1beta/files/synthetic', mimeType: 'image/png', sizeBytes: '70' } });
  };
  const first = await client.resolveReferenceImage(ref);
  const second = await client.resolveReferenceImage(ref);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('X-Goog-Upload-Protocol'), 'resumable');
  assert.equal(calls[1].headers.get('X-Goog-Upload-Command'), 'upload, finalize');
  assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 60_000));
});

test('foreign resumable upload destinations are refused before forwarding credentials', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  let calls = 0;
  client.api.defaults.adapter = async (config) => {
    calls++;
    return reply(config, {}, { 'x-goog-upload-url': 'https://untrusted.example/upload' });
  };
  await assert.rejects(client.resolveReferenceImage(ref));
  assert.equal(calls, 1);
});

test('real stdio client rejects invalid requests before any provider call', { timeout: 15_000 }, async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-stdio-'));
  fs.writeFileSync(path.join(workspace, 'existing.png'), 'existing content');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const client = new Client({ name: 'boundary-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', new URL('./fixtures/block-network.mjs', import.meta.url).href, fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { NANOBANANA_WORKSPACE_ROOT: workspace, NANOBANANA_ALLOW_OVERWRITE: '0', GEMINI_IMAGE_API_KEY: 'test-key-not-used', NANOBANANA_DEFAULT_MODEL: 'gemini-3.1-flash-image', NANOBANANA_DEFAULT_IMAGE_SIZE: '1K' },
    stderr: 'pipe',
  });
  t.after(async () => { await client.close(); });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
  const capabilities = await client.callTool({ name: 'get_model_capabilities', arguments: {} });
  const active = JSON.parse(capabilities.content[0].text);
  assert.equal(active.defaults.model, 'gemini-3.1-flash-image');
  for (const args of [
    { prompt: 'test', outputPath: '' },
    { prompt: 'test', outputPath: 99 },
    { prompt: 'test', referenceImages: 'not-an-array' },
    { prompt: 'test', unexpected: 'not-allowed' },
  ]) {
    const result = await client.callTool({ name: 'generate_image', arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid|invalid/);
    assert.doesNotMatch(result.content[0].text, /TEST_EXTERNAL_NETWORK_FORBIDDEN|HTTP|test-key/);
  }
  for (const outputPath of ['../outside.png', 'existing.png']) {
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'test', outputPath } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /outside|already exists/);
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'existing.png'), 'utf8'), 'existing content');
  assert.doesNotMatch(stderr, /test-key-not-used/);
});

test('private URL fails before download or upload transport', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  let calls = 0;
  client.download.defaults.adapter = client.api.defaults.adapter = async () => { calls++; throw new Error('Transport must not run'); };
  await assert.rejects(client.resolveReferenceImage({ source: 'url', url: 'https://169.254.169.254/image.png' }), /public HTTPS/);
  assert.equal(calls, 0);
});

test('Google file names normalize and non-Google URIs fail without transport', async () => {
  const client = new GeminiClient('test-key-not-used', defaults);
  const resolved = await client.resolveReferenceImage({ source: 'file_uri', fileUri: 'files/synthetic' });
  assert.equal(resolved.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/synthetic');
  for (const fileUri of ['https://example.com/image.png', 'files/../secret', 'https://generativelanguage.googleapis.com/v1beta/files/name?key=example']) {
    await assert.rejects(client.resolveReferenceImage({ source: 'file_uri', fileUri }), /Invalid Google Files URI/);
  }
  assert.equal(client.api.defaults.maxContentLength, 64 * 1024 * 1024);
  assert.equal(client.download.defaults.maxContentLength, 10 * 1024 * 1024);
});
