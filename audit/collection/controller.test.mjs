import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../../pokedex.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
class Element {
  constructor() {
    this.hidden = false; this.textContent = ''; this.style = {}; this.attributes = {}; this.children = []; this.dataset = {};
    this.events = {}; const set = new Set();
    this.classList = { add: (...names) => names.forEach(n => set.add(n)), remove: (...names) => names.forEach(n => set.delete(n)),
      contains: n => set.has(n), toggle: (n, force) => { const yes = force ?? !set.has(n); yes ? set.add(n) : set.delete(n); return yes; } };
  }
  setAttribute(k, v) { this.attributes[k] = v; }
  hasAttribute(k) { return Object.hasOwn(this.attributes, k); }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(k, handler) { this.events[k] = handler; }
  getBoundingClientRect() { return { bottom: this === this.box ? 80 : 20 }; }
  focus() {} scrollIntoView() {} append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
}
async function fixture(htmlSource = html, protocol = 'file:', hash = '', savedValues = {}, timerOverrides = {}) {
  const html = htmlSource;
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  for (const match of html.matchAll(/<([^\s>]+)[^>]*\bid="([^"]+)"[^>]*\bhidden[^>]*>/g)) {
    const element = elements.get(match[2]);
    element.setAttribute('hidden', '');
    // SVG의 hidden 속성은 HTML의 .hidden 프로퍼티처럼 반영되지 않습니다.
    if (!['path', 'g'].includes(match[1])) element.hidden = true;
  }
  for (const id of ['pokemon-data', 'pokemon-types', 'background-catalog']) elements.get(id).textContent = html.match(new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'))[1];
  elements.get('daily-catches').children = Array.from({ length: 3 }, () => new Element());
  elements.get('dialogue-box').box = elements.get('dialogue-box');
  const values = new Map(Object.entries(savedValues));
  const documentEvents = {}, motionEvents = {};
  const documentState = { hidden: false, getElementById: id => elements.get(id), createElement: () => new Element(),
    addEventListener: (name, handler) => { documentEvents[name] = handler; }, fonts: { ready: Promise.resolve() } };
  const context = vm.createContext({
    console, crypto, URLSearchParams, TextEncoder, Date, Promise, Math: Object.assign(Object.create(Math), { random: () => 0 }), setTimeout: timerOverrides.setTimeout || setTimeout, clearTimeout: timerOverrides.clearTimeout || clearTimeout, setInterval: () => 1, clearInterval() {},
    location: { protocol, hash }, window: { matchMedia: () => ({ matches: timerOverrides.reducedMotion ?? true,
      addEventListener: (name, handler) => { motionEvents[name] = handler; } }) },
    fetch: () => { throw Error('테스트 화면은 외부 데이터나 Worker를 요청하면 안 됩니다.'); },
    document: documentState,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, val) => values.set(key, val), removeItem: key => values.delete(key) },
    getComputedStyle: () => ({ paddingBottom: '0' }),
    Image: class { set src(value) { this.value = value; queueMicrotask(() => this.onload?.()); } }
  });
  vm.runInContext(fs.readFileSync(new URL('../../assets/collection.js', import.meta.url), 'utf8'), context);
  vm.runInContext(script, context);
  const run = code => vm.runInContext(code, context);
  const waitState = async name => { for (let i = 0; i < 100; i++) { if (run('state') === name) return; await new Promise(r => setTimeout(r, 5)); } throw Error('state ' + run('state') + ', wanted ' + name); };
  await new Promise(r => setTimeout(r, 5));
  return { elements, run, waitState, values, documentState, documentEvents, motionEvents };
}

test('개인 Worker의 포획 한도를 볼과 안내에 반영, 삭제 후 줄어든 사용 횟수 표시', async () => {
  const f = await fixture();
  f.run('collectionSnapshot = { used: 4, limit: 5, remaining: 1, pending: [] }; updateCount()');
  const balls = f.elements.get('daily-catches');
  assert.equal(balls.children.length, 5);
  assert.match(balls.attributes['aria-label'], /4마리.*5마리/);
  f.run('collectionSnapshot = { used: 3, limit: 5, remaining: 2, pending: [] }; updateCount()');
  assert.match(balls.attributes['aria-label'], /3마리.*5마리/);
  f.run('collectionSnapshot = { used: 7, limit: 10, remaining: 3, pending: [] }; updateCount()');
  assert.equal(balls.children.length, 6); assert.match(balls.attributes['aria-label'], /7마리.*10마리/);
});

test('포획 시 배경 등록→설정에서 독립 선택→슬립 표시→재접속 유지→뽑기모드 복귀', async () => {
  const f = await fixture();
  const records = ['pikachu', 'raichu', 'eevee'].map((slug, index) => ({ id: crypto.randomUUID(), slug, dexId: [25, 26, 133][index], name: ['피카츄', '라이츄', '이브이'][index], isShiny: false, capturedAt: '2026-09-01T00:00:00Z', imageSrc: './images/normal/mr-mime.webp' }));
  f.run(`localStorage.setItem('pokemon-collection-preview-v1', ${JSON.stringify(JSON.stringify(records))})`);
  await f.run('openDisplaySettings()');
  assert.equal(f.elements.get('display-pokemon').children.length, 4);
  assert.equal(f.elements.get('display-background').children.length, 3);
  f.elements.get('display-pokemon').value = 'eevee:false';
  f.elements.get('display-background').value = 'electric';
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.run('widgetPreferences.mode'), 'draw');
  assert.equal(f.elements.has('display-mode'), false);
  await f.elements.get('mode-toggle').events.click();
  assert.equal(f.run('state'), 'sleep');
  assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/electric.webp');
  assert.equal(f.elements.get('pokemon-img').alt, '이브이');
  assert.equal(f.elements.get('daily-catches').hidden, true);
  assert.equal(f.elements.get('home-menu').hidden, true);
  await f.run('openDisplaySettings()');
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('state'), 'sleep');
  f.run('handleStart(); advance(); reset()');
  assert.equal(f.run('state'), 'sleep');
  const next = await fixture(html, 'file:', '', Object.fromEntries(f.values));
  assert.equal(next.run('state'), 'sleep');
  assert.equal(next.elements.get('pokemon-img').alt, '이브이');
  await next.elements.get('mode-toggle').events.click();
  assert.equal(next.run('state'), 'idle');
  assert.equal(next.elements.get('daily-catches').hidden, false);
  await next.run('handleStart()');
  next.run('advance()'); await next.waitState('capture-choice');
  await next.run('capturePokemon()');
  assert.equal(next.run('collectionSnapshot.records.at(-1).backgroundId'), 'leaf-bug');
});

test('설정 저장 실패 시 현재 모드를 유지, 빈 수집에서도 슬립모드 진입 가능', async () => {
  const f = await fixture();
  await f.elements.get('mode-toggle').events.click();
  await f.run('openDisplaySettings()');
  f.run('collectionStore.savePreferences = async () => { throw Error("저장 실패"); }');
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('state'), 'sleep');
  assert.equal(f.elements.get('display-settings').hidden, false);
  assert.equal(f.elements.get('display-status').textContent, '저장 실패');
  const empty = await fixture();
  await empty.elements.get('mode-toggle').events.click();
  assert.equal(empty.run('state'), 'sleep');
  assert.equal(empty.elements.get('sleep-empty').hidden, false);
  assert.equal(empty.elements.get('pokemon-display').hidden, true);
});

function searchFixtureValues() {
  const records = [
    ['pikachu', 25, '피카츄', false], ['pikachu', 25, '피카츄', true], ['raichu', 26, '라이츄', false], ['eevee', 133, '이브이', false]
  ].map(([slug, dexId, name, isShiny]) => ({ id: crypto.randomUUID(), slug, dexId, name, isShiny, capturedAt: '2026-09-01T00:00:00Z', imageSrc: './images/normal/mr-mime.webp' }));
  return { 'pokemon-collection-preview-v1': JSON.stringify(records), 'pokemon-widget-preferences-v1': JSON.stringify({ mode: 'draw', pokemonKey: 'eevee:false', backgroundId: 'normal' }) };
}

test('슬립 포켓몬 클릭: 기분별 말풍선, 연속 클릭 교체, 자동 복귀, 설정·모드 전환 정리', async () => {
  const scheduled = new Map();
  const timers = {
    setTimeout(callback, ms) {
      if (ms !== 3400) return setTimeout(callback, ms);
      const handle = {}; scheduled.set(handle, callback); return handle;
    },
    clearTimeout(handle) { if (!scheduled.delete(handle)) clearTimeout(handle); }
  };
  const f = await fixture(html, 'file:', '', searchFixtureValues(), timers);
  await f.elements.get('mode-toggle').events.click();
  const touch = f.elements.get('sleep-touch');
  const sprite = f.elements.get('pokemon-display');
  const bubble = f.elements.get('sleep-bubble');
  assert.equal(f.elements.get('sleep-icon-heart').hasAttribute('hidden'), true);
  assert.equal(touch.hidden, false);
  assert.equal(touch.attributes['aria-label'], '이브이와 놀기');
  assert.equal(sprite.classList.contains('sleep-companion'), true);
  const saved = JSON.stringify(Object.fromEntries(f.values));
  touch.events.click();
  assert.equal(sprite.attributes['data-sleep-mood'], 'heart');
  assert.equal(bubble.hidden, false);
  assert.equal(f.elements.get('sleep-icon-heart').hasAttribute('hidden'), false);
  assert.equal(f.elements.get('sleep-icon-music').hasAttribute('hidden'), true);
  assert.equal(f.elements.get('sleep-icon-play').hasAttribute('hidden'), true);
  assert.match(f.elements.get('sleep-bubble-label').textContent, /이브이가 반가워해요/);
  const staleCallback = [...scheduled.values()][0];
  touch.events.click();
  assert.equal(sprite.attributes['data-sleep-mood'], 'music');
  assert.equal(f.elements.get('sleep-icon-heart').hasAttribute('hidden'), true);
  assert.equal(f.elements.get('sleep-icon-music').hasAttribute('hidden'), false);
  assert.equal(scheduled.size, 1);
  staleCallback();
  assert.equal(bubble.hidden, false);
  assert.equal(sprite.attributes['data-sleep-mood'], 'music');
  touch.events.click();
  assert.equal(sprite.attributes['data-sleep-mood'], 'play');
  assert.equal(f.elements.get('sleep-icon-play').hasAttribute('hidden'), false);
  assert.equal(f.elements.get('sleep-icon-music').hasAttribute('hidden'), true);
  [...scheduled.values()][0]();
  assert.equal(bubble.hidden, true);
  assert.equal(sprite.attributes['data-sleep-mood'], undefined);
  assert.equal(sprite.classList.contains('sleep-companion'), true);
  assert.equal(f.elements.get('dialogue-text').textContent, '이브이와\n쉬는 중…');
  assert.equal(scheduled.size, 0);
  assert.equal(JSON.stringify(Object.fromEntries(f.values)), saved);
  assert.equal(f.run('state'), 'sleep');
  touch.events.click();
  await f.run('openDisplaySettings()');
  assert.equal(bubble.hidden, true);
  assert.equal(scheduled.size, 0);
  touch.events.click();
  assert.equal(bubble.hidden, true);
  f.run('closeDisplaySettings()');
  touch.events.click();
  const leavingCallback = [...scheduled.values()][0];
  await f.elements.get('mode-toggle').events.click();
  assert.equal(f.run('state'), 'idle');
  assert.equal(touch.hidden, true);
  assert.equal(sprite.classList.contains('sleep-companion'), false);
  assert.equal(bubble.hidden, true);
  assert.equal(scheduled.size, 0);
  leavingCallback(); touch.events.click();
  assert.equal(bubble.hidden, true);
  const empty = await fixture();
  await empty.elements.get('mode-toggle').events.click();
  assert.equal(empty.elements.get('sleep-touch').hidden, true);
  empty.elements.get('sleep-touch').events.click();
  assert.equal(empty.elements.get('sleep-bubble').hidden, true);
});

test('슬립 자동 행동: 랜덤 휴식·행동·방향, 반복 방지, 클릭 우선, 설정·모드·숨김 정리', async () => {
  const scheduled = new Map();
  const timers = { reducedMotion: false,
    setTimeout(callback, ms) { const handle = {}; scheduled.set(handle, { callback, ms }); return handle; },
    clearTimeout(handle) { scheduled.delete(handle); }
  };
  const f = await fixture(html, 'file:', '', searchFixtureValues(), timers);
  await f.elements.get('mode-toggle').events.click();
  const sprite = f.elements.get('pokemon-display'), bubble = f.elements.get('sleep-bubble');
  const saved = JSON.stringify(Object.fromEntries(f.values));
  const tick = () => {
    assert.equal(scheduled.size, 1);
    const [handle, task] = [...scheduled][0]; scheduled.delete(handle); task.callback(); return task;
  };
  assert.equal([...scheduled.values()][0].ms, 8000);
  tick();
  assert.equal(sprite.attributes['data-sleep-action'], 'stroll');
  assert.equal(sprite.attributes['data-sleep-direction'], 'right');
  assert.equal(bubble.hidden, true);
  assert.equal(tick().ms, 4800);
  assert.equal(sprite.attributes['data-sleep-action'], undefined);
  f.run('Math.random = () => .99');
  tick();
  assert.equal(sprite.attributes['data-sleep-action'], 'peek');
  assert.equal(sprite.attributes['data-sleep-direction'], 'left');
  assert.equal(tick().ms, 2800);
  assert.equal([...scheduled.values()][0].ms, 15920);
  f.run('Math.random = () => .5'); tick();
  assert.equal(sprite.attributes['data-sleep-action'], 'hops');
  const staleEnd = [...scheduled.values()][0].callback;
  f.elements.get('sleep-touch').events.click();
  assert.equal(sprite.attributes['data-sleep-action'], undefined);
  assert.ok(sprite.attributes['data-sleep-mood']);
  staleEnd();
  assert.ok(sprite.attributes['data-sleep-mood']);
  assert.equal([...scheduled.values()][0].ms, 3400);
  tick();
  assert.equal(sprite.attributes['data-sleep-mood'], undefined);
  assert.equal(scheduled.size, 1);
  tick();
  await f.run('openDisplaySettings()');
  assert.equal(sprite.attributes['data-sleep-action'], undefined);
  assert.equal(scheduled.size, 0);
  f.run('closeDisplaySettings()');
  assert.equal(scheduled.size, 1);
  const staleWait = [...scheduled.values()][0].callback;
  f.documentState.hidden = true; f.documentEvents.visibilitychange();
  assert.equal(scheduled.size, 0);
  staleWait(); assert.equal(sprite.attributes['data-sleep-action'], undefined);
  f.documentState.hidden = false; f.run('scheduleSleepAutonomy()');
  assert.equal(scheduled.size, 1);
  f.motionEvents.change({ matches: true });
  assert.equal(scheduled.size, 0);
  f.motionEvents.change({ matches: false });
  assert.equal(scheduled.size, 1);
  assert.equal(JSON.stringify(Object.fromEntries(f.values)), saved);
  tick();
  const leavingEnd = [...scheduled.values()][0].callback;
  await f.elements.get('mode-toggle').events.click();
  assert.equal(scheduled.size, 0);
  assert.equal(sprite.attributes['data-sleep-action'], undefined);
  leavingEnd(); assert.equal(scheduled.size, 0);
});

test('동작 줄이기·빈 수집·이미지 실패 시 슬립 자동 행동을 예약하지 않음', async () => {
  const scheduled = new Map();
  const timers = {
    setTimeout(callback, ms) { const handle = {}; scheduled.set(handle, { callback, ms }); return handle; },
    clearTimeout(handle) { scheduled.delete(handle); }
  };
  const reduced = await fixture(html, 'file:', '', searchFixtureValues(), timers);
  await reduced.elements.get('mode-toggle').events.click();
  assert.equal(scheduled.size, 0);
  const empty = await fixture(html, 'file:', '', {}, { ...timers, reducedMotion: false });
  await empty.elements.get('mode-toggle').events.click();
  assert.equal(scheduled.size, 0);
  reduced.elements.get('pokemon-img').hidden = true;
  reduced.motionEvents.change({ matches: false });
  assert.equal(scheduled.size, 0);
});

test('포켓몬 이름·번호·영문과 배경 타입 검색, 색이 다른 개체 제외·검색 밖 선택 유지', async () => {
  const f = await fixture(html, 'file:', '', searchFixtureValues());
  await f.run('openDisplaySettings()');
  assert.equal(f.elements.get('display-pokemon-count').hidden, true);
  const search = f.elements.get('display-pokemon-search');
  for (const query of ['피카', '025', 'PiKaChU', '２５', '피카츄 025']) {
    search.value = query; search.events.input();
    assert.match(f.elements.get('display-pokemon-count').textContent, /검색 결과 1종/);
    assert.equal(f.elements.get('display-pokemon-count').hidden, false);
    assert.equal(f.elements.get('display-pokemon').value, 'eevee:false');
  }
  search.value = '이로치'; search.events.input();
  assert.match(f.elements.get('display-pokemon-count').textContent, /검색 결과가 없어요/);
  assert.ok(!f.elements.get('display-pokemon').children.some(option => option.value === 'pikachu:true'));
  search.value = '없는 포켓몬'; search.events.input();
  assert.match(f.elements.get('display-pokemon-count').textContent, /검색 결과가 없어요.*현재 선택은 유지/);
  assert.equal(f.elements.get('display-pokemon').value, 'eevee:false');
  const backgroundSearch = f.elements.get('display-background-search');
  for (const query of ['전기', '피카츄', 'electric']) {
    backgroundSearch.value = query; backgroundSearch.events.input();
    assert.match(f.elements.get('display-background-count').textContent, /검색 결과 1개/);
    assert.equal(f.elements.get('display-background').value, 'normal');
  }
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('widgetPreferences.pokemonKey'), 'eevee:false');
  assert.equal(f.run('widgetPreferences.backgroundId'), 'normal');
});

test('색이 다른 포켓몬은 뽑지 않으며 모드·화면 저장은 즐겨찾기 목록을 보내지 않음', async () => {
  const f = await fixture(html, 'file:', '', searchFixtureValues());
  await f.run('handleStart()');
  assert.equal(f.run('pokemon.isShiny'), false);
  f.run('reset()');
  await f.run('openDisplaySettings()');
  f.run(`const originalPreferenceSave = collectionStore.savePreferences.bind(collectionStore);
    collectionStore.savePreferences = async next => { globalThis.preferencePayload = next; return originalPreferenceSave(next); };`);
  await f.elements.get('display-pokemon-favorite').events.click();
  assert.equal(f.run('preferencePayload.favoriteChange.pokemonKey'), 'eevee:false');
  assert.equal(f.run('preferencePayload.favoritePokemon'), undefined);
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('preferencePayload.favoritePokemon'), undefined);
  assert.equal(f.run('preferencePayload.favoriteBackgrounds'), undefined);
  await f.elements.get('mode-toggle').events.click();
  assert.equal(f.run('preferencePayload.favoritePokemon'), undefined);
  assert.equal(f.run('widgetPreferences.favoritePokemon[0]'), 'eevee:false');
});

test('별은 복수·개별·즉시 저장, 즐겨찾기 필터와 검색 조합, 슬립 설정 초안은 별 저장과 분리', async () => {
  const f = await fixture(html, 'file:', '', searchFixtureValues());
  await f.run('openDisplaySettings()');
  for (const key of ['pikachu:false', 'raichu:false']) {
    f.elements.get('display-pokemon').value = key;
    f.elements.get('display-pokemon').events.change();
    await f.elements.get('display-pokemon-favorite').events.click();
    assert.equal(f.elements.get('display-pokemon-favorite').attributes['aria-pressed'], 'true');
  }
  f.elements.get('display-background').value = 'electric';
  f.elements.get('display-background').events.change();
  await f.elements.get('display-background-favorite').events.click();
  assert.equal(f.run('widgetPreferences.mode'), 'draw');
  assert.equal(f.run('widgetPreferences.pokemonKey'), 'eevee:false');
  assert.equal(f.run('widgetPreferences.backgroundId'), 'normal');
  assert.equal(f.run('widgetPreferences.favoritePokemon.length'), 2);
  assert.equal(f.run('widgetPreferences.favoriteBackgrounds[0]'), 'electric');
  await f.elements.get('display-pokemon-only-favorites').events.click();
  assert.match(f.elements.get('display-pokemon-count').textContent, /즐겨찾기 2종/);
  f.elements.get('display-pokemon-search').value = '라이츄';
  f.elements.get('display-pokemon-search').events.input();
  assert.match(f.elements.get('display-pokemon-count').textContent, /검색 결과 1종/);
  await f.elements.get('display-pokemon-favorite').events.click();
  assert.match(f.elements.get('display-pokemon-count').textContent, /검색 결과가 없어요/);
  assert.equal(f.elements.get('display-pokemon').value, 'raichu:false');
  assert.equal(f.run('widgetPreferences.favoritePokemon.length'), 1);
  const restored = await fixture(html, 'file:', '', Object.fromEntries(f.values));
  assert.equal(restored.run('widgetPreferences.favoritePokemon[0]'), 'pikachu:false');
  assert.equal(restored.run('widgetPreferences.favoriteBackgrounds[0]'), 'electric');
  assert.equal(restored.run('state'), 'idle');
  await f.elements.get('display-save').events.click();
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.run('widgetPreferences.mode'), 'draw');
  assert.equal(f.run('widgetPreferences.pokemonKey'), 'raichu:false');
  assert.equal(f.run('widgetPreferences.favoritePokemon[0]'), 'pikachu:false');
});

test('즐겨찾기 저장 실패 시 별과 목록 원복, 빈 즐겨찾기 안내', async () => {
  const f = await fixture(html, 'file:', '', searchFixtureValues());
  await f.run('openDisplaySettings()');
  await f.elements.get('display-pokemon-favorite').events.click();
  assert.equal(f.elements.get('display-pokemon-favorite').attributes['aria-pressed'], 'true');
  f.run('collectionStore.savePreferences = async () => { throw Error("즐겨찾기 저장 실패"); }');
  await f.elements.get('display-pokemon-favorite').events.click();
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.elements.get('display-pokemon-favorite').attributes['aria-pressed'], 'true');
  assert.equal(f.run('widgetPreferences.favoritePokemon[0]'), 'eevee:false');
  assert.equal(f.elements.get('display-status').textContent, '즐겨찾기 저장 실패');
  f.run('collectionStore.savePreferences = async prefs => ({preferences: {mode: prefs.mode, pokemonKey: prefs.pokemonKey, backgroundId: prefs.backgroundId}})');
  await f.elements.get('display-pokemon-favorite').events.click();
  assert.match(f.elements.get('display-status').textContent, /Worker.*업데이트/);
  assert.equal(f.elements.get('display-pokemon-favorite').attributes['aria-pressed'], 'true');
  const empty = await fixture(); await empty.run('openDisplaySettings()');
  empty.elements.get('display-pokemon-only-favorites').events.click();
  assert.match(empty.elements.get('display-pokemon-count').textContent, /즐겨찾기에 등록한 항목이 없어요/);
  assert.equal(empty.elements.get('display-pokemon-favorite').disabled, true);
});

test('저장 전의 조회가 늦게 도착해도 새 즐겨찾기를 덮어쓰지 않음', async () => {
  const f = await fixture(html, 'file:', '', searchFixtureValues());
  await f.run('openDisplaySettings()');
  await f.run('collectionStore.getSnapshot(true).then(snapshot => globalThis.staleFavoritesSnapshot = snapshot)');
  f.run(`const originalSnapshotForRace = collectionStore.getSnapshot.bind(collectionStore);
    let delayedOnce = false;
    collectionStore.getSnapshot = all => {
      if (delayedOnce) return originalSnapshotForRace(all);
      delayedOnce = true;
      return new Promise(resolve => { globalThis.finishStaleFavoritesSync = () => resolve(staleFavoritesSnapshot); });
    };`);
  const staleRequest = f.run('syncCollection(true)');
  await f.elements.get('display-pokemon-favorite').events.click();
  f.run('finishStaleFavoritesSync()');
  assert.equal(await staleRequest, false);
  assert.equal(f.run('widgetPreferences.favoritePokemon[0]'), 'eevee:false');
  assert.equal(f.run('collectionSnapshot.preferences.favoritePokemon[0]'), 'eevee:false');
});
test('전설·환상 테스트 화면: 모든 뽑기 구간과 환상 배경, HTTP에서도 기록과 Worker를 분리', async () => {
  const preview = fs.readFileSync(new URL('../../pokedex-legendary-test.html', import.meta.url), 'utf8');
  const latestBackgrounds = {
    koraidon: 'koraidon', kyurem: 'kyurem', 'black-kyurem': 'kyurem', 'white-kyurem': 'kyurem',
    mew: 'mew', miraidon: 'miraidon', zekrom: 'zekrom',
    okidogi: 'okidogi-munkidori-fezandipiti-pecharunt', munkidori: 'okidogi-munkidori-fezandipiti-pecharunt',
    fezandipiti: 'okidogi-munkidori-fezandipiti-pecharunt', pecharunt: 'okidogi-munkidori-fezandipiti-pecharunt'
  };
  for (const protocol of ['file:', 'https:']) {
    const f = await fixture(preview, protocol, '#worker=https://example.workers.dev&key=production-key');
    assert.equal(f.run('new Set(POKEMON_DATA.map(entry => entry.dexId)).size'), 94);
    assert.equal(f.run('POKEMON_DATA.length'), 140);
    assert.equal(f.run('POKEMON_DATA.some(entry => [1, 793, 794, 795, 796, 797, 798, 799, 803, 804, 805, 806].includes(entry.dexId))'), false);
    assert.equal(f.run('[151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649, 719, 720, 721, 801, 802, 807, 808, 809, 893, 1025].every(id => POKEMON_DATA.some(entry => entry.dexId === id))'), true);
    assert.equal(f.run('POKEMON_DATA.some(entry => entry.slug === "mega-mewtwo-x")'), true);
    assert.equal(f.run('POKEMON_DATA.some(entry => entry.slug === "articuno-galarian")'), true);
    const count = f.run('POKEMON_DATA.length');
    for (let index = 0; index < count; index++) {
      f.run(`Math.random = () => (${index} + 0.5) / ${count}`);
      await f.run('handleStart()');
      assert.equal(f.run('pokemon.slug'), f.run(`POKEMON_DATA[${index}].slug`));
      const latestFile = latestBackgrounds[f.run('pokemon.slug')];
      if (latestFile) {
        assert.equal(f.elements.get('screen-background').src, `./assets/backgrounds/special/${latestFile}.webp`);
      }
      if (f.run('pokemon.slug') === 'celebi') {
        assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/special/celebi.webp');
      }
      if (f.run('pokemon.slug') === 'necrozma-dusk-mane') {
        assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/special/solgaleo.webp');
      }
      if (f.run('pokemon.slug') === 'necrozma-dawn-wings') {
        assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/special/lunala.webp');
      }
    }
    f.run('localStorage.setItem("pokemon-collection-preview-v1", "[]"); Math.random = () => 0');
    await f.run('handleStart()');
    assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/special/articuno.webp');
    f.run('advance()'); await f.waitState('capture-choice');
    await f.run('capturePokemon()');
    assert.equal(f.run('collectionSnapshot.used'), 1);
    assert.equal(f.run('localStorage.getItem("pokemon-collection-preview-v1")'), '[]');
    assert.equal(f.run('JSON.parse(localStorage.getItem("legendary-test:pokemon-collection-preview-v1"))[0].slug'), 'articuno');
    assert.match(f.elements.get('collection-status').textContent, /전설·환상 전용 테스트/);
  }
});
test('등장→포획 질문→아니오→다시 뽑기, 차감 없음', async () => {
  const f = await fixture(); await f.run('handleStart()');
  assert.equal(f.run('state'), 'result'); f.run('advance()'); await f.waitState('capture-choice');
  assert.equal(f.elements.get('choice-yes').textContent, '잡는다');
  f.run('quit()'); assert.equal(f.run('state'), 'choice'); assert.equal(f.run('collectionSnapshot.used'), 0);
  f.run('quit()'); assert.equal(f.run('state'), 'idle'); assert.equal(f.elements.get('home-menu').hidden, false);
});
test('포획 중 단축키·리셋 중복 방지, 저장 후 볼 점등, 도감과 3회 한도', async () => {
  const f = await fixture();
  for (let i = 1; i <= 3; i++) {
    await f.run('handleStart()');
    f.run(`pokemon = {...POKEMON_DATA[${i - 1}], name: POKEMON_DATA[${i - 1}].ko, isShiny: false}`);
    f.run('advance()'); await f.waitState('capture-choice');
    const capture = f.run('capturePokemon()');
    f.run('handleStart(); advance(); reset()'); assert.equal(f.run('state'), 'capturing');
    await capture; assert.equal(f.run('state'), 'captured');
    assert.equal(f.run('collectionSnapshot.used'), i);
    assert.equal(f.elements.get('daily-catches').children.filter(el => el.classList.contains('caught')).length, i);
    f.run('advance()');
    if (i === 3) {
      assert.equal(f.run('state'), 'today-complete');
      assert.equal(f.elements.get('dialogue-text').textContent, '오늘은 3마리를 모두 잡았어요!\n내일 또 잡으러 와주세요.');
      f.run('advance()');
    }
    assert.equal(f.run('state'), 'choice');
  }
  await f.run('handleStart()'); f.run('advance()'); await f.waitState('choice');
  assert.equal(f.elements.get('dialogue-text').textContent, '다시 한 번\n뽑으시겠습니까?');
  f.run('quit()'); await f.run('openBook()');
  assert.ok(f.elements.get('book-list').children.length > 1000);
  assert.equal(f.elements.get('book-summary').textContent, '수집 3종');
  assert.equal(f.elements.has('book-caught-count'), false);
  assert.match(f.elements.get('book-selected-name').textContent, /이상해씨$/);
  assert.match(f.elements.get('book-caught-date').textContent, /^\d{4}\.\d{2}\.\d{2}$/);
  f.run('selectBookEntry(bookEntries.findIndex(item => !item.record))');
  assert.equal(f.elements.get('book-caught-date').textContent, '미수집');
  assert.equal(f.elements.get('book-image').hidden, true);
  f.elements.get('book-filter').events.click();
  assert.equal(f.elements.get('book-filter').attributes['aria-pressed'], 'true');
  assert.equal(f.elements.get('book-list').children.length, 3);
  assert.ok(f.run('bookEntries.every(item => item.record)'));
  assert.match(f.elements.get('book-caught-date').textContent, /^\d{4}\.\d{2}\.\d{2}$/);
  await f.run('openBook()');
  assert.equal(f.elements.get('book-list').children.length, 3);
  f.elements.get('book-filter').events.click();
  assert.equal(f.elements.get('book-filter').attributes['aria-pressed'], 'false');
  assert.ok(f.elements.get('book-list').children.length > 1000);
});

test('이미 잡은 포켓몬은 포획 질문을 건너뛰고 다시 뽑기 표시', async () => {
  const f = await fixture();
  await f.run('handleStart()'); f.run('advance()'); await f.waitState('capture-choice');
  await f.run('capturePokemon()'); f.run('advance()');
  await f.run('handleStart()'); f.run('advance()'); await f.waitState('choice');
  assert.equal(f.run('collectionSnapshot.used'), 1);
  assert.equal(f.elements.get('dialogue-text').textContent, '다시 한 번\n뽑으시겠습니까?');
  await f.run('capturePokemon()'); assert.equal(f.run('collectionSnapshot.used'), 1);
});

test('빈 도감에서 수집만 보기와 전체 보기 전환', async () => {
  const f = await fixture(); await f.run('openBook()');
  f.elements.get('book-filter').events.click();
  assert.equal(f.elements.get('book-list').children.length, 0);
  assert.equal(f.elements.get('book-list-empty').hidden, false);
  assert.equal(f.elements.get('book-caught-date').textContent, '—');
  assert.equal(f.elements.get('book-image').hidden, true);
  f.elements.get('book-filter').events.click();
  assert.ok(f.elements.get('book-list').children.length > 1000);
  assert.equal(f.elements.get('book-list-empty').hidden, true);
});

test('출력 화면 클릭으로 대사 진행, 선택 중 빈 화면 및 버튼 전파 클릭은 무시', async () => {
  const f = await fixture(); await f.run('handleStart()');
  const clickScreen = target => f.elements.get('screen').events.click({ target: { closest: () => target || null } });
  clickScreen(); await f.waitState('capture-choice');
  assert.match(f.elements.get('dialogue-text').textContent, /이 포켓몬을 잡을까요/);
  clickScreen(); assert.equal(f.run('state'), 'capture-choice');
  assert.equal(f.run('collectionSnapshot.used'), 0);
  await f.run('capturePokemon()'); assert.equal(f.run('state'), 'captured');
  clickScreen(f.elements.get('choice-yes'));
  assert.equal(f.run('state'), 'captured');
  clickScreen(); assert.equal(f.run('state'), 'choice');
  assert.equal(f.elements.get('dialogue-text').textContent, '다시 한 번\n뽑으시겠습니까?');
  clickScreen(); assert.equal(f.run('state'), 'choice');
  f.run('quit()'); await f.run('openBook()');
  clickScreen(f.elements.get('collection-book'));
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.elements.get('collection-book').hidden, false);
});
test('관동 썬더 전용 배경 우선, 색이 다른 개체 공유, 지역폼 및 다음 화면 분리', async () => {
  const f = await fixture();
  const background = f.elements.get('screen-background');
  f.run("updateBackground(POKEMON_DATA.find(entry => entry.slug === 'zapdos'))");
  assert.equal(background.src, './assets/backgrounds/special/zapdos.webp');
  f.run("updateBackground({...POKEMON_DATA.find(entry => entry.slug === 'zapdos'), isShiny: true})");
  assert.equal(background.src, './assets/backgrounds/special/zapdos.webp');
  f.run("updateBackground(POKEMON_DATA.find(entry => entry.slug === 'zapdos-galarian'))");
  assert.equal(background.src, './assets/backgrounds/special/zapdos-galarian.webp');
  assert.equal(f.elements.get('screen').dataset.backgroundPokemon, 'zapdos-galarian');
  f.run("updateBackground(POKEMON_DATA.find(entry => entry.slug === 'squirtle'))");
  assert.equal(background.src, './assets/backgrounds/water.webp');
  f.run('updateBackground()');
  assert.equal(background.hidden, true);
  assert.ok(fs.statSync(new URL('../../assets/backgrounds/special/zapdos.webp', import.meta.url)).size > 0);
});

test('전용 배경 83개로 현재 201개 항목 표시, 폼별 배경 구분과 미등록 폼 제외', async () => {
  const f = await fixture();
  const expected = {
    zapdos: 'zapdos', articuno: 'articuno', moltres: 'moltres',
    raikou: 'raikou', entei: 'entei', suicune: 'suicune', lugia: 'lugia', 'ho-oh': 'ho-oh',
    latias: 'latias-latios', latios: 'latias-latios', 'mega-latias': 'latias-latios', 'mega-latios': 'latias-latios',
    kyogre: 'kyogre', 'primal-kyogre': 'kyogre', groudon: 'groudon', 'primal-groudon': 'groudon',
    rayquaza: 'rayquaza', 'mega-rayquaza': 'rayquaza', jirachi: 'jirachi'
  };
  const addedGroups = {
    gigantamax: [
      'venusaur-gigantamax', 'charizard-gigantamax', 'blastoise-gigantamax', 'butterfree-gigantamax',
      'pikachu-gigantamax', 'meowth-gigantamax', 'machamp-gigantamax', 'gengar-gigantamax',
      'kingler-gigantamax', 'lapras-gigantamax', 'eevee-gigantamax', 'snorlax-gigantamax',
      'garbodor-gigantamax', 'melmetal-gigantamax', 'rillaboom-gigantamax', 'cinderace-gigantamax',
      'inteleon-gigantamax', 'corviknight-gigantamax', 'orbeetle-gigantamax', 'drednaw-gigantamax',
      'coalossal-gigantamax', 'flapple-gigantamax', 'appletun-gigantamax', 'sandaconda-gigantamax',
      'toxtricity-gigantamax', 'centiskorch-gigantamax', 'hatterene-gigantamax', 'grimmsnarl-gigantamax',
      'alcremie-gigantamax', 'copperajah-gigantamax', 'duraludon-gigantamax',
      'urshifu-rapid-strike-gigantamax', 'urshifu-single-strike-gigantamax'
    ],
    'paradox-ancient': ['great-tusk', 'scream-tail', 'brute-bonnet', 'flutter-mane', 'slither-wing', 'sandy-shocks', 'roaring-moon', 'walking-wake', 'gouging-fire', 'raging-bolt'],
    'paradox-future': ['iron-treads', 'iron-bundle', 'iron-hands', 'iron-jugulis', 'iron-moth', 'iron-thorns', 'iron-valiant', 'iron-leaves', 'iron-boulder', 'iron-crown'],
    terapagos: ['terapagos', 'terapagos-terastal'],
    'calyrex-glastrier-calyrex-ice-rider': ['calyrex', 'glastrier', 'calyrex-ice-rider'],
    'spectrier-calyrex-shadow-rider': ['spectrier', 'calyrex-shadow-rider'],
    heatran: ['heatran', 'mega-heatran'], magearna: ['magearna', 'mega-magearna'],
    'meltan-melmetal': ['meltan', 'melmetal'],
    regidrago: ['regidrago'], regieleki: ['regieleki'], volcanion: ['volcanion'],
    zygarde: ['mega-zygarde', 'zygarde-10-forme', 'zygarde-50-forme', 'zygarde-complete-forme'],
    typenullsilvally: ['type-null', 'silvally'],
    chienpao: ['chien-pao'], chiyu: ['chi-yu'], tinglu: ['ting-lu'], wochien: ['wo-chien'],
    ogerpon: ['ogerpon-cornerstone-mask', 'ogerpon-hearthflame-mask', 'ogerpon-teal-mask', 'ogerpon-wellspring-mask'],
    'articuno-galarian': ['articuno-galarian'], 'zapdos-galarian': ['zapdos-galarian'], 'moltres-galarian': ['moltres-galarian'],
    eternatus: ['eternatus'], kubfu: ['kubfu'], necrozma: ['necrozma'], reshiram: ['reshiram'],
    'urshifu-rapid-strike': ['urshifu-rapid-strike'],
    'urshifu-single-strike': ['urshifu-single-strike'],
    zacian: ['zacian-crowned-sword', 'zacian-hero-of-many-battles'],
    zamazenta: ['zamazenta-crowned-shield', 'zamazenta-hero-of-many-battles'],
    koraidon: ['koraidon'], kyurem: ['kyurem', 'black-kyurem', 'white-kyurem'],
    mew: ['mew'], miraidon: ['miraidon'], zekrom: ['zekrom'],
    'okidogi-munkidori-fezandipiti-pecharunt': ['okidogi', 'munkidori', 'fezandipiti', 'pecharunt'],
    'uxie-mesprit-azelf': ['uxie', 'mesprit', 'azelf'], zeraora: ['zeraora', 'mega-zeraora'],
    'tornadus-thundurus-landorus-enamorus': ['tornadus-incarnate', 'tornadus-therian', 'thundurus-incarnate', 'thundurus-therian', 'landorus-incarnate', 'landorus-therian', 'enamorus-incarnate', 'enamorus-therian'],
    tapu: ['tapu-koko', 'tapu-lele', 'tapu-bulu', 'tapu-fini'],
    'cobalion-terrakion-virizion-keldeo-keldeo-resolute': ['cobalion', 'terrakion', 'virizion', 'keldeo'],
    lunala: ['lunala', 'necrozma-dawn-wings'], marshadow: ['marshadow'], solgaleo: ['solgaleo', 'necrozma-dusk-mane'],
    regice: ['regice'], regirock: ['regirock'], registeel: ['registeel'],
    shaymin: ['shaymin-land-forme', 'shaymin-sky-forme'], ultranecrozma: ['ultra-necrozma'],
    xerneas: ['xerneas'], yveltal: ['yveltal'],
    arceus: ['arceus'], celebi: ['celebi'], cresselia: ['cresselia'],
    darkrai: ['darkrai', 'mega-darkrai'],
    deoxys: ['deoxys', 'deoxys-attack-forme', 'deoxys-defense-forme', 'deoxys-speed-forme'],
    dialga: ['dialga'], diancie: ['diancie', 'mega-diancie'], genesect: ['genesect'],
    giratina: ['giratina-another-forme', 'giratina-origin-forme'], 'hoopa-confined': ['hoopa-confined', 'hoopa-unbound'],
    'manaphy-phione': ['manaphy', 'phione'], 'meloetta-aria': ['meloetta-aria'], 'meloetta-pirouette': ['meloetta-pirouette'],
    mewtwo: ['mewtwo', 'mega-mewtwo-x', 'mega-mewtwo-y'], palkia: ['palkia'], regigigas: ['regigigas'],
    victini: ['victini'], zarude: ['zarude'],
    'ultra-beast': ['cosmog', 'cosmoem', 'nihilego', 'buzzwole', 'pheromosa', 'xurkitree', 'celesteela', 'kartana', 'guzzlord', 'poipole', 'naganadel', 'stakataka', 'blacephalon']
  };
  for (const [file, slugs] of Object.entries(addedGroups)) {
    for (const slug of slugs) expected[slug] = file;
  }
  assert.equal(Object.keys(expected).length, 201);
  for (const [slug, file] of Object.entries(expected)) {
    assert.ok(f.run(`POKEMON_DATA.find(entry => entry.slug === ${JSON.stringify(slug)})`), slug);
    for (const isShiny of [false, true]) {
      f.run(`updateBackground({...POKEMON_DATA.find(entry => entry.slug === ${JSON.stringify(slug)}), isShiny: ${isShiny}})`);
      assert.equal(f.elements.get('screen-background').src, `./assets/backgrounds/special/${file}.webp`, slug);
      assert.equal(f.elements.get('screen').dataset.backgroundPokemon, slug);
    }
  }
  for (const slug of ['squirtle', 'frigibax']) {
    assert.ok(f.run(`POKEMON_DATA.find(entry => entry.slug === ${JSON.stringify(slug)})`), slug);
    f.run(`updateBackground(POKEMON_DATA.find(entry => entry.slug === ${JSON.stringify(slug)}))`);
    assert.equal(f.elements.get('screen').dataset.backgroundPokemon, '');
    assert.ok(!f.elements.get('screen-background').src.includes('/special/'));
  }
  for (const file of new Set(Object.values(expected))) {
    const bytes = fs.readFileSync(new URL(`../../assets/backgrounds/special/${file}.webp`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF', file);
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP', file);
  }
  assert.equal(f.run("POKEMON_DATA.some(entry => entry.slug === 'keldeo-resolute')"), false);
  f.run("updateBackground({slug: 'keldeo-resolute', dexId: 647})");
  assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/special/cobalion-terrakion-virizion-keldeo-keldeo-resolute.webp');
});

test('히스이폼 16종은 뽑기 화면과 수집 기록에서 해당 폼의 타입 배경 사용', async () => {
  const f = await fixture();
  const expected = {
    'growlithe-hisuian': 'fire', 'arcanine-hisuian': 'fire',
    'voltorb-hisuian': 'electric', 'electrode-hisuian': 'electric',
    'typhlosion-hisuian': 'fire', 'qwilfish-hisuian': 'dark',
    'sneasel-hisuian': 'fight', 'samurott-hisuian': 'water',
    'lilligant-hisuian': 'leaf-bug', 'zorua-hisuian': 'normal',
    'zoroark-hisuian': 'normal', braviaryhisuian: 'psychic',
    'sliggoo-hisuian': 'steel', 'goodra-hisuian': 'steel',
    'avalugg-hisuian': 'ice', 'decidueye-hisuian': 'leaf-bug'
  };
  assert.equal(f.run("POKEMON_DATA.filter(entry => entry.category === 'hisui').length"), Object.keys(expected).length);
  for (const [slug, id] of Object.entries(expected)) {
    const selector = `POKEMON_DATA.find(entry => entry.slug === ${JSON.stringify(slug)})`;
    f.run(`updateBackground(${selector})`);
    const path = `./assets/backgrounds/${id}.webp`;
    assert.equal(f.elements.get('screen-background').src, path, slug);
    assert.equal(f.elements.get('screen').dataset.backgroundPokemon, '', slug);
    assert.equal(f.run(`PokemonCollection.backgroundFor(${selector}).id`), id, slug);
    assert.ok(fs.statSync(new URL('../../' + path, import.meta.url)).size > 0, slug);
  }
  // 실제 뽑기부터 등장까지 히스이 윈디의 배경을 확인합니다.
  f.run("POKEMON_DATA = [POKEMON_DATA.find(entry => entry.slug === 'arcanine-hisuian')]");
  await f.run('handleStart()');
  assert.equal(f.run('state'), 'result');
  assert.equal(f.run('pokemon.slug'), 'arcanine-hisuian');
  assert.equal(f.elements.get('screen-background').src, './assets/backgrounds/fire.webp');
});

test('메인 스크립트 문법 및 원본 포켓몬 데이터 유지', () => {
  new Function(script);
  const original = JSON.parse(fs.readFileSync(new URL('../../data/pokemon-final-with-forms.json', import.meta.url), 'utf8'));
  const embedded = JSON.parse(html.match(/id="pokemon-data">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded, original);
});

test('파트너 안내는 받침에 따라 과·와를 선택하고 모드 전환 후에도 유지', async () => {
  const f = await fixture();
  for (const [name, expected] of [['파오젠', '과'], ['이브이', '와'], ['피카츄', '와'], ['잠만보', '와'], ['윈디 (히스이)', '와']]) {
    assert.equal(f.run(`companionParticle(${JSON.stringify(name)})`), expected);
  }
  const record = { id: crypto.randomUUID(), slug: 'chien-pao', dexId: 1002, name: '파오젠', isShiny: false, capturedAt: '2026-09-01T00:00:00Z', imageSrc: './images/normal/mr-mime.webp' };
  f.run(`localStorage.setItem('pokemon-collection-preview-v1', ${JSON.stringify(JSON.stringify([record]))})`);
  await f.run('openDisplaySettings()');
  f.elements.get('display-pokemon').value = 'chien-pao:false';
  await f.elements.get('display-save').events.click();
  await f.elements.get('mode-toggle').events.click();
  assert.equal(f.elements.get('dialogue-text').textContent, '파오젠과\n쉬는 중…');
  assert.equal(f.elements.get('sleep-touch').attributes['aria-label'], '파오젠과 놀기');
  await f.elements.get('mode-toggle').events.click();
  assert.equal(f.elements.get('mode-toggle').attributes['aria-label'], '파트너 모드로 전환');
});
