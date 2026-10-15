const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const compiled = buildSync({ stdin: { contents: `
  export * from './functions/_lib/access-auth.js';
  export { onRequest as adminMiddleware } from './functions/api/admin/_middleware.js';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = new Module(path.join(process.cwd(), 'tests', 'bundled-access.cjs'));
mod.filename = path.join(process.cwd(), 'tests', 'bundled-access.cjs');
mod._compile(compiled.outputFiles[0].text, mod.filename);
const api = mod.exports;

const { subtle } = globalThis.crypto;
const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json64 = (value) => b64url(Buffer.from(JSON.stringify(value)));
const now = () => Math.floor(Date.now() / 1000);

let trusted, attacker, certsFetches, certsBody;

async function makeKey(kid) {
  const pair = await subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e } };
}

async function sign(key, payload, header = {}) {
  const head = json64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = json64(payload);
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function claims(overrides = {}) {
  return { aud: [api.ACCESS_AUDIENCES[0]], iss: api.ACCESS_TEAM_DOMAIN, email: 'admin@example.invalid',
    type: 'app', iat: now(), nbf: now(), exp: now() + 600, ...overrides };
}

// Any fetch other than the fixed Access certs URL fails the test.
const fetchImpl = async (url) => {
  assert.equal(String(url), api.ACCESS_CERTS_URL);
  certsFetches += 1;
  return Response.json(certsBody);
};

async function callMiddleware(token) {
  let reachedHandler = false;
  const headers = token === undefined ? {} : { 'cf-access-jwt-assertion': token };
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    const response = await api.adminMiddleware({
      request: new Request('https://example.invalid/api/admin/test-alert?view=subscribers', { headers }),
      next: async () => { reachedHandler = true; return new Response('handler'); },
    });
    return { status: response.status, reachedHandler };
  } finally {
    global.fetch = originalFetch;
  }
}

beforeEach(async () => {
  api.resetAccessCertsCache();
  trusted ??= await makeKey('trusted-kid');
  attacker ??= await makeKey('attacker-kid');
  certsFetches = 0;
  certsBody = { keys: [trusted.jwk] };
});

test('valid Access token for each EWS app reaches the handler', async () => {
  for (const aud of api.ACCESS_AUDIENCES) {
    const result = await callMiddleware(await sign(trusted, claims({ aud: [aud] })));
    assert.deepEqual(result, { status: 200, reachedHandler: true });
  }
  // String aud form is also accepted by the JWT spec.
  assert.equal((await callMiddleware(await sign(trusted, claims({ aud: api.ACCESS_AUDIENCES[1] })))).status, 200);
});

test('missing or malformed tokens are rejected', async () => {
  for (const token of [undefined, '', 'not-a-jwt', 'a.b', 'a.b.c.d', '!!!.@@@.###', 'eyJ.eyJ.x']) {
    assert.deepEqual(await callMiddleware(token), { status: 401, reachedHandler: false }, `token ${token}`);
  }
});

test('token signed by an unknown key is rejected even if it reuses a trusted kid', async () => {
  assert.equal((await callMiddleware(await sign(attacker, claims()))).status, 401);
  const forged = await sign({ ...attacker, kid: trusted.kid }, claims());
  assert.deepEqual(await callMiddleware(forged), { status: 401, reachedHandler: false });
});

test('tampered payload is rejected', async () => {
  const [head, , signature] = (await sign(trusted, claims({ email: 'admin@example.invalid' }))).split('.');
  const tampered = `${head}.${json64(claims({ email: 'attacker@example.invalid' }))}.${signature}`;
  assert.equal((await callMiddleware(tampered)).status, 401);
});

test('alg none, HMAC, and missing kid are rejected', async () => {
  const body = json64(claims());
  assert.equal((await callMiddleware(`${json64({ alg: 'none', kid: trusted.kid })}.${body}.`)).status, 401);
  assert.equal((await callMiddleware(`${json64({ alg: 'none', kid: trusted.kid })}.${body}.AAAA`)).status, 401);
  assert.equal((await callMiddleware(await sign(trusted, claims(), { alg: 'HS256' }))).status, 401);
  assert.equal((await callMiddleware(await sign(trusted, claims(), { kid: undefined }))).status, 401);
});

test('wrong audience, issuer, or expiry is rejected', async () => {
  const cases = [
    { aud: ['0'.repeat(64)] },
    { aud: [] },
    { aud: undefined },
    { iss: 'https://attacker.cloudflareaccess.com' },
    { iss: `${api.ACCESS_TEAM_DOMAIN}/` },
    { exp: now() - 3600 },
    { exp: undefined },
    { nbf: now() + 3600 },
  ];
  for (const overrides of cases) {
    const result = await callMiddleware(await sign(trusted, claims(overrides)));
    assert.deepEqual(result, { status: 401, reachedHandler: false }, JSON.stringify(overrides));
  }
});

test('keys are only ever fetched from the fixed certs URL, never from the token', async () => {
  const token = await sign(attacker, claims({ iss: 'https://attacker.cloudflareaccess.com' }),
    { jku: 'https://attacker.example/certs', x5u: 'https://attacker.example/cert' });
  assert.equal((await callMiddleware(token)).status, 401);
});

test('certs endpoint failures fail closed', async () => {
  const token = await sign(trusted, claims());
  for (const failure of [
    async () => new Response('down', { status: 500 }),
    async () => Response.json({ keys: [] }),
    async () => new Response('not json'),
    async () => { throw new TypeError('network down'); },
  ]) {
    api.resetAccessCertsCache();
    let reachedHandler = false;
    const originalFetch = global.fetch;
    global.fetch = failure;
    try {
      const response = await api.adminMiddleware({
        request: new Request('https://example.invalid/api/admin/subscribers', { headers: { 'cf-access-jwt-assertion': token } }),
        next: async () => { reachedHandler = true; return new Response('handler'); },
      });
      assert.ok([401, 503].includes(response.status), `status ${response.status}`);
      assert.equal(reachedHandler, false);
    } finally {
      global.fetch = originalFetch;
    }
  }
});

test('certs are cached, and an unknown kid does not trigger a refetch storm', async () => {
  const token = await sign(trusted, claims());
  for (let i = 0; i < 5; i += 1) assert.equal((await callMiddleware(token)).status, 200);
  assert.equal(certsFetches, 1);
  for (let i = 0; i < 5; i += 1) assert.equal((await callMiddleware(await sign(attacker, claims()))).status, 401);
  assert.equal(certsFetches, 1);
});
