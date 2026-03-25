require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// ===== OpenRouter API Key (환경 변수에서 로드) =====
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.warn('⚠️ OPENROUTER_API_KEY 환경 변수가 설정되지 않았습니다. .env 파일 또는 환경 변수를 설정하세요.');
}

// ===== FunETF 크롤링 데이터 로드 =====
let FUNETF_DATA = null;
try {
    const dataPath = path.join(__dirname, 'funetf_output', 'compact_data.json');
    if (fs.existsSync(dataPath)) {
        FUNETF_DATA = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        console.log(`📦 FunETF 데이터 로드: KODEX ${FUNETF_DATA.kodex_etfs?.length || 0}개, 전체 ETF ${FUNETF_DATA.all_etf_count || 0}개`);
    }
} catch (e) {
    console.error('FunETF 데이터 로드 실패:', e.message);
}

// ===== 분배금 실시간 수집 (캐시 1시간) =====
let _divCache = {};
let _divCacheTime = 0;
const DIV_CACHE_TTL = 3600000;

const DIV_ETF_MAP = {
    '498400': { fundCd: 'K55105EG3659', itemId: 'KR7498400001', fid: '2ETFP4' },
    '498410': { fundCd: 'K55105EF7263', itemId: 'KR7498410000', fid: '2ETFP5' },
    '441640': { fundCd: 'K55105DW2744', itemId: 'KR7441640000', fid: '2ETFC1' },
    '494300': { fundCd: 'K55105EE2919', itemId: 'KR7494300007', fid: '2ETFN1' },
    '379800': { fundCd: 'K55105DF7322', itemId: 'KR7379800006', fid: '2ETFA1' },
    '379810': { fundCd: 'K55105DF7272', itemId: 'KR7379810005', fid: '2ETFA2' },
    '069500': { fundCd: 'KR5105352888', itemId: 'KR7069500007', fid: '2ETF01' },
};

async function enrichETFWithLiveDiv(etf) {
    const info = DIV_ETF_MAP[etf.code];
    if (!info) return;
    if (_divCache[etf.code] && Date.now() - _divCacheTime < DIV_CACHE_TTL) {
        applyDivData(etf, _divCache[etf.code]); return;
    }
    try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const url = `https://www.funetf.co.kr/api/public/product/view/etfdividend?gijunYmd=${today}&jangYmd=${today}&itemId=${info.itemId}&fid=${info.fid}&fundCd=${info.fundCd}&repFundCd=${info.fundCd}&roleGroupType=ANONYMOUS&roleType=ROLE_ANONYMOUS`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.funetf.co.kr/' } });
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            _divCache[etf.code] = data;
            _divCacheTime = Date.now();
            applyDivData(etf, data);
        }
    } catch (e) { /* skip */ }
}

function applyDivData(etf, divData) {
    const sorted = divData.sort((a, b) => (b.gijunYmd || '').localeCompare(a.gijunYmd || ''));
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    const recent12m = sorted.filter(d => d.gijunYmd >= cutoff);
    const annualDiv = recent12m.reduce((sum, d) => sum + (d.divAmt || 0), 0);
    etf.distributions = sorted.slice(0, 8).map(d => ({ date: d.gijunYmd, amount: d.divAmt, rate: d.divRt || 0, payDate: d.payDt || '' }));
    etf.annualDividend = Math.round(annualDiv);
    etf.dividendYield = etf.price > 0 ? Math.round(annualDiv / etf.price * 10000) / 100 : null;
    etf.divFrequency = recent12m.length >= 10 ? '월배당' : (recent12m.length >= 3 ? '분기배당' : '연배당');
}

function getFunETFSummary(naverLive) {
    if (!FUNETF_DATA?.kodex_etfs) return '';
    const nav = naverLive || {};
    const top20 = [...FUNETF_DATA.kodex_etfs].sort((a, b) => b.popularity - a.popularity).slice(0, 20);
    let s = '\n\n## KODEX ETF 데이터 (인기순 Top 20, 실시간 시세 반영)\n';
    s += '| # | ETF명 | 현재가 | 등락률 | 순자산(억) | 보수 | 3개월 | 1년 |\n|---|-------|--------|--------|-----------|------|-------|------|\n';
    top20.forEach((etf, i) => {
        const live = nav[etf.name];
        const price = live ? live.price : (etf.price ? Number(etf.price).toLocaleString() : '-');
        const chg = live ? `${live.changeRate}%` : '-';
        const aum = etf.aum ? Math.round(etf.aum).toLocaleString() : '-';
        const fee = etf.fee != null ? `${etf.fee}%` : '-';
        const r3 = etf.return3m != null ? `${etf.return3m > 0 ? '+' : ''}${etf.return3m}%` : '-';
        const r1y = etf.return1y != null ? `${etf.return1y > 0 ? '+' : ''}${etf.return1y}%` : '-';
        s += `| ${i + 1} | ${etf.name} | ${price} | ${chg} | ${aum} | ${fee} | ${r3} | ${r1y} |\n`;
    });
    s += `\n총 KODEX ETF: ${FUNETF_DATA.kodex_count || FUNETF_DATA.kodex_etfs.length}개 / 전체 시장 ETF: ${FUNETF_DATA.all_etf_count}개`;
    s += naverLive ? '\n※ 현재가=네이버 실시간' : '\n※ 현재가=크롤링 시점';
    return s;
}

function getRelevantETFData(userMessage, naverLive) {
    if (!FUNETF_DATA?.kodex_etfs) return '';
    const msg = userMessage.toLowerCase();
    const nav = naverLive || {};
    const matched = [];

    for (const etf of FUNETF_DATA.kodex_etfs) {
        const shortName = etf.name.replace('KODEX ', '').toLowerCase();
        if (msg.includes(shortName) && shortName.length >= 2) matched.push(etf);
    }

    const CATEGORY_KEYWORDS = {
        '커버드콜': e => e.name.includes('커버드콜'),
        '배당': e => e.name.includes('배당') || e.name.includes('고배당'),
        '반도체': e => e.name.includes('반도체'),
        '로봇': e => e.name.includes('로봇') || e.name.includes('휴머노이드'),
        '우주': e => e.name.includes('우주'),
        '2차전지': e => e.name.includes('2차전지') || e.name.includes('배터리'),
        '채권': e => e.category === '채권' || e.name.includes('채권'),
        '금': e => e.name.includes('골드') || e.name.includes('금선물'),
        'ai': e => e.name.toLowerCase().includes('ai') || e.name.includes('인공지능'),
        '레버리지': e => e.name.includes('레버리지'),
        '인버스': e => e.name.includes('인버스'),
        '미국': e => e.name.includes('미국'),
        's&p': e => e.name.toLowerCase().includes('s&p') || e.name.includes('S&P'),
        '나스닥': e => e.name.includes('나스닥'),
    };

    for (const [keyword, filter] of Object.entries(CATEGORY_KEYWORDS)) {
        if (msg.includes(keyword)) {
            const categoryETFs = FUNETF_DATA.kodex_etfs.filter(filter)
                .sort((a, b) => b.popularity - a.popularity).slice(0, 5);
            for (const e of categoryETFs) {
                if (!matched.find(m => m.code === e.code)) matched.push(e);
            }
        }
    }

    if (matched.length === 0) return '';
    const unique = matched.slice(0, 10);
    const isCompare = /비교|vs|차이|뭐가 (?:다르|나아|좋아)|어떤 게/.test(msg);

    let s = '\n\n## 🔍 질문 관련 KODEX ETF 상세 데이터\n';

    if (isCompare && unique.length >= 2) {
        s += '\n### [비교 모드] 아래 ETF를 표로 비교해서 답변하세요\n';
        s += '| 항목 |'; unique.slice(0, 4).forEach(e => { s += ` ${e.name} |`; }); s += '\n|------|'; unique.slice(0, 4).forEach(() => { s += '------|'; });
        const rows = [
            ['종목코드', e => e.code], ['현재가', e => { const l = nav[e.name]; return l ? l.price : (e.price?.toLocaleString() + '원'); }],
            ['순자산(억)', e => e.aum ? Math.round(e.aum).toLocaleString() : '-'], ['총보수', e => e.fee != null ? e.fee + '%' : '-'],
            ['1개월', e => e.return1m != null ? e.return1m + '%' : '-'], ['3개월', e => e.return3m != null ? e.return3m + '%' : '-'],
            ['1년', e => e.return1y != null ? e.return1y + '%' : '-'], ['과세', e => e.taxType || '-'],
            ['상위종목', e => e.top3Holdings?.map(h => h.name).join(', ') || '-'],
            ['연간분배금', e => e.annualDividend ? e.annualDividend + '원' : '-'], ['배당률', e => e.dividendYield ? e.dividendYield + '%' : '-'],
        ];
        for (const [label, fn] of rows) { s += `\n| ${label} |`; unique.slice(0, 4).forEach(e => { s += ` ${fn(e)} |`; }); }
        s += '\n';
    } else {
        for (const etf of unique) {
            const live = nav[etf.name];
            const price = live ? live.price : (etf.price ? Number(etf.price).toLocaleString() + '원' : '-');
            const chg = live ? ` (${live.changeRate}%)` : '';
            s += `\n### ${etf.name} (${etf.code})\n`;
            s += `- 현재가: ${price}${chg}\n`;
            s += `- 순자산: ${etf.aum ? Math.round(etf.aum).toLocaleString() + '억원' : '-'}\n`;
            s += `- 총보수: ${etf.fee != null ? etf.fee + '%' : '-'}\n`;
            s += `- 수익률: 1개월 ${etf.return1m ?? '-'}% / 3개월 ${etf.return3m ?? '-'}% / 6개월 ${etf.return6m ?? '-'}% / 1년 ${etf.return1y ?? '-'}%\n`;
            s += `- 유형: ${etf.category}/${etf.subCategory} | ${etf.type} | 과세: ${etf.taxType || '-'}\n`;
            s += `- 환헤지: ${etf.hedged ? '예(H)' : '아니오'}\n`;
            if (etf.top3Holdings?.length) s += `- 상위 보유종목: ${etf.top3Holdings.map(h => `${h.name}(${h.weight}%)`).join(', ')}\n`;
            if (etf.annualDividend) s += `- 연간 분배금: ${etf.annualDividend}원 (배당률 ${etf.dividendYield ?? '-'}%)\n`;
            if (etf.distributions?.length) s += `- 최근 분배 이력: ${etf.distributions.slice(0, 4).map(d => `${d.date.slice(0,4)}.${d.date.slice(4,6)} ${d.amount}원`).join(' / ')}\n`;
        }
    }
    return s;
}

// ===== Tri-Model Configuration =====
const AI_MODELS = {
    claude: {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        shortName: 'Claude',
        icon: '🧠',
        color: '#8B5CF6',
        description: '빠르고 정확한 분석',
        strength: '금융 약관이나 복잡한 ETF 구조를 빠르고 정확하게 분석',
        maxTokens: 16000,
        temperature: 0.7,
    },
    gpt: {
        id: 'openai/gpt-5.4-pro',
        name: 'GPT-5.4 Pro',
        shortName: 'GPT',
        icon: '⚡',
        color: '#10B981',
        description: '데이터 처리 & 멀티모달',
        strength: '차트 분석이나 대량의 수익률 시뮬레이션 등 수치 중심 작업에서 최고 안정성',
        maxTokens: 16000,
        temperature: 0.6,
    },
    gemini: {
        id: 'google/gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro',
        shortName: 'Gemini',
        icon: '💎',
        color: '#3B82F6',
        description: '초거대 컨텍스트 (1M+)',
        strength: '여러 ETF 투자설명서를 한꺼번에 읽고 비교 분석할 때 압도적',
        maxTokens: 16000,
        temperature: 0.7,
    }
};

// ===== Smart Router: 질문 분석 → 최적 모델 자동 선택 =====
function smartRouteModel(userMessage) {
    const msg = userMessage.toLowerCase();

    // GPT-5.4 Pro: 수치, 비교, 차트, 시뮬레이션 관련
    const gptKeywords = [
        '수익률', '비교', '차트', '시뮬레이션', '계산', '수치',
        '얼마', '몇 %', '퍼센트', '보수', '총보수', '수수료',
        '가격', '시세', '현재가', '전일대비', '거래량', '순자산',
        '배당금', '분배금', '수익', '손익', '변동성', '상관계수',
        '백테스트', '성과', '통계', '데이터', 'top', '순위',
        '얼마나', '몇개', '몇 개'
    ];

    // Gemini 3.1 Pro: 여러 ETF 비교, 종합 분석, 긴 설명
    const geminiKeywords = [
        '비교 분석', '총정리', '전체', '모든', '종합',
        '여러', '다양한', '라인업', '포트폴리오',
        '자산배분', '리밸런싱', '투자설명서', '약관',
        '전략 비교', '한눈에', '요약', '정리해줘',
        '카테고리', '분류', '유형별', '섹터별',
        '장단점', '각각', '하나씩'
    ];

    // Claude 4.6 Opus: 논리적 설명, 구조 분석, 전략 (기본값)
    const claudeKeywords = [
        '설명', '구조', '원리', '메커니즘', '어떻게',
        '왜', '이유', '전략', '추천', '조언', '의견',
        '커버드콜', '레버리지', '인버스', '선물', '옵션',
        '초보', '입문', '기초', '개념', '뭐야', '알려줘',
        '어떤', '좋을까', '괜찮을까', '적합', '맞는'
    ];

    // 점수 기반 라우팅
    let scores = { claude: 0, gpt: 0, gemini: 0 };

    gptKeywords.forEach(kw => { if (msg.includes(kw)) scores.gpt += 1; });
    geminiKeywords.forEach(kw => { if (msg.includes(kw)) scores.gemini += 1; });
    claudeKeywords.forEach(kw => { if (msg.includes(kw)) scores.claude += 1; });

    // 여러 ETF 이름이 포함되면 Gemini 보너스
    const etfMentions = (msg.match(/kodex/gi) || []).length;
    if (etfMentions >= 3) scores.gemini += 3;
    else if (etfMentions >= 2) scores.gemini += 1;

    // 숫자가 많으면 GPT 보너스
    const numberCount = (msg.match(/\d+/g) || []).length;
    if (numberCount >= 3) scores.gpt += 2;

    // 최고 점수 모델 선택 (동점 시 Claude 우선)
    const maxScore = Math.max(scores.claude, scores.gpt, scores.gemini);
    if (maxScore === 0) return 'claude'; // 기본값

    if (scores.gemini === maxScore && scores.gemini > scores.claude) return 'gemini';
    if (scores.gpt === maxScore && scores.gpt > scores.claude) return 'gpt';
    return 'claude';
}

// ===== System Prompt =====
const SYSTEM_PROMPT = `# 삼성자산운용 KODEX ETF 챗봇 시스템 프롬프트 v1.0

## 역할 정의
너는 삼성자산운용 KODEX ETF 전문 상담 AI다. 투자자의 ETF 관련 질문에 정확하고 실용적인 답변을 제공한다.

**핵심 원칙:**
- **실시간 데이터 최우선**: 아래에 제공되는 실시간 시세·크롤링 데이터의 수치를 반드시 우선 인용. 하드코딩 수치와 다르면 실시간 데이터가 정답
- 정확성 > 친절함. 틀린 정보를 친절하게 전달하는 것보다 정확한 정보를 전달하는 것이 우선
- 모르는 것은 모른다고 말한다. 추측으로 숫자를 지어내지 않는다
- 세금, 제도 관련 답변 시 반드시 근거 법령 또는 공시를 언급한다
- 투자 권유가 아닌 정보 제공임을 명확히 한다
- 항상 한국어, 이모지 적극 활용, HTML 태그(p, strong, ul, ol, li, table, tr, th, td) 사용

## 1. ETF 과세 체계 (가장 중요 — 오류 빈발 영역)

### 1-1. 국내주식형 ETF (KODEX 200, KODEX 200타겟위클리커버드콜 등)
**매매차익:** 비과세 (국내 장내 파생상품 매매차익 포함). 레버리지/인버스 ETF는 제외 (기타 ETF 분류)
**분배금:** 과세 대상 = MIN(분배금, 과표기준가격 상승분) × 15.4%. 과표기준가격이 오르지 않았으면 분배금을 받아도 세금 0원 가능

**국내주식 커버드콜 ETF 분배금 과세 구조 (매우 중요):**
- 분배금 재원 = 배당 수익(과세) + 옵션 프리미엄 수익(비과세, 소득세법 시행령 제26조의2 제4항)
- 예시: 분배금 연간 15% → 배당 약 5%(과세) + 옵션 프리미엄 약 10%(비과세)
- 단, 과세소득(배당)이 먼저 분배되므로 배당 시즌(1~3월)에는 과세 비중 100%인 달도 있음
- ⚠️ 절대 하지 말 것: 국내주식형 커버드콜 분배금 전액에 15.4% 일괄 적용

### 1-2. 해외주식형 ETF (KODEX 미국배당커버드콜액티브 등)
**매매차익:** MIN(매매차익, 과표기준가격 상승분) × 15.4% (배당소득세). 금융소득종합과세 합산
**분배금:** MIN(분배금, 과표기준가격 상승분) × 15.4%. 금융소득종합과세 합산

### 1-3. 해외 직접투자 ETF (미국 상장 JEPI, SCHD 등)
**매매차익:** 양도소득세 22% (연 250만원 공제). 금융소득종합과세 미합산(분리과세)
**분배금:** 미국 원천징수 15% + 국내 추가 과세 없음 (조세조약). 금융소득종합과세 합산

### 1-4. 과세 비교 시 필수 체크
- 금융소득종합과세: 연 2,000만원 (이자+배당 합산)
- 건강보험 피부양자 탈락: 금융소득 연 1,000만원 초과 시 → 지역가입자 건보료 발생
- 이 두 기준은 별개이므로 반드시 둘 다 안내

## 2. 절세 계좌 제도 정보

### 2-1. ISA (2026년 3월 현재 확정 기준)
- 연간 납입한도: 2,000만원 / 총 납입한도: 1억원(5년)
- 의무가입기간: 3년
- 비과세 한도: 일반형 200만원 / 서민형·농어민형 400만원
- 초과분: 9.9% 분리과세 (종합과세 제외)
- 만기 후 60일 내 연금계좌 이전 시 납입액 10% 세액공제 (최대 300만원)
- ⚠️ ISA 한도 확대(연 4,000만원/총 2억원)는 국회 미통과 — 기정사실처럼 안내 금지
- ⚠️ 국내주식형 ETF는 일반계좌에서도 매매차익 비과세 → ISA에서 별도 이점 제한적

### 2-2. 연금저축 / IRP
- 연금저축: 연 1,800만원 납입한도 (세액공제 대상 최대 900만원, IRP 합산)
- 55세 이후 연금소득세 3.3~5.5% (연간 수령 1,500만원 이하)
- 1,500만원 초과 시 종합과세 또는 16.5% 분리과세 선택
- ⚠️ 함정: 일반계좌에서 비과세인 국내주식형 ETF를 연금계좌에 넣으면, 수령 시 연금소득세 과세 → 오히려 불리

## 3. 커버드콜 ETF 핵심 개념

### 3-1. 분배금 ≠ 수익 (반드시 구분)
- 분배금 지급 시 NAV 차감 → 분배율 20% ≠ 수익률 20%
- 데일리 커버드콜 분배금은 ROC(원금반환) 비율 높을 수 있음
- 반드시 총수익률(가격 변동 + 분배금)으로 통합 평가

### 3-2. 옵션 전략별 차이
- **타겟형**: 매도 비중 시장 상황 따라 조절 → 상승 참여 일부 가능
- **100% 매도형**: 상승분 대부분 포기
- **OTM(외가격)**: ATM 대비 상승 여지 있으나 프리미엄 낮음
- **위클리**: 주 1~5회 만기, 중간 프리미엄
- **데일리**: 매일 만기, 높은 프리미엄 but ROC 주의
- 2026년 금융위 위클리옵션 확대: 코스피200·코스닥150 주 5회, 개별종목 옵션 도입 추진 중

### 3-3. 변동성(IV)과 프리미엄
- VIX 높을 때 → 프리미엄↑ → 분배율↑
- VIX 낮을 때 → 프리미엄↓ → 분배율↓
- 금리 인하기 VIX 하락 시 커버드콜 분배율도 하락 가능

### 3-4. 환율 리스크 (해외자산 기반)
- 미국 기반 커버드콜은 환노출. 원화 강세 시 원화 환산 분배금 감소
- 환헤지 비용: 한미 금리차 기반 연 1~3%
- 환율 10% 변동 → 미국자산 비중만큼 원화 수익에 직접 영향

## 4. ETF 메커니즘 지식

### 4-1. NAV/iNAV/괴리율
- NAV: 기초자산 시가 합계 ÷ 발행좌수, 하루 1회 공시
- iNAV: 10초 단위 실시간 산출
- KODEX는 LP 제도로 괴리율 업계 최저 유지

### 4-2. TR vs PR ETF
- TR: 분배금 자동 재투자 → 과세이연 복리효과
- PR: 분배금 현금 지급 → 매년 15.4% 과세

### 4-3. 레버리지/인버스 메커니즘
- 일별 복리로 장기 보유 시 지수 배수와 괴리 (변동성 잠식)
- 횡보장에서 손실 누적 → 단기 트레이딩용

### 4-4. 환헤지(H) vs 환노출
- 환헤지: 환율 변동 제거, 헤지 비용 발생
- 환노출: 원화 약세 시 추가 수익, 강세 시 손실

## 5. 답변 시 필수 체크리스트

### 계산 문제 포함 시:
- [ ] 국내주식형 vs 해외주식형 과세 구분했는가?
- [ ] 국내주식형 커버드콜의 옵션 프리미엄 비과세 반영했는가?
- [ ] MIN(분배금, 과표기준가격 상승분) 공식 적용했는가?
- [ ] 금융소득종합과세 2,000만원 기준 체크했는가?
- [ ] 건보료 피부양자 탈락(금융소득 1,000만원) 언급했는가?
- [ ] 분배율은 추정치이며 변동 가능함을 명시했는가?
- [ ] NAV 하락 가능성(원금 훼손) 경고했는가?

### ISA/연금 질문 시:
- [ ] 현행 납입한도(연 2,000만원/총 1억원) 안내했는가?
- [ ] 미확정 제도 변경을 기정사실로 안내하지 않았는가?
- [ ] 연금계좌 내 국내주식형 ETF 과세 전환 함정 안내했는가?

### 비교 분석 시:
- [ ] 총수익률(가격+분배금)로 비교했는가?
- [ ] 세후 실수령액으로 비교했는가?
- [ ] 보수(총보수비용비율) 차이 반영했는가?

## 6. 자주 틀리는 패턴

❌ 커버드콜 분배금 전액 과세 → ✅ 옵션 프리미엄 부분은 비과세 (국내주식형)
❌ ISA 한도 4,000만원 안내 → ✅ 현행 2,000만원, 확대안은 국회 미통과
❌ 분배율 = 수익률 → ✅ 분배 시 NAV 차감, 총수익률로 평가
❌ 건보료 기준 누락 → ✅ 금융소득 1,000만원 초과 시 피부양자 탈락 경고

## 7. 응답 포맷

### 답변 순서:
1. **핵심 결론 먼저** — 질문에 대한 직접 답변
2. **근거/계산** — 투명하게, 가정과 실제 구분
3. **주의사항/리스크** — 빠뜨리면 안 되는 경고
4. **후속 질문 추천** — 아래 형식으로 3개:
<div class="follow-up-questions">
<p><strong>💡 이런 것도 물어보세요:</strong></p>
<button class="quick-btn" onclick="sendQuickMessage('후속질문1')">후속질문1</button>
<button class="quick-btn" onclick="sendQuickMessage('후속질문2')">후속질문2</button>
<button class="quick-btn" onclick="sendQuickMessage('후속질문3')">후속질문3</button>
</div>
5. **면책 문구**

### 규칙:
- ETF 상품명은 <strong>으로 강조
- 비교는 반드시 <table> 사용
- 실시간 데이터 제공 시 반드시 인용
- "[비교 모드]" 데이터 제공 시 비교표 활용
- 확실하지 않은 수치는 "약", "추정" 표기
- 세율: 정확한 법정 세율 사용 (15.4%, 9.9%, 22%, 3.3~5.5%)

### 하지 말 것:
- "이걸 사세요" 식 투자 권유
- 미래 수익률 확정 제시
- 분배율을 수익률로 동일시
- 미확정 제도를 기정사실로 안내
- 국내주식형과 해외주식형 과세 동일 취급

## 8. 팩트체크 규칙
- 아래 "질문 관련 ETF 상세 데이터"의 수치를 반드시 우선 사용
- 데이터가 없는 항목은 "상품설명서 확인" 안내
- 데이터 출처 우선순위: ① 실시간 시세 ② 크롤링 데이터 ③ 삼성자산운용 공시 ④ 한국거래소

## 면책 문구
본 정보는 투자 권유가 아닌 참고 목적의 정보 제공이며, 투자 판단의 최종 책임은 투자자에게 있습니다. 분배율은 과거 실적 기반 추정치이며 향후 변동될 수 있고, 투자원금 손실이 발생할 수 있습니다. 세금 관련 사항은 개인별 상황에 따라 달라질 수 있으므로 세무사 상담을 권장합니다.`;

// ===== 네이버 증권 주요 ETF 종목코드 매핑 =====
const NAVER_ETF_CODES = {
    'KODEX 200': '069500',
    'KODEX 레버리지': '122630',
    'KODEX 인버스': '114800',
    'KODEX 반도체': '091160',
    'KODEX 2차전지산업': '305720',
    'KODEX 삼성전자': '069660',
    'KODEX 코스닥150': '229200',
    'KODEX 미국S&P500TR': '379800',
    'KODEX 미국나스닥100TR': '379810',
    'KODEX 골드선물(H)': '132030',
    'KODEX 은선물(H)': '144600',
    'KODEX 삼성전자채권혼합': '292150',
    'KODEX 200타겟위클리커버드콜': '498400',
    'KODEX 미국S&P500': '379800',
    'KODEX 금융고배당TOP10타겟위클리커버드콜': '498410',
    'KODEX 미국우주항공': '495100',
    'KODEX 미국배당커버드콜액티브': '490600',
    'KODEX 미국나스닥100': '379810',
    'KODEX 미국나스닥100데일리커버드콜OTM': '498580',
    'KODEX AI전력핵심설비': '488420',
    'KODEX 로봇액티브': '445290',
    'KODEX 미국AI전력핵심인프라': '487230',
};

// ===== 야후파이낸스 주요 ETF 티커 매핑 =====
const YAHOO_ETF_TICKERS = {
    'SPY': 'S&P 500 ETF',
    'QQQ': 'Nasdaq 100 ETF',
    'IWM': 'Russell 2000 ETF',
    'SOXX': 'iShares Semiconductor ETF',
    'ARKK': 'ARK Innovation ETF',
    'VTI': 'Vanguard Total Stock Market',
    'VOO': 'Vanguard S&P 500',
    '069500.KS': 'KODEX 200',
    '122630.KS': 'KODEX 레버리지',
    '091160.KS': 'KODEX 반도체',
    '305720.KS': 'KODEX 2차전지산업',
    '379800.KS': 'KODEX 미국S&P500TR',
    '379810.KS': 'KODEX 미국나스닥100TR',
};

// ===== API Routes =====

// 모델 정보 제공 API
app.get('/api/models', (req, res) => {
    const models = Object.entries(AI_MODELS).map(([key, model]) => ({
        key,
        name: model.name,
        shortName: model.shortName,
        icon: model.icon,
        color: model.color,
        description: model.description,
        strength: model.strength,
    }));
    res.json({ success: true, models });
});

// FunETF 크롤링 데이터 API
app.get('/api/funetf/kodex', (req, res) => {
    if (!FUNETF_DATA) {
        return res.json({ success: false, error: 'FunETF 데이터 없음' });
    }
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.q || '').toLowerCase();
    let etfs = FUNETF_DATA.kodex_etfs;
    if (search) {
        etfs = etfs.filter(e => e.name.toLowerCase().includes(search) || (e.tags && e.tags.toLowerCase().includes(search)));
    }
    etfs = etfs.sort((a, b) => b.popularity - a.popularity).slice(0, limit);
    res.json({ success: true, data: etfs, total: FUNETF_DATA.kodex_etfs.length, crawledAt: FUNETF_DATA.crawled_at });
});

app.get('/api/funetf/all', (req, res) => {
    if (!FUNETF_DATA) {
        return res.json({ success: false, error: 'FunETF 데이터 없음' });
    }
    const limit = parseInt(req.query.limit) || 50;
    res.json({ success: true, data: FUNETF_DATA.top_50_all.slice(0, limit), total: FUNETF_DATA.all_etf_count, crawledAt: FUNETF_DATA.crawled_at });
});

// 1. 네이버 증권 API - ETF 시세 조회
app.get('/api/naver/etf/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const url = `https://m.stock.naver.com/api/stock/${code}/basic`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Naver API error: ${response.status}`);
        const data = await response.json();
        res.json({ success: true, data });
    } catch (error) {
        console.error('Naver API Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// 네이버 증권 - ETF 시세 목록 (여러 종목)
app.get('/api/naver/etf-list', async (req, res) => {
    try {
        const results = {};
        const codes = Object.entries(NAVER_ETF_CODES);

        for (const [name, code] of codes) {
            try {
                const url = `https://m.stock.naver.com/api/stock/${code}/basic`;
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                    }
                });
                if (response.ok) {
                    const data = await response.json();
                    results[name] = {
                        code,
                        price: data.closePrice || data.stockEndPrice,
                        change: data.compareToPreviousClosePrice,
                        changeRate: data.fluctuationsRatio,
                        high: data.highPrice,
                        low: data.lowPrice,
                        volume: data.accumulatedTradingVolume,
                        marketCap: data.marketCap,
                    };
                }
            } catch (e) {
                console.error(`Error fetching ${name}:`, e.message);
            }
        }

        res.json({ success: true, data: results, timestamp: new Date().toISOString() });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 2. 야후 파이낸스 API - ETF 시세 조회
app.get('/api/yahoo/quote/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);
        const data = await response.json();

        const result = data.chart?.result?.[0];
        if (!result) throw new Error('No data found');

        const meta = result.meta;
        const quotes = result.indicators?.quote?.[0];
        const timestamps = result.timestamp || [];

        res.json({
            success: true,
            data: {
                symbol: meta.symbol,
                currency: meta.currency,
                regularMarketPrice: meta.regularMarketPrice,
                previousClose: meta.previousClose,
                change: (meta.regularMarketPrice - meta.previousClose).toFixed(2),
                changePercent: (((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2),
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
                chartData: timestamps.map((t, i) => ({
                    date: new Date(t * 1000).toISOString().split('T')[0],
                    close: quotes?.close?.[i],
                    volume: quotes?.volume?.[i]
                }))
            }
        });
    } catch (error) {
        console.error('Yahoo API Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// 야후 파이낸스 - v8 차트 API로 시세 조회
async function yahooChartFetch(symbol) {
    try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!r.ok) return null;
        const d = await r.json();
        const m = d.chart?.result?.[0]?.meta;
        if (!m) return null;
        const prev = m.previousClose || m.chartPreviousClose || m.regularMarketPrice;
        const chg = m.regularMarketPrice - prev;
        return { symbol: m.symbol, name: m.shortName || m.symbol, price: m.regularMarketPrice,
            change: chg.toFixed(2), changePercent: prev ? (chg / prev * 100).toFixed(2) : '0.00', currency: m.currency };
    } catch { return null; }
}

app.get('/api/yahoo/quotes', async (req, res) => {
    try {
        const tickers = (req.query.symbols || 'SPY,QQQ').split(',');
        const results = await Promise.all(tickers.map(s => yahooChartFetch(s.trim())));
        res.json({ success: true, data: results.filter(Boolean), timestamp: new Date().toISOString() });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 3. 시장 개요 (네이버 + 야후 결합)
app.get('/api/market-overview', async (req, res) => {
    try {
        const [naverRes, yahooRes] = await Promise.allSettled([
            fetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }).then(r => r.json()),
            Promise.all(['^GSPC', '^IXIC', '^DJI'].map(s => yahooChartFetch(s)))
        ]);

        const overview = {
            domestic: {},
            global: {},
            timestamp: new Date().toISOString()
        };

        if (naverRes.status === 'fulfilled') {
            const d = naverRes.value;
            overview.domestic.KOSPI = {
                price: d.closePrice,
                change: d.compareToPreviousClosePrice,
                changeRate: d.fluctuationsRatio
            };
        }

        if (yahooRes.status === 'fulfilled') {
            const quotes = yahooRes.value || [];
            quotes.filter(Boolean).forEach(q => {
                overview.global[q.symbol] = {
                    name: q.name,
                    price: q.price,
                    change: q.change,
                    changePercent: q.changePercent
                };
            });
        }

        res.json({ success: true, data: overview });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// 4. OpenRouter AI 챗봇 API (Tri-Model 지원)
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, marketData, modelKey, model: modelChoice, stream: useStream } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: 'messages 배열이 필요합니다.' });
        }

        // sonnet/opus 선택 지원
        const QUICK_MODELS = {
            sonnet: { id: 'anthropic/claude-sonnet-4', name: 'FunETF AI ⚡', icon: '⚡', maxTokens: 16000, temperature: 0.7 },
            opus: { id: 'anthropic/claude-opus-4.6', name: 'FunETF AI 🧠', icon: '🧠', maxTokens: 16000, temperature: 0.7 },
        };

        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        let model;
        if (modelChoice && QUICK_MODELS[modelChoice]) {
            model = QUICK_MODELS[modelChoice];
        } else {
            let selectedKey = modelKey;
            if (!selectedKey || selectedKey === 'auto') {
                selectedKey = smartRouteModel(lastUserMsg);
            }
            model = AI_MODELS[selectedKey] || AI_MODELS.claude;
        }
        console.log(`\n🎯 모델: "${lastUserMsg.substring(0, 30)}..." → ${model.icon} ${model.name}`);

        // 네이버 실시간 시세 수집 (캐시 활용)
        const liveNaver = {};
        if (!marketData) {
            const naverFetches = Object.entries(NAVER_ETF_CODES).map(async ([name, code]) => {
                try {
                    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
                    });
                    if (r.ok) {
                        const d = await r.json();
                        liveNaver[name] = { code, price: d.closePrice || d.stockEndPrice, change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio, volume: d.accumulatedTradingVolume };
                    }
                } catch (e) { /* skip */ }
            });
            await Promise.race([Promise.allSettled(naverFetches), new Promise(r => setTimeout(r, 4000))]);
        }
        const naverData = marketData?.naver || (Object.keys(liveNaver).length > 0 ? liveNaver : null);

        // 분배금 관련 질문이면 실시간 수집
        if (/분배|배당|인컴|월배당|분기배당/.test(lastUserMsg) && FUNETF_DATA?.kodex_etfs) {
            const targets = FUNETF_DATA.kodex_etfs
                .filter(e => e.name.includes('커버드콜') || e.name.includes('배당'))
                .sort((a, b) => b.popularity - a.popularity).slice(0, 5);
            await Promise.allSettled(targets.map(e => enrichETFWithLiveDiv(e)));
        }

        let systemContent = SYSTEM_PROMPT;
        systemContent += getFunETFSummary(naverData);
        systemContent += getRelevantETFData(lastUserMsg, naverData);
        if (naverData && Object.keys(naverData).length > 0) {
            systemContent += '\n\n## 📊 실시간 시장 데이터 (방금 수집)\n';
            systemContent += '| ETF | 현재가 | 등락률 |\n|-----|--------|--------|\n';
            for (const [name, d] of Object.entries(naverData)) {
                systemContent += `| ${name} | ${d.price} | ${d.changeRate}% |\n`;
            }
        } else if (marketData) {
            systemContent += `\n\n## 실시간 시장 데이터 (참고용)\n${JSON.stringify(marketData, null, 2)}`;
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://www.funetf.co.kr',
                'X-Title': 'FunETF AI Chatbot'
            },
            body: JSON.stringify({
                model: model.id,
                messages: [
                    { role: 'system', content: systemContent },
                    ...messages
                ],
                max_tokens: model.maxTokens,
                temperature: model.temperature,
                stream: !!useStream,
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
        }

        if (useStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullReply = '';
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
                    for (const line of lines) {
                        const jsonStr = line.slice(6);
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            const delta = parsed.choices?.[0]?.delta?.content || '';
                            if (delta) { fullReply += delta; res.write(`data: ${JSON.stringify({ content: delta })}\n\n`); }
                        } catch (e) { /* skip */ }
                    }
                }
            } catch (e) { /* stream ended */ }
            res.write(`data: ${JSON.stringify({ done: true, fullReply })}\n\n`);
            res.end();
            return;
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '죄송합니다, 응답을 생성하지 못했습니다.';

        console.log(`${model.icon} 응답 완료 (${data.usage?.completion_tokens || '?'} tokens)`);

        res.json({
            success: true,
            reply,
            modelUsed: {
                key: modelChoice || 'claude',
                name: model.name,
                shortName: model.name,
                icon: model.icon,
                color: '#8B5CF6',
                wasAutoRouted: false,
            },
            usage: data.usage
        });
    } catch (error) {
        console.error('OpenRouter Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ===== Start Server =====
app.listen(PORT, () => {
    console.log(`\n🚀 FunETF AI 챗봇 서버 실행 중!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🤖 Tri-Model AI Engine:`);
    Object.values(AI_MODELS).forEach(m => {
        console.log(`   ${m.icon} ${m.name} (${m.id})`);
    });
    console.log(`📊 네이버증권 API: 활성`);
    console.log(`📈 야후파이낸스 API: 활성\n`);
});
