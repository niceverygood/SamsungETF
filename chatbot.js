/**
 * KODEX ETF AI 챗봇 엔진 (Tri-Model)
 * Claude 4.6 Opus + GPT-5.4 Pro + Gemini 3.1 Pro
 * OpenRouter API + 네이버증권 + 야후파이낸스 + FunETF 크롤링 데이터
 */

class KODEXChatbot {
    constructor() {
        this.conversationHistory = [];
        this.marketData = null;
        this.lastMarketFetch = 0;
        this.MARKET_CACHE_MS = 60000; // 1분 캐시
        this.selectedModel = 'auto'; // 'auto' | 'claude' | 'gpt' | 'gemini'
    }

    // 모델 선택
    setModel(modelKey) {
        this.selectedModel = modelKey;
        console.log(`🎯 모델 변경: ${modelKey}`);
    }

    getSelectedModel() {
        return this.selectedModel;
    }

    // 시장 데이터 가져오기 (네이버 + 야후)
    async fetchMarketData() {
        const now = Date.now();
        if (this.marketData && (now - this.lastMarketFetch < this.MARKET_CACHE_MS)) {
            return this.marketData;
        }

        try {
            const [naverRes, yahooKrRes, yahooUsRes, overviewRes] = await Promise.allSettled([
                fetch('/api/naver/etf-list').then(r => r.json()),
                fetch('/api/yahoo/quotes?symbols=069500.KS,122630.KS,091160.KS,305720.KS,379800.KS,379810.KS').then(r => r.json()),
                fetch('/api/yahoo/quotes?symbols=SPY,QQQ,SOXX,IWM,VTI').then(r => r.json()),
                fetch('/api/market-overview').then(r => r.json()),
            ]);

            this.marketData = {
                naverETF: naverRes.status === 'fulfilled' && naverRes.value.success ? naverRes.value.data : null,
                yahooKR: yahooKrRes.status === 'fulfilled' && yahooKrRes.value.success ? yahooKrRes.value.data : null,
                yahooUS: yahooUsRes.status === 'fulfilled' && yahooUsRes.value.success ? yahooUsRes.value.data : null,
                overview: overviewRes.status === 'fulfilled' && overviewRes.value.success ? overviewRes.value.data : null,
                fetchedAt: new Date().toISOString()
            };
            this.lastMarketFetch = now;

            console.log('📊 시장 데이터 업데이트 완료');
            return this.marketData;
        } catch (error) {
            console.error('시장 데이터 로드 실패:', error);
            return this.marketData;
        }
    }

    // 마퀴 데이터 업데이트
    async updateMarqueeData() {
        const data = await this.fetchMarketData();
        if (!data?.naverETF) return;

        const marqueeTrack = document.getElementById('marqueeTrack');
        if (!marqueeTrack) return;

        const etfTags = Object.entries(data.naverETF).map(([name, info]) => {
            const changeRate = parseFloat(info.changeRate) || 0;
            const changeClass = changeRate >= 0 ? 'positive' : 'negative';
            const sign = changeRate >= 0 ? '+' : '';
            return `<div class="etf-tag">${name} <span class="etf-tag-change ${changeClass}">${sign}${changeRate.toFixed(2)}%</span></div>`;
        }).join('');

        if (etfTags) {
            marqueeTrack.innerHTML = etfTags + etfTags;
        }
    }

    // AI 응답 생성 (Tri-Model OpenRouter API)
    async generateResponse(userMessage) {
        this.conversationHistory.push({ role: 'user', content: userMessage });

        // 시장 데이터 가져오기
        const marketData = await this.fetchMarketData();

        // 최근 10개 메시지만 전송 (토큰 절약)
        const recentMessages = this.conversationHistory.slice(-10);

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: recentMessages,
                    marketData: marketData,
                    modelKey: this.selectedModel
                })
            });

            const data = await response.json();

            if (data.success && data.reply) {
                const reply = data.reply;
                this.conversationHistory.push({ role: 'assistant', content: reply });

                // 모델 정보 로그
                if (data.modelUsed) {
                    console.log(`${data.modelUsed.icon} ${data.modelUsed.name}${data.modelUsed.wasAutoRouted ? ' (자동 선택)' : ' (수동)'}`);
                }
                if (data.usage) {
                    console.log(`📊 토큰: 입력 ${data.usage.prompt_tokens}, 출력 ${data.usage.completion_tokens}`);
                }

                return {
                    reply: reply,
                    modelUsed: data.modelUsed
                };
            } else {
                throw new Error(data.error || '응답 생성 실패');
            }
        } catch (error) {
            console.error('AI 응답 오류:', error);
            return {
                reply: this.getFallbackResponse(userMessage, error.message),
                modelUsed: null
            };
        }
    }

    // API 실패 시 폴백 응답
    getFallbackResponse(query, errorMsg) {
        return `<p>⚠️ 죄송합니다. AI 연결에 일시적인 문제가 발생했습니다.</p>
<p><small>오류: ${errorMsg}</small></p>
<p>잠시 후 다시 시도해주시거나, 아래 빠른 질문 버튼을 이용해주세요.</p>
<p>💡 <strong>추천 질문:</strong></p>
<ul>
<li>"KODEX ETF 인기 상품 Top 5 알려줘"</li>
<li>"AI 관련 ETF 추천해줘"</li>
<li>"커버드콜 ETF가 뭐야?"</li>
<li>"2026 투자 전략 알려줘"</li>
</ul>`;
    }
}

// 글로벌 챗봇 인스턴스
const chatbot = new KODEXChatbot();
