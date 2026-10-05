import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../../cloudflare/worker.mjs';
const origin = 'https://pokemon-example.pages.dev';
const key = 'a'.repeat(32);
const api = 'https://personal-example.workers.dev';
function envFixture() {
  let calls = 0;
  const env = { WIDGET_ORIGIN: origin, WIDGET_KEY: key, NOTION_TOKEN: 'mock-notion', COLLECTION: {
    idFromName: name => name, get: () => ({ fetch: async () => { calls++; return Response.json({ used: 1, remaining: 2, pending: [], records: [], owned: [] }); } })
  } };
  return { env, calls: () => calls };
}
function request(path = '/api/collection', extra = {}) {
  return new Request(api + path, { ...extra, headers: { Origin: origin, Authorization: 'Bearer ' + key, ...extra.headers } });
}
test('공용 Pages의 CORS 사전 확인은 저장소·노션을 호출하지 않음', async () => {
  const f = envFixture();
  const response = await worker.fetch(request('/api/capture', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'
  } }), f.env);
  assert.equal(response.status, 204); assert.equal(f.calls(), 0);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
});
test('허용한 공용 화면 + 개인 키로만 API 접근, 오류에도 CORS 헤더 유지', async () => {
  const f = envFixture();
  assert.equal((await worker.fetch(request(), f.env)).status, 200); assert.equal(f.calls(), 1);
  const wrongKey = await worker.fetch(request('/api/collection', { headers: { Authorization: 'Bearer wrong' } }), f.env);
  assert.equal(wrongKey.status, 401); assert.equal(wrongKey.headers.get('Access-Control-Allow-Origin'), origin);
  const foreign = await worker.fetch(request('/api/collection', { headers: { Origin: 'https://foreign.example' } }), f.env);
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await worker.fetch(request('/api/collection', { headers: { Origin: 'null' } }), f.env)).status, 403);
  assert.equal(f.calls(), 1);
});

test('화면 설정 API도 개인 키와 origin 확인, POST와 CORS 사전 확인 지원', async () => {
  const f = envFixture();
  const preflight = await worker.fetch(request('/api/preferences', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } }), f.env);
  assert.equal(preflight.status, 204); assert.equal(f.calls(), 0);
  const response = await worker.fetch(request('/api/preferences', { method: 'POST', body: JSON.stringify({ mode: 'sleep', pokemonKey: '', backgroundId: '' }) }), f.env);
  assert.equal(response.status, 200); assert.equal(f.calls(), 1);
  assert.equal((await worker.fetch(request('/api/preferences', { method: 'POST', headers: { Authorization: 'Bearer wrong' } }), f.env)).status, 401);
});
test('개인 Worker는 HTML을 제공하지 않고 API 경로·메서드를 제한', async () => {
  const f = envFixture();
  assert.equal((await worker.fetch(request('/pokedex.html'), f.env)).status, 404);
  assert.equal((await worker.fetch(request('/api/collection', { method: 'POST' }), f.env)).status, 405);
  assert.equal((await worker.fetch(request('/api/capture', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } }), f.env)).status, 403);
  assert.equal((await worker.fetch(request(), { ...f.env, WIDGET_ORIGIN: '' })).status, 503);
  assert.equal(f.calls(), 0);
});
function browserFixture() {
  const values = new Map(), requests = [];
  let status = 200;
  const context = vm.createContext({ URL, URLSearchParams, crypto, TextEncoder, AbortSignal, Date,
    localStorage: { getItem: k => values.get(k) || null, setItem: (k, value) => values.set(k, value), removeItem: k => values.delete(k) },
    fetch: async (address, init) => {
      requests.push({ address, init });
      return Response.json(status === 409 ? { error: '이미 잡음', code: 'ALREADY_COLLECTED' }
        : { used: 1, remaining: 2, pending: [], records: [], owned: [] }, { status });
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../../assets/collection.js', import.meta.url), 'utf8'), context);
  return { context, values, requests, setStatus: value => { status = value; }, run: code => vm.runInContext(code, context) };
}
test('공용 화면에서 노션 정보 없이 개인 Worker로만 API 요청', async () => {
  const f = browserFixture();
  await f.run(`store = new PokemonCollection.RemoteStore('${key}', '${api}/'); store.getSnapshot()`);
  assert.equal(f.requests[0].address, api + '/api/collection?');
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer ' + key);
  assert.equal(f.requests[0].init.credentials, 'omit');
  const first = await f.run('store.pendingKey');
  const second = await f.run(`new PokemonCollection.RemoteStore('${key}', 'https://another.workers.dev').pendingKey`);
  assert.notEqual(first, second);
  await assert.rejects(f.run(`new PokemonCollection.RemoteStore('${key}', '').getSnapshot()`));
  await assert.rejects(f.run(`new PokemonCollection.RemoteStore('${key}', 'http://untrusted.example').getSnapshot()`));
  assert.equal(f.requests.length, 1);
});
test('중복 저장 거절은 개인 Worker의 확인 대기 기록을 제거', async () => {
  const f = browserFixture(); f.setStatus(409);
  await f.run(`store = new PokemonCollection.RemoteStore('${key}', '${api}')`);
  await assert.rejects(f.run(`store.capture({ id: 'mock', slug: 'pikachu', isShiny: false })`), { code: 'ALREADY_COLLECTED' });
  assert.equal(f.values.size, 0);
});
test('연결 페이지는 개인 Worker 주소와 키로 공용 Pages의 임베드 URL 생성', async () => {
  const f = browserFixture();
  const fields = Object.fromEntries(['connect-form', 'connect', 'result', 'status', 'key', 'worker', 'widget-url', 'open-widget', 'open-db', 'copy'].map(id => [id, {
    value: '', events: {}, addEventListener(name, handler) { this.events[name] = handler; }
  }]));
  fields.key.value = key; fields.worker.value = api;
  Object.assign(f.context, { location: { protocol: 'https:', origin, href: origin + '/setup.html' },
    document: { getElementById: id => fields[id] } });
  const html = fs.readFileSync(new URL('../../setup.html', import.meta.url), 'utf8');
  vm.runInContext([...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1], f.context);
  await fields['connect-form'].events.submit({ preventDefault() {} });
  assert.equal(f.requests[0].address, api + '/api/setup');
  const generated = new URL(fields['widget-url'].value);
  assert.equal(generated.origin, origin); assert.equal(generated.pathname, '/pokedex.html');
  assert.equal(generated.search, '');
  const params = new URLSearchParams(generated.hash.slice(1));
  assert.equal(params.get('worker'), api); assert.equal(params.get('key'), key);
  assert.equal(fields.result.hidden, false);
});
test('공용 배포 설정에는 API 바인딩·사용자 secrets가 없고 Worker는 별도 배포', () => {
  const read = file => JSON.parse(fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8'));
  const pages = read('wrangler.jsonc'), apiConfig = read('cloudflare/worker.wrangler.jsonc');
  assert.equal(pages.pages_build_output_dir, './dist');
  assert.equal(pages.main, undefined); assert.equal(pages.durable_objects, undefined); assert.equal(pages.vars, undefined);
  assert.equal(apiConfig.assets, undefined); assert.equal(apiConfig.name, 'pokemon-collection-widget');
  assert.equal(apiConfig.durable_objects.bindings[0].class_name, 'Collection');
});
