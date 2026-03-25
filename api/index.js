const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ===== API Key =====
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ===== FunETF 크롤링 데이터 =====
let FUNETF_DATA = null;
try {
    const paths = [
        path.join(process.cwd(), 'funetf_output', 'compact_data.json'),
        path.join(__dirname, '..', 'funetf_output', 'compact_data.json'),
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            FUNETF_DATA = JSON.parse(fs.readFileSync(p, 'utf8'));
            break;
        }
    }
} catch (e) { console.error('FunETF 로드 실패:', e.message); }

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

async function fetchDividendData(etfCode) {
    if (_divCache[etfCode] && Date.now() - _divCacheTime < DIV_CACHE_TTL) {
        return _divCache[etfCode];
    }
    const info = DIV_ETF_MAP[etfCode];
    if (!info) return null;
    try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const url = `https://www.funetf.co.kr/api/public/product/view/etfdividend?gijunYmd=${today}&jangYmd=${today}&itemId=${info.itemId}&fid=${info.fid}&fundCd=${info.fundCd}&repFundCd=${info.fundCd}&roleGroupType=ANONYMOUS&roleType=ROLE_ANONYMOUS`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.funetf.co.kr/' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            _divCache[etfCode] = data;
            _divCacheTime = Date.now();
            return data;
        }
    } catch (e) { /* skip */ }
    return null;
}

async function enrichETFWithLiveDiv(etf) {
    const code = etf.code;
    const divData = await fetchDividendData(code);
    if (!divData) return;

    const sorted = divData.sort((a, b) => (b.gijunYmd || '').localeCompare(a.gijunYmd || ''));
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoff = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');
    const recent12m = sorted.filter(d => d.gijunYmd >= cutoff);
    const annualDiv = recent12m.reduce((sum, d) => sum + (d.divAmt || 0), 0);

    etf.distributions = sorted.slice(0, 8).map(d => ({
        date: d.gijunYmd, amount: d.divAmt, rate: d.divRt || 0, payDate: d.payDt || ''
    }));
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

    // 1) 직접 이름 매칭
    for (const etf of FUNETF_DATA.kodex_etfs) {
        const name = etf.name.toLowerCase();
        const shortName = name.replace('kodex ', '');
        if (msg.includes(shortName) && shortName.length >= 2) matched.push(etf);
    }

    // 2) 카테고리/테마 키워드 매칭
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

    // 비교 모드 감지
    const isCompare = /비교|vs|차이|뭐가 (?:다르|나아|좋아)|어떤 게/.test(msg);

    let s = '\n\n## 🔍 질문 관련 KODEX ETF 상세 데이터\n';

    if (isCompare && unique.length >= 2) {
        s += '\n### [비교 모드] 아래 ETF를 표로 비교해서 답변하세요\n';
        s += '| 항목 |';
        unique.slice(0, 4).forEach(e => { s += ` ${e.name} |`; });
        s += '\n|------|';
        unique.slice(0, 4).forEach(() => { s += '------|'; });

        const rows = [
            ['종목코드', e => e.code],
            ['현재가', e => { const l = nav[e.name]; return l ? l.price : (e.price?.toLocaleString() + '원'); }],
            ['등락률', e => { const l = nav[e.name]; return l ? l.changeRate + '%' : '-'; }],
            ['순자산(억)', e => e.aum ? Math.round(e.aum).toLocaleString() : '-'],
            ['총보수', e => e.fee != null ? e.fee + '%' : '-'],
            ['1개월', e => e.return1m != null ? e.return1m + '%' : '-'],
            ['3개월', e => e.return3m != null ? e.return3m + '%' : '-'],
            ['1년', e => e.return1y != null ? e.return1y + '%' : '-'],
            ['유형', e => `${e.category}/${e.subCategory}`],
            ['과세', e => e.taxType || '-'],
            ['환헤지', e => e.hedged ? 'O' : 'X'],
            ['상위종목', e => e.top3Holdings?.map(h => h.name).join(', ') || '-'],
            ['연간분배금', e => e.annualDividend ? e.annualDividend + '원' : '-'],
            ['배당률', e => e.dividendYield ? e.dividendYield + '%' : '-'],
        ];
        for (const [label, fn] of rows) {
            s += `\n| ${label} |`;
            unique.slice(0, 4).forEach(e => { s += ` ${fn(e)} |`; });
        }
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
            if (etf.top3Holdings?.length) {
                s += `- 상위 보유종목: ${etf.top3Holdings.map(h => `${h.name}(${h.weight}%)`).join(', ')}\n`;
            }
            if (etf.annualDividend) {
                s += `- 연간 분배금: ${etf.annualDividend}원 (배당률 ${etf.dividendYield ?? '-'}%)\n`;
            }
            if (etf.distributions?.length) {
                s += `- 최근 분배 이력: ${etf.distributions.slice(0, 4).map(d => `${d.date.slice(0,4)}.${d.date.slice(4,6)} ${d.amount}원`).join(' / ')}\n`;
            }
        }
    }
    return s;
}

// ===== 네이버 증권 ETF 종목코드 (인기 TOP 20 + 주요 ETF) =====
const NAVER_ETF_CODES = {
    'KODEX 200': '069500', 'KODEX 레버리지': '122630', 'KODEX 인버스': '114800',
    'KODEX 반도체': '091160', 'KODEX 2차전지산업': '305720', 'KODEX 삼성전자': '069660',
    'KODEX 코스닥150': '229200', 'KODEX 미국S&P500TR': '379800',
    'KODEX 미국나스닥100TR': '379810', 'KODEX 골드선물(H)': '132030',
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
    'KODEX 은선물(H)': '144600', 'KODEX 삼성전자채권혼합': '292150',
};

// ===== 시장 데이터 캐시 (60초 TTL) =====
let _marketCache = null;
let _marketCacheTime = 0;
const MARKET_CACHE_TTL = 60000;

async function fetchAllMarketData() {
    if (_marketCache && Date.now() - _marketCacheTime < MARKET_CACHE_TTL) {
        return _marketCache;
    }

    const results = { naver: {}, yahoo_kr: [], yahoo_us: [], kospi: null, timestamp: new Date().toISOString() };

    try {
        const naverPromises = Object.entries(NAVER_ETF_CODES).map(async ([name, code]) => {
            try {
                const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
                });
                if (res.ok) {
                    const d = await res.json();
                    results.naver[name] = {
                        code, price: d.closePrice || d.stockEndPrice,
                        change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio,
                        high: d.highPrice, low: d.lowPrice, volume: d.accumulatedTradingVolume,
                    };
                }
            } catch (e) { /* skip */ }
        });

        const kospiPromise = fetch('https://m.stock.naver.com/api/index/KOSPI/basic', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        }).then(r => r.json()).then(d => {
            results.kospi = { price: d.closePrice, change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio };
        }).catch(() => {});

        const yahooChartFetch = async (symbol) => {
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
        };

        const yahooUsSymbols = ['SPY', 'QQQ', '%5EGSPC', '%5EIXIC', '%5EDJI'];
        const yahooUsPromise = Promise.all(yahooUsSymbols.map(s => yahooChartFetch(s))).then(arr => {
            results.yahoo_us = arr.filter(Boolean);
        }).catch(() => {});

        const yahooKrSymbols = ['069500.KS', '122630.KS', '091160.KS', '379800.KS'];
        const yahooKrPromise = Promise.all(yahooKrSymbols.map(s => yahooChartFetch(s))).then(arr => {
            results.yahoo_kr = arr.filter(Boolean);
        }).catch(() => {});

        await Promise.race([
            Promise.allSettled([...naverPromises, kospiPromise, yahooKrPromise, yahooUsPromise]),
            new Promise(resolve => setTimeout(resolve, 4000))
        ]);

    } catch (e) {
        console.error('시장 데이터 수집 오류:', e.message);
    }

    _marketCache = results;
    _marketCacheTime = Date.now();
    return results;
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

// ===== API Routes =====

// FunETF 크롤링 데이터
app.get('/api/funetf/kodex', (req, res) => {
    if (!FUNETF_DATA) return res.json({ success: false, error: 'FunETF 데이터 없음' });
    const limit = parseInt(req.query.limit) || 50;
    const search = (req.query.q || '').toLowerCase();
    let etfs = FUNETF_DATA.kodex_etfs;
    if (search) etfs = etfs.filter(e => e.name.toLowerCase().includes(search) || (e.tags && e.tags.toLowerCase().includes(search)));
    etfs = etfs.sort((a, b) => b.popularity - a.popularity).slice(0, limit);
    res.json({ success: true, data: etfs, total: FUNETF_DATA.kodex_etfs.length });
});

// 네이버 증권 ETF 목록
app.get('/api/naver/etf-list', async (req, res) => {
    try {
        const results = {};
        for (const [name, code] of Object.entries(NAVER_ETF_CODES)) {
            try {
                const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
                });
                if (r.ok) {
                    const d = await r.json();
                    results[name] = { code, price: d.closePrice || d.stockEndPrice, change: d.compareToPreviousClosePrice, changeRate: d.fluctuationsRatio };
                }
            } catch (e) { /* skip */ }
        }
        res.json({ success: true, data: results, timestamp: new Date().toISOString() });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// 시장 개요
app.get('/api/market-overview', async (req, res) => {
    try {
        const data = await fetchAllMarketData();
        res.json({ success: true, data });
    } catch (error) { res.json({ success: false, error: error.message }); }
});

// ===== 메인 채팅 API (Claude Opus 4.6 + 실시간 데이터) =====
app.post('/api/chat', async (req, res) => {
    try {
        const { messages, model: modelChoice } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: 'messages 배열이 필요합니다.' });
        }

        const MODEL_MAP = {
            sonnet: { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', icon: '⚡' },
            opus: { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', icon: '🧠' },
        };
        const selectedModel = MODEL_MAP[modelChoice] || MODEL_MAP.sonnet;

        // ✅ 1단계: 네이버증권 + 야후파이낸스 실시간 데이터 수집
        console.log('📊 실시간 시장 데이터 수집 시작...');
        const marketData = await fetchAllMarketData();
        const naverCount = Object.keys(marketData.naver).length;
        const yahooCount = marketData.yahoo_kr.length + marketData.yahoo_us.length;
        console.log(`✅ 데이터 수집 완료: 네이버 ${naverCount}개, 야후 ${yahooCount}개`);

        // ✅ 2단계: 시스템 프롬프트 구성 (크롤링 + 실시간 + 질문 맞춤)
        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';

        // 분배금 관련 질문이면 실시간 분배금 데이터 수집
        const isDivQuestion = /분배|배당|인컴|월배당|분기배당/.test(lastUserMsg);
        if (isDivQuestion && FUNETF_DATA?.kodex_etfs) {
            const relevantETFs = FUNETF_DATA.kodex_etfs.filter(e => {
                const name = e.name.toLowerCase();
                return lastUserMsg.toLowerCase().split(/\s+/).some(w => w.length >= 2 && name.includes(w));
            }).slice(0, 5);

            if (relevantETFs.length === 0) {
                const coveredCalls = FUNETF_DATA.kodex_etfs
                    .filter(e => e.name.includes('커버드콜') || e.name.includes('배당'))
                    .sort((a, b) => b.popularity - a.popularity).slice(0, 5);
                relevantETFs.push(...coveredCalls);
            }

            await Promise.allSettled(relevantETFs.map(e => enrichETFWithLiveDiv(e)));
        }

        let systemContent = SYSTEM_PROMPT;
        systemContent += getFunETFSummary(marketData.naver);
        systemContent += getRelevantETFData(lastUserMsg, marketData.naver);

        systemContent += '\n\n## 📊 실시간 시장 데이터 (방금 수집, 응답에 적극 활용할 것)\n';

        if (marketData.kospi) {
            systemContent += `\n### KOSPI 지수\n현재: ${marketData.kospi.price}pt / 전일대비: ${marketData.kospi.change} (${marketData.kospi.changeRate}%)\n`;
        }

        if (Object.keys(marketData.naver).length > 0) {
            systemContent += '\n### 네이버증권 KODEX ETF 실시간 시세\n';
            systemContent += '| ETF | 현재가 | 전일대비 | 등락률 | 거래량 |\n|-----|--------|----------|--------|--------|\n';
            for (const [name, d] of Object.entries(marketData.naver)) {
                systemContent += `| ${name} | ${d.price} | ${d.change} | ${d.changeRate}% | ${d.volume} |\n`;
            }
        }

        if (marketData.yahoo_us.length > 0) {
            systemContent += '\n### 미국 시장 (야후파이낸스)\n';
            systemContent += '| 지수/ETF | 현재가 | 등락 | 등락률 |\n|---------|--------|------|--------|\n';
            marketData.yahoo_us.forEach(q => {
                systemContent += `| ${q.name || q.symbol} | ${q.price} | ${q.change} | ${q.changePercent}% |\n`;
            });
        }

        if (marketData.yahoo_kr.length > 0) {
            systemContent += '\n### 한국 ETF 야후파이낸스 데이터\n';
            marketData.yahoo_kr.forEach(q => {
                systemContent += `${q.symbol}: ${q.price} (${q.changePercent}%)\n`;
            });
        }

        systemContent += `\n데이터 수집 시각: ${marketData.timestamp}\n`;

        // ✅ 3단계: Claude Sonnet 4 호출 (Opus 대비 3~5배 빠름, 품질 우수)
        const recentMessages = messages.slice(-10);
        const useStream = req.query.stream === 'true' || req.body.stream === true;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://samsung-etf.vercel.app',
                'X-Title': 'FunETF AI Chatbot'
            },
            body: JSON.stringify({
                model: selectedModel.id,
                messages: [{ role: 'system', content: systemContent }, ...recentMessages],
                max_tokens: 16000,
                temperature: 0.7,
                stream: useStream,
            }),
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
        }

        // 스트리밍 모드
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
                            if (delta) {
                                fullReply += delta;
                                res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
                            }
                        } catch (e) { /* skip parse errors */ }
                    }
                }
            } catch (e) { /* stream ended */ }

            res.write(`data: ${JSON.stringify({ done: true, fullReply, marketDataUsed: { naverETFs: naverCount, yahooQuotes: yahooCount, hasFunETF: !!FUNETF_DATA } })}\n\n`);
            res.end();
            return;
        }

        // 일반 모드
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content;

        if (!reply || reply.trim().length === 0) {
            throw new Error('Claude가 빈 응답을 반환했습니다.');
        }

        res.json({
            success: true,
            reply,
            modelUsed: {
                key: 'claude', name: selectedModel.name, shortName: selectedModel.name,
                icon: selectedModel.icon, color: '#8B5CF6',
                wasAutoRouted: false,
            },
            usage: data.usage,
            marketDataUsed: {
                naverETFs: naverCount,
                yahooQuotes: yahooCount,
                hasFunETF: !!FUNETF_DATA,
            }
        });
    } catch (error) {
        console.error('Chat Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

module.exports = app;
