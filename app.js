/**
 * FunETF AI 챗봇 Demo - App Logic (Tri-Model)
 * Claude 4.6 Opus + GPT-5.4 Pro + Gemini 3.1 Pro
 */

// ===== Chat Functions =====
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

// Model color map
const MODEL_COLORS = {
    claude: { bg: 'rgba(139, 92, 246, 0.15)', border: 'rgba(139, 92, 246, 0.4)', text: '#A78BFA' },
    gpt: { bg: 'rgba(16, 185, 129, 0.15)', border: 'rgba(16, 185, 129, 0.4)', text: '#34D399' },
    gemini: { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgba(59, 130, 246, 0.4)', text: '#60A5FA' }
};

// ===== PB Selling Mode =====
let currentMode = 'normal';

const PB_QUICK_ACTIONS = [
    { icon: "💰", label: "커버드콜 월수입 계산", prompt: "고객이 커버드콜 ETF에 관심 있습니다. 투자금 1억원, ISA 계좌 기준으로 월수입 시뮬레이션을 해주세요." },
    { icon: "⚔️", label: "경쟁사 ETF 비교", prompt: "KODEX 미국S&P500과 경쟁사(TIGER/ACE) S&P500 ETF를 비교해주세요. PB 멘트도 포함해주세요." },
    { icon: "🏦", label: "계좌별 세금 비교", prompt: "KODEX 200타겟위클리커버드콜을 ISA, 연금저축, 일반계좌에 각각 5000만원 투자할 때 세후 수입 차이를 비교해주세요." },
    { icon: "📊", label: "포트폴리오 추천", prompt: "고객 프로필에 맞는 KODEX ETF 포트폴리오를 추천해주세요. 비중과 예상 수익을 포함해주세요." },
    { icon: "📋", label: "상품 설명 스크립트", prompt: "KODEX 200타겟위클리커버드콜을 고객에게 설명할 PB 스크립트를 만들어주세요. 핵심 셀링 포인트 3가지와 예상 질문 대응도 포함해주세요." },
    { icon: "⚠️", label: "리스크 고지 체크리스트", prompt: "커버드콜 ETF 판매 시 필수 고지사항 체크리스트를 보여주세요. 불완전판매 방지 항목을 포함해주세요." },
];

const NORMAL_QUICK_ACTIONS = [
    { icon: "💰", label: "커버드콜 월수입 계산", prompt: "ISA에서 KODEX 200타겟위클리커버드콜에 5000만원 투자하면 세후 월 수입이 얼마야?" },
    { icon: "⚔️", label: "경쟁사 ETF 비교", prompt: "KODEX 미국배당커버드콜 vs TIGER 배당커버드콜 비교해줘" },
    { icon: "📉", label: "금리와 커버드콜", prompt: "금리 인하기에 커버드콜 ETF가 불리하다는데, 왜 그런 거야? 분배율이 실제로 얼마나 떨어질 수 있어?" },
    { icon: "🏦", label: "절세 계좌 비교", prompt: "연금저축에서 KODEX ETF 사면 세금이 어떻게 되는 거야? ISA랑 비교해서 설명해줘" },
    { icon: "🔬", label: "반도체 사이클 분석", prompt: "KODEX 반도체에 어떤 종목이 들어있어? 지금 반도체 사이클 어디쯤이야?" },
    { icon: "🇺🇸", label: "해외 ETF 세금 비교", prompt: "KODEX 미국S&P500이랑 SPY 직접 사는 거랑 세금 차이 비교해줘" },
    { icon: "📊", label: "장기 적립 시뮬레이션", prompt: "월 100만원씩 KODEX 미국S&P500TR에 연금저축으로 10년 적립하면 얼마가 될까?" },
    { icon: "⚡", label: "레버리지 함정", prompt: "레버리지 ETF를 장기 보유하면 왜 손해야? 변동성 잠식이 뭔지 예시 들어서 설명해줘" },
];

function switchMode(mode) {
    currentMode = mode;
    document.getElementById('modeNormal').classList.toggle('active', mode === 'normal');
    document.getElementById('modePB').classList.toggle('active', mode === 'pb');
    document.body.classList.toggle('pb-mode', mode === 'pb');
    
    const profilePanel = document.getElementById('clientProfilePanel');
    if (profilePanel) profilePanel.style.display = mode === 'pb' ? 'block' : 'none';
    
    const sectionTitle = document.querySelector('.chat-section .section-title');
    const sectionSubtitle = document.querySelector('.chat-section .section-subtitle');
    if (sectionTitle) sectionTitle.innerHTML = mode === 'pb' 
        ? 'KODEX AI <span class="gradient-text">셀링 어시스턴트</span>' 
        : 'KODEX ETF <span class="gradient-text">FunETF AI 챗봇</span>';
    if (sectionSubtitle) sectionSubtitle.textContent = mode === 'pb'
        ? '판매사 전용 — 고객 상담 시 실시간 데이터 기반 영업 지원'
        : 'FunETF AI가 실시간 시장 데이터를 분석하여 답변합니다.';
    
    updateQuickActions();
}

function updateQuickActions() {
    const container = document.querySelector('.quick-actions');
    if (!container) return;
    const actions = currentMode === 'pb' ? PB_QUICK_ACTIONS : NORMAL_QUICK_ACTIONS;
    container.innerHTML = actions.map(a => 
        `<button class="quick-btn" onclick="sendQuickMessage('${a.prompt.replace(/'/g, "\\'")}')">${a.icon} ${a.label}</button>`
    ).join('');
}

function toggleProfilePanel() {
    const body = document.getElementById('profileBody');
    const icon = document.getElementById('profileToggleIcon');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    if (icon) icon.classList.toggle('collapsed', !isHidden);
}

function getClientProfile() {
    if (currentMode !== 'pb') return '';
    const age = document.getElementById('clientAge')?.value;
    const investType = document.getElementById('clientInvestType')?.value;
    const accountType = document.getElementById('clientAccountType')?.value;
    const budget = document.getElementById('clientBudget')?.value;
    const goal = document.getElementById('clientGoal')?.value;
    const existing = document.getElementById('clientExistingETF')?.value;
    
    if (!age && !investType && !accountType && !budget && !goal) return '';
    
    let profile = '\n\n[고객 프로필]\n';
    if (age) profile += `- 나이: ${age}세\n`;
    if (investType) profile += `- 투자성향: ${investType}\n`;
    if (accountType) profile += `- 계좌유형: ${accountType}\n`;
    if (budget) profile += `- 월 투자금: ${budget}만원\n`;
    if (goal) profile += `- 투자목적: ${goal}\n`;
    if (existing) profile += `- 보유 ETF: ${existing}\n`;
    profile += '이 고객에게 맞는 맞춤형 답변을 해주세요.\n';
    return profile;
}

function scrollToChat() {
    document.getElementById('chat-section').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => chatInput.focus(), 600);
}

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

let isProcessing = false;
let selectedModel = 'opus';

function selectModel(model) {
    selectedModel = model;
    document.getElementById('btnSonnet').classList.toggle('active', model === 'sonnet');
    document.getElementById('btnOpus').classList.toggle('active', model === 'opus');
}

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;

    // Add user message
    addMessage(text, 'user');
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Show typing indicator
    const typingEl = showTyping();

    try {
        removeTyping(typingEl);
        const modelInfo = selectedModel === 'opus'
            ? { key: 'claude', name: 'FunETF AI 🧠', shortName: '깊은 분석', icon: '🧠', color: '#8B5CF6' }
            : { key: 'claude', name: 'FunETF AI ⚡', shortName: '빠른 답변', icon: '⚡', color: '#8B5CF6' };
        const streamBubble = addMessage('', 'bot', modelInfo);
        const contentEl = streamBubble?.querySelector('.bubble-content');

        const result = await chatbot.generateResponse(text + getClientProfile(), (chunk, fullText) => {
            if (contentEl) {
                contentEl.innerHTML = fullText;
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }, selectedModel);

        if (contentEl && result.reply) {
            contentEl.innerHTML = result.reply;
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    } catch (error) {
        removeTyping(typingEl);
        addMessage(`<p>⚠️ 오류가 발생했습니다: ${error.message}</p>`, 'bot');
    } finally {
        sendBtn.disabled = false;
        isProcessing = false;
        chatInput.focus();
    }
}

function sendQuickMessage(text) {
    chatInput.value = text;
    sendMessage();
}

function addMessage(content, type, modelUsed) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}-message`;

    const avatarSvg = type === 'bot'
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 22L12 14L16 18L20 10L24 16" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(-4, 2) scale(0.9)"/></svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

    const bubbleContent = type === 'user'
        ? `<p>${escapeHtml(content)}</p>`
        : content;

    let modelBadgeHtml = '';
    if (type === 'bot' && modelUsed) {
        const colors = MODEL_COLORS[modelUsed.key] || MODEL_COLORS.claude;
        const routeLabel = modelUsed.wasAutoRouted ? '자동 선택' : '';
        modelBadgeHtml = `
        <div class="model-badge" style="background: ${colors.bg}; border-color: ${colors.border};">
            <span class="model-badge-icon">${modelUsed.icon}</span>
            <span class="model-badge-name" style="color: ${colors.text};">${modelUsed.name}</span>
            ${routeLabel ? `<span class="model-badge-route">${routeLabel}</span>` : ''}
        </div>`;
    }

    messageDiv.innerHTML = `
    <div class="message-avatar">${avatarSvg}</div>
    <div class="message-content">
      <div class="message-bubble"><div class="bubble-content">${bubbleContent}</div></div>
      ${modelBadgeHtml}
    </div>
  `;

    chatMessages.appendChild(messageDiv);
    scrollToBottom();
    return messageDiv;
}

function showTyping() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message';
    typingDiv.id = 'typingIndicator';

    const modelLabel = '🧠 Claude 분석 중... (실시간 데이터 수집 → AI 응답)';

    typingDiv.innerHTML = `
    <div class="message-avatar">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 22L12 14L16 18L20 10L24 16" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(-4, 2) scale(0.9)"/></svg>
    </div>
    <div class="message-content">
      <div class="typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-label">${modelLabel}</span>
      </div>
    </div>
  `;
    chatMessages.appendChild(typingDiv);
    scrollToBottom();
    return typingDiv;
}

function removeTyping(el) {
    if (el && el.parentNode) {
        el.parentNode.removeChild(el);
    }
}



function clearChat() {
    chatMessages.innerHTML = '';
    // Re-add welcome message
    const welcomeHTML = `
    <div class="message bot-message" id="welcomeMsg">
      <div class="message-avatar">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M8 22L12 14L16 18L20 10L24 16" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(-4, 2) scale(0.9)"/>
        </svg>
      </div>
      <div class="message-content">
        <div class="message-bubble">
          <p>안녕하세요! 👋 <strong>KODEX ETF AI 어시스턴트</strong>입니다.</p>
          <p>삼성자산운용이 운용하는 KODEX ETF에 대해 무엇이든 물어보세요. ETF 상품 정보, 시장 분석, 투자 전략까지 도와드리겠습니다.</p>
          <div class="tri-model-badges">
            <div class="tri-badge claude">🧠 Claude 4.6 Opus <span>AI 엔진</span></div>
            <div class="tri-badge gpt">📊 네이버증권 <span>실시간 시세</span></div>
            <div class="tri-badge gemini">🌍 야후파이낸스 <span>글로벌 데이터</span></div>
          </div>
        </div>
        <div class="quick-actions">
          <button class="quick-btn" onclick="sendQuickMessage('KODEX ETF 인기 상품 TOP 5 알려줘')">🏆 인기 상품 TOP 5</button>
          <button class="quick-btn" onclick="sendQuickMessage('AI 관련 KODEX ETF 추천해줘')">🤖 AI 테마 ETF</button>
          <button class="quick-btn" onclick="sendQuickMessage('배당형 ETF 추천해줘')">💰 배당형 ETF</button>
          <button class="quick-btn" onclick="sendQuickMessage('ETF 투자 초보인데 어떻게 시작하면 좋을까?')">📚 ETF 입문 가이드</button>
          <button class="quick-btn" onclick="sendQuickMessage('커버드콜 ETF가 뭐야?')">📊 커버드콜 ETF</button>
          <button class="quick-btn" onclick="sendQuickMessage('2026년 유망 투자 테마 알려줘')">🔮 2026 투자 전략</button>
          <button class="quick-btn" onclick="sendQuickMessage('오늘 KODEX 200 시세 알려줘')">📈 실시간 시세</button>
          <button class="quick-btn" onclick="sendQuickMessage('미국 시장 현황 알려줘')">🇺🇸 미국 시장</button>
        </div>
      </div>
    </div>
  `;
    chatMessages.innerHTML = welcomeHTML;
    chatbot.conversationHistory = [];
}

function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Connection Status =====
async function checkAPIStatus() {
    const statusEl = document.getElementById('apiStatus');
    if (!statusEl) return;

    try {
        const res = await fetch('/api/market-overview');
        const data = await res.json();
        if (data.success) {
            statusEl.innerHTML = '<span class="status-dot"></span> Claude 4.6 Opus · 실시간 데이터 활성';
            statusEl.className = 'chat-header-status connected';
        } else {
            statusEl.innerHTML = '<span class="status-dot warn"></span> 일부 데이터 제한';
            statusEl.className = 'chat-header-status';
        }
    } catch {
        statusEl.innerHTML = '<span class="status-dot offline"></span> 오프라인';
        statusEl.className = 'chat-header-status';
    }
}

// ===== Particles =====
function createParticles() {
    const container = document.getElementById('particles');
    if (!container) return;

    const colors = ['rgba(0, 102, 255, 0.12)', 'rgba(99, 102, 241, 0.1)', 'rgba(139, 92, 246, 0.08)'];

    for (let i = 0; i < 20; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.width = (4 + Math.random() * 8) + 'px';
        particle.style.height = particle.style.width;
        particle.style.background = colors[Math.floor(Math.random() * colors.length)];
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animationDelay = (Math.random() * 10) + 's';
        particle.style.animationDuration = (15 + Math.random() * 15) + 's';
        container.appendChild(particle);
    }
}

// ===== Marquee Duplication =====
function setupMarquee() {
    const track = document.getElementById('marqueeTrack');
    if (!track) return;

    const items = track.innerHTML;
    track.innerHTML = items + items;
}

// ===== Scroll Animations =====
function observeElements() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.feature-card').forEach((card, i) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = `all 0.6s ease ${i * 0.1}s`;
        observer.observe(card);
    });
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    createParticles();
    setupMarquee();
    observeElements();

    // Check API status
    checkAPIStatus();

    // 시장 데이터로 마퀴 업데이트 시도
    chatbot.updateMarqueeData();

    // 3분마다 마퀴 데이터 업데이트
    setInterval(() => chatbot.updateMarqueeData(), 180000);

    // Focus input when scrolled to chat
    const chatSection = document.getElementById('chat-section');
    const chatObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
            setTimeout(() => chatInput.focus(), 300);
        }
    }, { threshold: 0.3 });
    chatObserver.observe(chatSection);


});
