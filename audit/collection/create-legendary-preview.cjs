const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
// 전설 분류: https://bulbapedia.bulbagarden.net/wiki/Legendary_Pok%C3%A9mon
// 도감 번호로 선별하여 현재 데이터에 있는 지역·메가·변화 폼도 포함합니다.
const legendaryDexIds = new Set([
  144, 145, 146, 150,
  243, 244, 245, 249, 250,
  377, 378, 379, 380, 381, 382, 383, 384,
  480, 481, 482, 483, 484, 485, 486, 487, 488,
  638, 639, 640, 641, 642, 643, 644, 645, 646,
  716, 717, 718,
  772, 773, 785, 786, 787, 788, 789, 790, 791, 792, 800,
  888, 889, 890, 891, 892, 894, 895, 896, 897, 898, 905,
  1001, 1002, 1003, 1004, 1007, 1008, 1014, 1015, 1016, 1017, 1024
]);
// 환상 분류: https://bulbapedia.bulbagarden.net/wiki/Mythical_Pok%C3%A9mon
const mythicalDexIds = new Set([
  151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648,
  649, 719, 720, 721, 801, 802, 807, 808, 809, 893, 1025
]);
const testDexIds = new Set([...legendaryDexIds, ...mythicalDexIds]);
let html = fs.readFileSync(path.join(root, 'pokedex.html'), 'utf8');
const dataPattern = /(<script[^>]*id="pokemon-data"[^>]*>)[\s\S]*?(<\/script>)/;
const embedded = html.match(dataPattern);
if (!embedded) throw new Error('포켓몬 데이터 블록을 찾지 못했습니다.');
const all = JSON.parse(embedded[0].slice(embedded[1].length, -embedded[2].length));
const entries = all.filter(entry => testDexIds.has(entry.dexId));
const speciesCount = new Set(entries.map(entry => entry.dexId)).size;
if (speciesCount !== testDexIds.size) throw new Error('전설·환상 포켓몬 데이터가 빠져 있습니다.');
function replaceOnce(from, to) {
  if (!html.includes(from)) throw new Error('원본 HTML 구조가 변경되었습니다: ' + from.slice(0, 70));
  html = html.replace(from, to);
}
html = html.replace(dataPattern, (_, open, close) => open + '\n' + JSON.stringify(entries, null, 2) + '\n' + close);
replaceOnce('<title>포켓몬 랜덤뽑기 · 도감 스킨</title>', '<title>전설·환상 포켓몬 전용 · 테스트 도감</title>');
replaceOnce('<div class="below">', `<div class="below">\n      <p class="instructions">전설·환상 전용 테스트 · ${speciesCount}종 / 폼 포함 ${entries.length}개<br>전설 ${legendaryDexIds.size}종 + 환상 ${mythicalDexIds.size}종 · 포획은 하루 3마리<br>테스트 기록은 이 브라우저에 별도로 저장됩니다.</p>`);
// HTTP로 열거나 연결 해시가 있어도 테스트 기록은 전용 LocalStore에만 저장합니다.
replaceOnce("const previewMode = location.protocol === 'file:';", 'const previewMode = true;');
replaceOnce('const collectionStore = previewMode ? new PokemonCollection.LocalStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }) : new PokemonCollection.RemoteStore(workerUrl, databaseId);',
  "const collectionStore = new PokemonCollection.LocalStore({\n      getItem: key => localStorage.getItem('legendary-test:' + key),\n      setItem: (key, value) => localStorage.setItem('legendary-test:' + key, value)\n    });");
replaceOnce('미리보기 · 이 브라우저에 저장됩니다. 노션에는 아직 연결되지 않았어요.', '전설·환상 전용 테스트 · 별도 브라우저 기록 · 오늘 수집 ' + "' + collectionSnapshot.used + ' / 3");
replaceOnce('미리보기 · 이 브라우저에 저장되었습니다.', '전설·환상 전용 테스트 · 별도 브라우저 기록에 저장되었습니다.');
const loading = /    \/\/ HTTP[^\n]*\r?\n    const dataReady = [\s\S]*?\.catch\(\(\) => \{\}\);/;
if (!loading.test(html)) throw new Error('원본 데이터 로딩 블록을 찾지 못했습니다.');
html = html.replace(loading, '    // HTTP에서도 전설·환상만 담은 동봉 데이터를 사용합니다.\n    const dataReady = Promise.resolve();');
fs.writeFileSync(path.join(root, 'pokedex-legendary-test.html'), html, 'utf8');
console.log(`전설·환상 테스트 HTML 생성: ${speciesCount}종 / 폼 포함 ${entries.length}개`);
