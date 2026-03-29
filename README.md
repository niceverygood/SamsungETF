# KODEX ETF AI 챗봇 — FunETF AI

삼성자산운용 KODEX ETF 전문 AI 챗봇. 실시간 시장 데이터와 251개 KODEX ETF 크롤링 데이터를 기반으로 전문 상담을 제공합니다.

## 주요 기능

- **실시간 시세**: 네이버증권 22개 ETF + 야후파이낸스 미국 시장
- **ETF 데이터**: 251개 KODEX ETF 현재가/순자산/보수/수익률/보유종목
- **분배금 실시간 조회**: FunETF API에서 커버드콜 ETF 분배금 이력 수집
- **경쟁사 비교**: TIGER/ACE/SOL 등 1,079개 전체 ETF 데이터 보유
- **PB 셀링 모드**: 판매사 영업 지원 도구 (고객 프로필, PB 멘트 자동생성)
- **투자 시뮬레이터**: 커버드콜 월수입 계산 (옵션프리미엄 비과세 반영)

## 기술 스택

- **Backend**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS
- **AI**: Claude (Opus 4.6 / Sonnet 4) via OpenRouter
- **데이터**: 네이버증권 API, 야후파이낸스 v8 API, FunETF 크롤링
- **배포**: Vercel

## 실행 방법

```bash
# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# OPENROUTER_API_KEY=sk-or-v1-... 입력

# 로컬 실행
node server.js
# http://localhost:3001
```

## 환경변수

| 변수 | 설명 |
|------|------|
| `OPENROUTER_API_KEY` | OpenRouter API 키 (필수) |

## 프로젝트 구조

```
├── api/
│   └── index.js          # Vercel 서버리스 API (채팅, 시세, 계산기)
├── public/
│   ├── index.html         # 메인 HTML
│   ├── app.js             # 채팅 UI 로직
│   ├── chatbot.js         # AI API 호출/스트리밍
│   └── styles.css         # 스타일
├── funetf_output/
│   ├── compact_data.json  # 251개 KODEX ETF 데이터 (크롤링)
│   └── dividend_extra.json # 분배금 데이터
├── server.js              # 로컬 개발 서버
├── funetf_crawler.py      # FunETF 크롤러 (Selenium)
└── vercel.json            # Vercel 배포 설정
```

## 배포

```bash
# GitHub push 시 Vercel 자동 배포
git push origin main
```

Vercel 대시보드에서 `OPENROUTER_API_KEY` 환경변수 설정 필요.

## 라이선스

Private — 바틀 × 삼성자산운용 프로젝트용
