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

// FunETF 데이터에서 KODEX ETF Top 20 요약 생성 (시스템 프롬프트용)
function getFunETFSummary() {
    if (!FUNETF_DATA?.kodex_etfs) return '';
    const top20 = FUNETF_DATA.kodex_etfs
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 20);
    let summary = '\n\n## FunETF 실시간 크롤링 데이터 (인기순 Top 20)\n';
    summary += '| 순위 | ETF명 | NAV(원) | 인기도 |\n|------|-------|---------|--------|\n';
    top20.forEach((etf, i) => {
        summary += `| ${i + 1} | ${etf.name} | ${Math.round(etf.nav).toLocaleString()} | ${etf.popularity.toLocaleString()} |\n`;
    });
    summary += `\n총 KODEX ETF 수: ${FUNETF_DATA.kodex_etfs.length}개 / 전체 시장 ETF: ${FUNETF_DATA.all_etf_count}개`;
    return summary;
}

// ===== Tri-Model Configuration =====
const AI_MODELS = {
    claude: {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude 4.6 Opus',
        shortName: 'Claude',
        icon: '🧠',
        color: '#8B5CF6',
        description: '독보적인 논리력 & 문장력',
        strength: '금융 약관이나 복잡한 ETF 구조를 설명할 때 가장 인간답고 정확한 분석',
        maxTokens: 2000,
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
        maxTokens: 2000,
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
        maxTokens: 2000,
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
const SYSTEM_PROMPT = `당신은 삼성자산운용이 운용하는 KODEX ETF 전문 AI 어시스턴트 "KODEX AI"입니다.

## 역할과 성격
- 삼성자산운용의 KODEX ETF에 대해 깊이 있는 전문 지식을 갖춘 친절한 AI 어시스턴트
- 전문적이면서도 이해하기 쉬운 언어로 설명
- ETF 시장 트렌드, 투자 전략, 상품 분석에 능통
- 항상 한국어로 대화하며, 이모지를 적극 활용

## KODEX ETF 핵심 데이터 (2026년 3월 기준)
- KODEX 순자산: 113조원 돌파 (국내 ETF 시장 1위)
- 2025년 개인 순매수: 13조 5,493억원 (1위)
- KODEX 커버드콜 ETF: 12종, 순자산 6.2조원 달성
- 200개 이상 다양한 ETF 라인업 운용

## 주요 KODEX ETF 상품 정보

### 국내 주식형
- **KODEX 200**: KOSPI 200 추종, 국내 최대 규모 ETF (약 5.5조원), 보수 0.015%
- **KODEX 반도체**: KRX 반도체 지수 추종, 삼성전자·SK하이닉스 집중 투자
- **KODEX 2차전지산업**: 2차전지 밸류체인 투자 (LG에너지솔루션, 삼성SDI 등)
- **KODEX AI반도체핵심장비**: HBM 수요 급증으로 수혜가 기대되는 장비 업체 집중
- **KODEX 로봇액티브**: 2026년 유망 ETF 설문조사 투자자/판매자 모두 1위

### 해외 주식형
- **KODEX 미국S&P500**: S&P 500 지수 추종, 미국 대형주 500개 분산 투자
- **KODEX 미국나스닥100**: 나스닥 100 추종, 빅테크 중심
- **KODEX 미국AI반도체TOP3플러스**: 엔비디아·TSMC·브로드컴 집중, 2026.1.13 상장
- **KODEX 미국AI전력핵심인프라**: AI 데이터센터 전력 인프라 기업
- **KODEX 미국AI광통신네트워크**: 데이터센터 광통신 인프라, 2026.3.16 상장
- **KODEX 미국우주항공**: 미국 우주항공 핵심 기업, 2026.3.17 상장
- **KODEX 미국휴머노이드로봇**: 테슬라 옵티머스, 엔비디아 로봇 플랫폼 등

### 커버드콜 ETF
- **KODEX 미국성장커버드콜액티브**: 미국 성장주 + 커버드콜, 2025.12.23 상장
- **KODEX 200타겟위클리커버드콜**: KOSPI 200 기반 위클리 커버드콜, ISA 적합
- **KODEX 금융고배당TOP10타겟위클리커버드콜**: 금융고배당 + 커버드콜 이중인컴

### 채권혼합형
- **KODEX 삼성전자채권혼합**: 삼성전자 + 국내채권, 2026년 순자산 급증
- **KODEX 200미국채혼합**: KOSPI 200 + 미국국채, 글로벌 자산배분

## 2026년 핵심 투자 전략: AAA (AI & Asset Allocation)
삼성자산운용이 2026년 제시한 핵심 투자 전략:
1. AI 반도체·인프라 투자 확대 (HBM, 전력, 광통신)
2. 휴머노이드 로봇 산업 본격 성장
3. 우주항공 산업 투자 기회 확대
4. 커버드콜 ETF 시장 급성장
5. 채권혼합형 ETF로 자산 배분 강화

## 응답 스타일 규칙
1. HTML 태그를 사용하여 응답 (p, strong, ul, ol, li, table, tr, th, td 태그 사용 가능)
2. ETF 상품명은 <span class="etf-highlight">KODEX 상품명</span> 형식으로 표시
3. 핵심 정보는 <strong> 태그로 강조
4. 표를 활용하여 비교 정보 깔끔하게 정리
5. 이모지를 적극 활용하여 친근하게 소통
6. 투자 권유를 하지 않고, 정보 제공 목적임을 명시
7. 응답은 간결하지만 유익하게 (너무 길지 않게)
8. 실시간 시세 데이터가 제공되면 이를 활용하여 정확한 정보 제공

## 중요 면책 조항
- 이 금융상품은 예금자보호법에 따라 보호되지 않습니다
- 과거의 운용실적이 미래의 수익률을 보장하지 않습니다
- 투자 권유가 아닌 정보 제공 목적입니다`;

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

// 야후 파이낸스 - 여러 종목 한번에 조회
app.get('/api/yahoo/quotes', async (req, res) => {
    try {
        const tickers = req.query.symbols || 'SPY,QQQ,069500.KS';
        const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}`;

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });

        if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);
        const data = await response.json();

        const quotes = (data.quoteResponse?.result || []).map(q => ({
            symbol: q.symbol,
            name: q.shortName || q.longName,
            price: q.regularMarketPrice,
            change: q.regularMarketChange?.toFixed(2),
            changePercent: q.regularMarketChangePercent?.toFixed(2),
            volume: q.regularMarketVolume,
            marketCap: q.marketCap,
            currency: q.currency
        }));

        res.json({ success: true, data: quotes, timestamp: new Date().toISOString() });
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
            fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC,%5EIXIC,%5EDJI', {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }).then(r => r.json())
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
            const quotes = yahooRes.value?.quoteResponse?.result || [];
            quotes.forEach(q => {
                overview.global[q.symbol] = {
                    name: q.shortName,
                    price: q.regularMarketPrice,
                    change: q.regularMarketChange?.toFixed(2),
                    changePercent: q.regularMarketChangePercent?.toFixed(2)
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
        const { messages, marketData, modelKey } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ success: false, error: 'messages 배열이 필요합니다.' });
        }

        // 모델 선택: 수동 지정 또는 스마트 라우팅
        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        let selectedKey = modelKey;

        if (!selectedKey || selectedKey === 'auto') {
            selectedKey = smartRouteModel(lastUserMsg);
        }

        const model = AI_MODELS[selectedKey] || AI_MODELS.claude;
        console.log(`\n🎯 모델 라우팅: "${lastUserMsg.substring(0, 30)}..." → ${model.icon} ${model.name}`);

        // 시장 데이터가 있으면 시스템 프롬프트에 추가
        let systemContent = SYSTEM_PROMPT;
        // FunETF 크롤링 데이터 추가
        systemContent += getFunETFSummary();
        if (marketData) {
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
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '죄송합니다, 응답을 생성하지 못했습니다.';

        console.log(`${model.icon} 응답 완료 (${data.usage?.completion_tokens || '?'} tokens)`);

        res.json({
            success: true,
            reply,
            modelUsed: {
                key: selectedKey,
                name: model.name,
                shortName: model.shortName,
                icon: model.icon,
                color: model.color,
                description: model.description,
                wasAutoRouted: !modelKey || modelKey === 'auto',
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
