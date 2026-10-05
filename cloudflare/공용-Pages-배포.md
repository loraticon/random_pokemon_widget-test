# 제작자용 포켓몬 Pages

Pages 프로젝트: pokemon-random-widget. GitHub 저장소: loraticon/random_pokemon_widget-ver1. 공용 도메인: https://pokemon.loraticon.com.

## 빌드

빌드 명령 `npm run build`, 프레임워크 없음, 출력 디렉터리 `dist`를 사용합니다. 루트 wrangler.jsonc는 공용 Pages 전용입니다. 개인 노션 토큰을 이 프로젝트에 등록하지 않습니다.

빌드는 공용 화면·데이터·이미지와 외부 import 없는 단일 개인 `worker.js`를 생성합니다. `cloudflare-Pages-공용화면.zip`은 dist 전체이고 `cloudflare-개인설치.zip`은 worker.js와 설치 안내 두 파일입니다. dist/downloads에서 코드·설치 안내·ZIP을 제공합니다. 사용자가 설치 도구·Node.js·GitHub·Bindings를 사용할 필요는 없습니다. 개발용 Node.js와 Wrangler는 제작자 빌드에만 사용합니다.

## 연결 화면

setup.html은 개인 Worker 주소와 복제한 원본 DB 주소를 입력받습니다. 개인 Worker에 DB 접근 및 네 속성을 확인하고 위젯 설정 페이지를 준비하도록 요청한 뒤, `pokedex.html#worker=개인Worker주소&db=DB식별자`를 생성합니다. 자동 복사를 시도하고 수동 복사 버튼을 유지합니다. 연결 버튼을 누르기 전에는 API를 호출하지 않습니다.

새 안내는 노션 템플릿 복제 → 개인 Worker 코드 붙여넣기와 NOTION_TOKEN Secret 등록 → HTTPS 연결 페이지 → 노션 임베드의 한 가지 흐름입니다. 공개 템플릿 URL은 제공받지 않아 임의의 템플릿 링크는 넣지 않았습니다.

## 데이터와 전환

포획·횟수·중복은 현재 노션 기록에 따릅니다. 오늘 기록 삭제 시 기회를 복구합니다. 위젯 설정은 노션 DB 안의 별도 설정 페이지에 저장하고 도감·횟수에서 제외합니다. 같은 Worker 실행 인스턴스의 저장 요청만 직렬화하며 여러 인스턴스의 동시 포획을 엄격히 보장하지 않습니다.

이 버전은 개인 API의 DB 입력 방식과 저장 구조가 바뀌므로 Pages와 개인 Worker를 모두 배포하고 연결 페이지에서 새 위젯 주소를 생성해야 합니다. 이전 Cloudflare 저장소의 화면 설정은 자동 이전하지 않습니다. 노션 기록과 체크박스는 유지합니다. 이전 Durable Object를 실제로 배포했던 Worker는 보존하고 새 Worker에 설치합니다. Bindings가 비어 있었던 테스트 Worker는 그대로 업데이트할 수 있습니다.

GitHub 반영 후 Cloudflare의 자동 빌드·배포 완료 여부를 따로 확인해야 합니다. 자동 테스트·브라우저 모의 연결·단일 JS 빌드는 실제 개인 계정 설치·노션 연결 검증과 구분합니다.
