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
let selectedModel = 'sonnet';

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
            ? { key: 'claude', name: 'Claude Opus 4.6', shortName: 'Opus', icon: '🧠', color: '#8B5CF6' }
            : { key: 'claude', name: 'Claude Sonnet 4', shortName: 'Sonnet', icon: '⚡', color: '#8B5CF6' };
        const streamBubble = addMessage('', 'bot', modelInfo);
        const contentEl = streamBubble?.querySelector('.bubble-content');

        const result = await chatbot.generateResponse(text, (chunk, fullText) => {
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
