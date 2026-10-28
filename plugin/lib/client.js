/**
 * 忆泡（Memory Bubble）· 客户端半
 *
 * 单文件、零构建、零第三方依赖（只 require('react')），由 DSH Web 的模块表加载：
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * 注册位置：
 *  - sidebar.panellist  「忆泡」入口（全局）
 *  - main              暖色泡泡图主面板
 *  - conversation.input.left  输入框左上角的忆泡小药丸（带记忆条数，点开面板）
 *  - settings.section  设置页：自动总结、去抖、注入方式、导出/导入
 *
 * 数据全部来自同源接口 /memory-bubble/api/*，不直连磁盘。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-bubble',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/memory-bubble/api'
    const PANEL_ID = 'memory-bubble'
    const store = { sessionId: null }

    /* ------------------------------------------------------------ 浮窗状态（默认关闭，位置/大小记忆） */

    const WINDOW_KEY = 'memory-bubble.window.v1'
    const win = { open: false, rect: null, listeners: new Set() }

    function safeStorage() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) return localStorage
      } catch { /* ignore */ }
      return null
    }

    function readWindowPrefs() {
      try {
        const raw = safeStorage() && safeStorage().getItem(WINDOW_KEY)
        if (!raw) return
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return
        win.open = parsed.open === true
        if (parsed.rect && typeof parsed.rect === 'object') win.rect = parsed.rect
      } catch { /* ignore */ }
    }
    readWindowPrefs()

    function saveWindowPrefs() {
      try {
        const storage = safeStorage()
        if (storage) storage.setItem(WINDOW_KEY, JSON.stringify({ open: win.open, rect: win.rect }))
      } catch { /* ignore */ }
    }

    function patchWin(patch) {
      Object.assign(win, patch)
      if (patch.rect === undefined) saveWindowPrefs()
      for (const listener of Array.from(win.listeners)) {
        try { listener() } catch { /* ignore */ }
      }
    }

    function useWindowState() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        win.listeners.add(listener)
        return () => { win.listeners.delete(listener) }
      }, [])
      return win
    }

    function screenSize() {
      try {
        if (typeof window !== 'undefined' && window.innerWidth) return { w: window.innerWidth, h: window.innerHeight }
      } catch { /* ignore */ }
      return { w: 1280, h: 800 }
    }

    function clampRect(rect) {
      const screen = screenSize()
      const minW = 380
      const minH = 360
      const width = Math.min(Math.max(Number(rect && rect.w) || 540, minW), Math.max(minW, screen.w - 40))
      const height = Math.min(Math.max(Number(rect && rect.h) || 660, minH), Math.max(minH, screen.h - 80))
      const fallbackX = screen.w - width - 28
      const fallbackY = 76
      const x = Math.min(Math.max(Number.isFinite(rect && rect.x) ? rect.x : fallbackX, 8), Math.max(8, screen.w - width - 8))
      const y = Math.min(Math.max(Number.isFinite(rect && rect.y) ? rect.y : fallbackY, 56), Math.max(56, screen.h - height - 8))
      return { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }
    }

    /* ------------------------------------------------------------ 工具函数 */

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

    function tonePalette(tone) {
      switch (tone) {
        case 'apricot': return ['#ffc58f', '#f58c5c']
        case 'honey': return ['#ffe3a1', '#f6b95e']
        case 'rose': return ['#ffc1c4', '#ef8f9c']
        case 'milk': return ['#f7e8dc', '#d9c3b2']
        case 'sage': return ['#d7e6cf', '#a9c6a1']
        case 'lilac': return ['#e2d7f0', '#b9a5d6']
        default: return ['#ffc9ae', '#f4724f']
      }
    }

    const KIND_LABELS = {
      preference: '偏好', fact: '事实', plan: '计划', relation: '关系',
      goal: '目标', emotion: '情绪', taboo: '禁忌',
    }

    function tierOf(scale) {
      if (scale < 0.62) return { key: 'far', label: '远景 · 柔光团块' }
      if (scale < 1.3) return { key: 'mid', label: '中景 · 关键词' }
      return { key: 'near', label: '近景 · 记忆全貌' }
    }

    function shortTitle(title) {
      if (!title) return ''
      return title.length > 7 ? title.slice(0, 6) + '…' : title
    }

    function fmtDate(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    /* 时间字段：input[type=datetime-local] 用本地时区字符串，保存时转 ISO */
    function toLocalDateTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function fromLocalDateTime(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '' : date.toISOString()
    }

    async function api(path, options) {
      const response = await fetch(API + path, Object.assign({
        headers: { 'content-type': 'application/json' },
      }, options))
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!response.ok || (body && body.ok === false && body.error && !body.layout)) {
        const message = (body && body.error) || `HTTP ${response.status}`
        throw new Error(String(message))
      }
      return body
    }

    /* ------------------------------------------------------------ 主题 */

    function normalizeScheme(snapshot) {
      const raw = snapshot && (snapshot.active && snapshot.active.colorScheme
        ? snapshot.active.colorScheme
        : snapshot.preference)
      return raw === 'dark' ? 'dark' : 'light'
    }

    function useColorScheme(ctx) {
      const [scheme, setScheme] = useState(() => {
        try {
          const theme = ctx && ctx.get && ctx.get('theme')
          const snapshot = theme && theme.getTheme && theme.getTheme()
          return normalizeScheme(snapshot)
        } catch { return 'light' }
      })
      useEffect(() => {
        let off = null
        try {
          const theme = ctx && ctx.get && ctx.get('theme')
          const snapshot = theme && theme.getTheme && theme.getTheme()
          if (snapshot) setScheme(normalizeScheme(snapshot))
          off = ctx.on && ctx.on('theme/change', (next) => setScheme(normalizeScheme(next)))
        } catch { /* theme 服务不在就跟随系统 */ }
        return () => { if (typeof off === 'function') { try { off() } catch { /* ignore */ } } }
      }, [ctx])
      return scheme
    }

    /* ------------------------------------------------------------ CSS */

    const CSS = `
.mb-root{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;container-type:inline-size;
  background:radial-gradient(120% 90% at 15% 0%, #fff7ee 0%, #ffeede 42%, #fff3e6 68%, #fffaf4 100%);
  color:#4a3327;font-family:var(--dsw-font-family-sans,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);
  --mb-ink:#4a3327;--mb-ink-soft:#8a6f5f;--mb-line:rgba(196,148,118,.28);
  --mb-card:rgba(255,252,247,.92);--mb-card-strong:rgba(255,253,250,.97);
  --mb-coral:#f4714d;--mb-coral-soft:rgba(244,113,77,.14);--mb-shadow:0 18px 50px rgba(168,98,62,.16);
  --mb-chip:rgba(255,255,255,.72);--mb-far-op:.55;
}
html[data-mb-theme="dark"] .mb-root{
  background:radial-gradient(120% 90% at 15% 0%, #2c211c 0%, #241a16 45%, #201612 75%, #1d1411 100%);
  color:#f3e3d4;
  --mb-ink:#f3e3d4;--mb-ink-soft:#c3a996;--mb-line:rgba(255,214,186,.16);
  --mb-card:rgba(48,36,30,.92);--mb-card-strong:rgba(54,41,34,.97);
  --mb-coral:#ff8a66;--mb-coral-soft:rgba(255,138,102,.16);--mb-shadow:0 20px 60px rgba(0,0,0,.45);
  --mb-chip:rgba(255,255,255,.08);--mb-far-op:.5;
}
@media (prefers-color-scheme:dark){
  html:not([data-mb-theme="light"]) .mb-root{
    background:radial-gradient(120% 90% at 15% 0%, #2c211c 0%, #241a16 45%, #201612 75%, #1d1411 100%);
    color:#f3e3d4;
    --mb-ink:#f3e3d4;--mb-ink-soft:#c3a996;--mb-line:rgba(255,214,186,.16);
    --mb-card:rgba(48,36,30,.92);--mb-card-strong:rgba(54,41,34,.97);
    --mb-coral:#ff8a66;--mb-coral-soft:rgba(255,138,102,.16);--mb-shadow:0 20px 60px rgba(0,0,0,.45);
    --mb-chip:rgba(255,255,255,.08);--mb-far-op:.5;
  }
}
.mb-header{display:flex;align-items:center;gap:12px;padding:12px 18px 6px;flex:none}
.mb-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 18px 10px;flex:none;border-bottom:1px solid var(--mb-line)}
.mb-brand{display:flex;align-items:center;gap:10px;min-width:0}
.mb-logo{width:34px;height:34px;border-radius:50%;flex:none;
  background:radial-gradient(circle at 32% 26%, #fff5e9 0%, #ffd9b8 26%, #f9a97b 62%, #ee7a54 100%);
  box-shadow:0 6px 18px rgba(238,122,84,.45), inset 0 -3px 8px rgba(214,105,66,.35)}
.mb-title{font-size:15px;font-weight:650;letter-spacing:.02em;display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.mb-title small{font-size:10px;font-weight:500;letter-spacing:.14em;color:var(--mb-ink-soft);opacity:.8}
.mb-sub{font-size:11.5px;color:var(--mb-ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mb-spacer{flex:1}
.mb-search{display:flex;align-items:center;gap:8px;background:var(--mb-card);border:1px solid var(--mb-line);
  border-radius:999px;padding:7px 14px;min-width:200px;flex:1 1 220px;max-width:340px}
.mb-search input{border:0;outline:0;background:transparent;color:var(--mb-ink);font-size:12.5px;width:100%}
.mb-search input::placeholder{color:var(--mb-ink-soft);opacity:.65}
.mb-icon-btn{width:32px;height:32px;border-radius:50%;border:1px solid var(--mb-line);background:var(--mb-card);
  color:var(--mb-ink);font-size:13px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;transition:transform .12s ease,background .15s ease}
.mb-icon-btn:hover{transform:translateY(-1px);background:var(--mb-card-strong)}
.mb-icon-btn:active{transform:scale(.94)}
.mb-btn{border:0;border-radius:999px;padding:8px 15px;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  background:var(--mb-chip);color:var(--mb-ink);transition:transform .12s ease,background .15s ease}
.mb-btn:hover{transform:translateY(-1px)}
.mb-btn:active{transform:scale(.96)}
.mb-btn.primary{background:linear-gradient(135deg,#ff9868,#f4714d);color:#fff;box-shadow:0 8px 22px rgba(244,113,77,.32)}
.mb-btn.ghost{background:transparent;border:1px solid var(--mb-line)}
.mb-btn.danger{background:rgba(200,80,60,.12);color:#d2543a}
html[data-mb-theme="dark"] .mb-btn.danger{color:#ff9a80}
.mb-btn[disabled]{opacity:.45;cursor:not-allowed;transform:none}
.mb-chip-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.mb-seg{display:flex;background:var(--mb-chip);border-radius:999px;padding:3px;gap:2px}
.mb-seg button{border:0;background:transparent;color:var(--mb-ink-soft);font-size:11.5px;padding:4px 10px;border-radius:999px;cursor:pointer}
.mb-seg button.on{background:var(--mb-card-strong);color:var(--mb-ink);box-shadow:0 2px 8px rgba(140,92,60,.16)}
.mb-viewport{position:relative;flex:1;overflow:hidden;cursor:grab;touch-action:none}
.mb-viewport.dragging{cursor:grabbing}
.mb-stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}
.mb-edges{position:absolute;left:0;top:0;overflow:visible}
.mb-edge-line{stroke:rgba(178,128,98,.5);stroke-width:1.2;fill:none;vector-effect:non-scaling-stroke;transition:stroke .18s ease,stroke-opacity .18s ease}
html[data-mb-theme="dark"] .mb-edge-line{stroke:rgba(255,198,160,.34)}
.mb-edge-line.conflict{stroke:#c95f42;stroke-dasharray:5 5;stroke-opacity:.8}
html[data-mb-theme="dark"] .mb-edge-line.conflict{stroke:#ff9c7c}
.mb-edge-line.hot{stroke:rgba(232,120,72,.9);stroke-opacity:1}
.mb-edge-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer;pointer-events:stroke}
.mb-node{position:absolute;border-radius:50%;cursor:pointer;transition:box-shadow .18s ease,filter .2s ease,opacity .22s ease;
  box-shadow:0 10px 26px rgba(180,104,66,.22), inset 0 0 0 1px rgba(255,255,255,.5), inset 0 -6px 16px rgba(180,92,54,.18)}
html[data-mb-theme="dark"] .mb-node{box-shadow:0 12px 30px rgba(0,0,0,.42), inset 0 0 0 1px rgba(255,255,255,.16), inset 0 -8px 18px rgba(0,0,0,.25)}
.mb-node::before{content:'';position:absolute;inset:17% 20% 48% 24%;border-radius:50%;
  background:radial-gradient(circle at 50% 40%, rgba(255,255,255,.9), rgba(255,255,255,0) 72%);pointer-events:none}
.mb-node::after{content:'';position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 2px transparent;transition:box-shadow .16s ease;pointer-events:none}
.mb-node:hover::after,.mb-node.sel::after{box-shadow:inset 0 0 0 2px rgba(255,255,255,.85), inset 0 0 22px rgba(255,244,232,.6)}
.mb-node.dimmed{opacity:.16;filter:saturate(.4)}
.mb-node.pinned{filter:drop-shadow(0 0 12px rgba(255,196,140,.75))}
.mb-label{position:absolute;text-align:center;pointer-events:none;line-height:1.28;color:var(--mb-ink);
  text-shadow:0 1px 0 rgba(255,255,255,.55);font-weight:560;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
html[data-mb-theme="dark"] .mb-label{text-shadow:0 1px 2px rgba(0,0,0,.5)}
.mb-label .kw{display:block;font-size:.86em;font-weight:450;color:var(--mb-ink-soft)}
.mb-legend{position:absolute;right:14px;bottom:50px;display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;
  background:var(--mb-card);border:1px solid var(--mb-line);font-size:11px;color:var(--mb-ink-soft);backdrop-filter:blur(8px);pointer-events:none}
.mb-legend b{color:var(--mb-ink);font-weight:600}
.mb-zoom-pill{position:absolute;right:14px;bottom:14px;padding:5px 11px;border-radius:999px;background:var(--mb-card);
  border:1px solid var(--mb-line);font-size:11px;color:var(--mb-ink-soft);pointer-events:none}
.mb-tray{position:absolute;left:14px;bottom:14px;z-index:9;display:flex;align-items:center;gap:8px;
  max-width:min(66%,540px);padding:5px 6px 5px 10px;border-radius:14px;border:1px solid var(--mb-line);
  background:var(--mb-card);box-shadow:0 10px 24px rgba(120,74,48,.14);backdrop-filter:blur(10px);font-size:11.5px}
.mb-tray-label{font-size:11px;color:var(--mb-ink-soft);white-space:nowrap;display:flex;align-items:center;gap:5px}
.mb-tray-badge{background:var(--mb-coral-soft);color:var(--mb-coral);border-radius:999px;padding:0 6px;font-weight:600;font-size:10.5px}
.mb-tray-chips{display:flex;gap:5px;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.mb-tray-chips::-webkit-scrollbar{display:none}
.mb-tray-more{position:relative;flex:none}
.mb-tray-menu{position:absolute;right:0;bottom:calc(100% + 8px);width:224px;padding:10px 12px;border-radius:14px;
  background:var(--mb-card-strong);border:1px solid var(--mb-line);box-shadow:var(--mb-shadow);
  display:flex;flex-direction:column;gap:9px;font-size:11.5px;z-index:30}
.mb-tray-menu .row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.mb-chip{display:inline-flex;align-items:center;gap:5px;background:var(--mb-card);border:1px solid var(--mb-line);
  border-radius:999px;padding:2px 8px;font-size:11px;max-width:150px;flex:none}
.mb-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb-chip button{border:0;background:transparent;color:var(--mb-ink-soft);cursor:pointer;font-size:12px;padding:0 0 0 2px}
.mb-card{position:absolute;top:74px;right:16px;width:330px;max-height:calc(100% - 150px);overflow:auto;z-index:20;
  border-radius:22px;background:var(--mb-card-strong);border:1px solid var(--mb-line);box-shadow:var(--mb-shadow);padding:18px;backdrop-filter:blur(14px)}
.mb-card h3{margin:0 0 4px;font-size:15px;font-weight:650;line-height:1.35}
.mb-card .meta{font-size:11px;color:var(--mb-ink-soft);margin-bottom:10px}
.mb-card .summary{font-size:12.5px;line-height:1.6;color:var(--mb-ink);margin:10px 0;white-space:pre-wrap}
.mb-card .section-label{font-size:10.5px;letter-spacing:.1em;color:var(--mb-ink-soft);text-transform:uppercase;margin:14px 0 6px}
.mb-card .row{display:flex;align-items:center;gap:8px;margin:10px 0}
.mb-card input[type=range]{flex:1;accent-color:var(--mb-coral)}
.mb-card input[type=text],.mb-card textarea,.mb-card select{width:100%;border:1px solid var(--mb-line);background:var(--mb-chip);
  color:var(--mb-ink);border-radius:10px;padding:7px 9px;font-size:12.5px;outline:none;font-family:inherit}
.mb-card textarea{min-height:74px;resize:vertical;line-height:1.6}
.mb-card .actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
.mb-chips{display:flex;flex-wrap:wrap;gap:5px}
.mb-kw{background:var(--mb-chip);border:1px solid var(--mb-line);border-radius:999px;padding:2px 9px;font-size:11px}
.mb-close{position:absolute;top:10px;right:12px;border:0;background:transparent;color:var(--mb-ink-soft);font-size:16px;cursor:pointer}
.mb-pop{position:absolute;z-index:30;right:16px;top:64px;width:300px;border-radius:18px;background:var(--mb-card-strong);
  border:1px solid var(--mb-line);box-shadow:var(--mb-shadow);padding:16px;backdrop-filter:blur(14px)}
.mb-pop label{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;margin:9px 0;color:var(--mb-ink)}
.mb-pop input[type=number]{width:92px;border:1px solid var(--mb-line);background:var(--mb-chip);color:var(--mb-ink);
  border-radius:8px;padding:5px 8px;font-size:12px}
.mb-pop select{border:1px solid var(--mb-line);background:var(--mb-chip);color:var(--mb-ink);border-radius:8px;padding:5px 8px;font-size:12px}
.mb-switch{position:relative;width:38px;height:22px;border-radius:999px;background:rgba(140,110,90,.22);border:0;cursor:pointer;transition:background .18s ease;flex:none}
.mb-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s ease;box-shadow:0 2px 6px rgba(0,0,0,.2)}
.mb-switch.on{background:var(--mb-coral)}
.mb-switch.on::after{transform:translateX(16px)}
.mb-drawer{position:absolute;z-index:25;left:50%;bottom:70px;transform:translateX(-50%);width:min(640px,86%);
  border-radius:20px;background:var(--mb-card-strong);border:1px solid var(--mb-line);box-shadow:var(--mb-shadow);padding:16px 18px}
.mb-drawer pre{margin:8px 0 0;white-space:pre-wrap;font-size:12px;line-height:1.7;color:var(--mb-ink);max-height:240px;overflow:auto;font-family:ui-monospace,Consolas,monospace}
.mb-toasts{position:absolute;left:50%;bottom:78px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:40;align-items:center;pointer-events:none}
.mb-toast{background:rgba(66,46,36,.9);color:#fff7ee;border-radius:999px;padding:8px 16px;font-size:12px;box-shadow:0 10px 26px rgba(60,34,20,.28);
  animation:mb-toast-in .18s ease}
html[data-mb-theme="dark"] .mb-toast{background:rgba(20,14,12,.92);color:#ffe9d8}
@keyframes mb-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.mb-trigger{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--mb-line);background:var(--mb-card);
  color:var(--mb-ink);border-radius:999px;padding:5px 11px 5px 8px;font-size:12px;cursor:pointer;transition:transform .12s ease}
.mb-trigger:hover{transform:translateY(-1px)}
.mb-trigger .dot{width:16px;height:16px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff3e4,#ffc39b 45%,#f4885c 100%);
  box-shadow:0 2px 6px rgba(238,122,84,.5)}
.mb-trigger b{font-weight:650}
.mb-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--mb-ink-soft);font-size:13px}
.mb-empty .bubble{width:76px;height:76px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff5e9,#ffd9b8 30%,#f9a97b 70%,#ee7a54 100%);
  box-shadow:0 14px 40px rgba(238,122,84,.4);animation:mb-breathe 3.4s ease-in-out infinite}
@keyframes mb-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
@media (prefers-reduced-motion:reduce){.mb-empty .bubble{animation:none}.mb-toast{animation:none}}
.mb-banner{display:flex;align-items:center;gap:12px;padding:8px 20px;font-size:12px;color:var(--mb-ink-soft);
  background:var(--mb-chip);border-bottom:1px solid var(--mb-line);flex:none}
.mb-banner span{flex:1}
/* 窄窗自适应：搜索独占一行、顶栏收紧、图例让位 */
@container (max-width:620px){
  .mb-header{padding:10px 12px 4px;gap:8px}
  .mb-toolbar{padding:0 12px 8px;gap:6px}
  .mb-logo{width:28px;height:28px}
  .mb-title{font-size:14px}
  .mb-title small,.mb-sub{display:none}
  .mb-header select{max-width:150px!important}
  .mb-seg button{padding:3px 8px;font-size:11px}
  .mb-search{flex:1 1 100%;max-width:none;order:-1;padding:6px 12px}
  .mb-toolbar .mb-btn{padding:6px 11px;font-size:11.5px}
  .mb-icon-btn{width:28px;height:28px}
  .mb-legend,.mb-zoom-pill{display:none}
  .mb-tray{left:10px;bottom:10px;max-width:calc(100% - 20px)}
  .mb-card{right:10px;top:96px;width:min(330px,calc(100% - 20px))}
}
.mb-settings{display:flex;flex-direction:column;gap:14px;padding:6px 2px;max-width:560px;color:var(--mb-ink);font-size:13px}
.mb-settings h4{margin:0;font-size:14px}
.mb-settings p{margin:0;font-size:12px;color:var(--mb-ink-soft);line-height:1.6}
.mb-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;border:1px solid var(--mb-line);border-radius:14px;background:var(--mb-card)}
.mb-settings input[type=number],.mb-settings select{border:1px solid var(--mb-line);background:var(--mb-chip);color:var(--mb-ink);border-radius:8px;padding:5px 8px;font-size:12px}
.mb-settings .hint{font-size:11px;color:var(--mb-ink-soft)}
/* 浮窗：可拖动、可缩放、页面内关闭；默认不打开 */
.mb-window{position:fixed;z-index:60;display:flex;flex-direction:column;min-width:380px;min-height:360px;
  border-radius:24px;background:var(--mb-bg);border:1px solid var(--mb-line);box-shadow:0 26px 70px rgba(120,74,48,.24);
  overflow:hidden;animation:mb-win-in .18s ease}
@keyframes mb-win-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
html[data-mb-theme="dark"] .mb-window{box-shadow:0 26px 70px rgba(0,0,0,.5)}
.mb-winbar{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px;cursor:move;flex:none;user-select:none;
  border-bottom:1px solid var(--mb-line);background:var(--mb-card);color:var(--mb-ink)}
.mb-winbar .dot{width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff3e4,#ffc39b 45%,#f4885c 100%);box-shadow:0 2px 6px rgba(238,122,84,.5)}
.mb-winbar b{font-size:13px;font-weight:650}
.mb-winbar .sub{font-size:10.5px;color:var(--mb-ink-soft);opacity:.8}
.mb-win-actions{margin-left:auto;display:flex;align-items:center;gap:6px}
.mb-win-btn{width:26px;height:26px;border-radius:50%;border:1px solid var(--mb-line);background:var(--mb-card-strong);
  color:var(--mb-ink-soft);cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center}
.mb-win-btn:hover{color:var(--mb-coral);border-color:var(--mb-coral)}
.mb-window-body{position:relative;flex:1;min-height:0}
.mb-window .mb-root{position:absolute;inset:0;border:0;border-radius:0;box-shadow:none}
.mb-rz{position:absolute;z-index:6;touch-action:none}
.mb-rz.n{left:12px;right:12px;top:0;height:7px;cursor:ns-resize}
.mb-rz.s{left:12px;right:12px;bottom:0;height:7px;cursor:ns-resize}
.mb-rz.w{top:12px;bottom:12px;left:0;width:7px;cursor:ew-resize}
.mb-rz.e{top:12px;bottom:12px;right:0;width:7px;cursor:ew-resize}
.mb-rz.nw{left:0;top:0;width:14px;height:14px;cursor:nwse-resize}
.mb-rz.ne{right:0;top:0;width:14px;height:14px;cursor:nesw-resize}
.mb-rz.sw{left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize}
.mb-rz.se{right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize}
.mb-side-entry{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;
  border:1px solid var(--mb-line);background:var(--mb-card);cursor:pointer;padding:0}
.mb-side-entry .dot{width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#fff3e4,#ffc39b 45%,#f4885c 100%);
  box-shadow:0 2px 8px rgba(238,122,84,.45)}
.mb-side-entry.on{border-color:var(--mb-coral);box-shadow:0 0 0 2px rgba(244,113,77,.18)}
.mb-side-entry:hover .dot{transform:scale(1.06)}
`

    function ensureStyle() {
      let el = document.querySelector('style[data-memory-bubble]')
      if (!el) {
        el = document.createElement('style')
        el.setAttribute('data-memory-bubble', '')
        el.textContent = CSS
        document.head.appendChild(el)
      }
      return el
    }

    /* ------------------------------------------------------------ 通用小组件 */

    function ToastStack({ toasts }) {
      return h('div', { className: 'mb-toasts' }, toasts.map((toast) =>
        h('div', { key: toast.id, className: 'mb-toast' }, toast.text)))
    }

    function Switch({ on, onClick, title }) {
      return h('button', { className: 'mb-switch' + (on ? ' on' : ''), onClick, title, type: 'button' })
    }

    function Chip({ node, onRemove }) {
      const palette = tonePalette(node.tone)
      return h('span', { className: 'mb-chip' },
        h('i', { style: { width: 8, height: 8, borderRadius: '50%', background: `linear-gradient(135deg, ${palette[0]}, ${palette[1]})`, flex: 'none' } }),
        h('span', null, node.title),
        onRemove ? h('button', { onClick: onRemove, title: '移出托盘' }, '×') : null)
    }

    /* ------------------------------------------------------------ 主面板 */

    function GraphPanel({ ctx }) {
      const scheme = useColorScheme(ctx)
      useEffect(() => {
        document.documentElement.dataset.mbTheme = scheme === 'dark' ? 'dark' : 'light'
      }, [scheme])

      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [scope, setScope] = useState('session')
      const [sessionId, setSessionId] = useState(store.sessionId || '')
      const [search, setSearch] = useState('')
      const [selected, setSelected] = useState(null)
      const [toasts, setToasts] = useState([])
      const [busy, setBusy] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [digestOpen, setDigestOpen] = useState(false)
      const [confirmUndo, setConfirmUndo] = useState(false)
      const [confirmForget, setConfirmForget] = useState(false)
      const [trayMenu, setTrayMenu] = useState(false)
      const viewportRef = useRef(null)
      const viewRef = useRef({ ox: 0, oy: 0, scale: 1 })
      const dragRef = useRef(null)
      const [view, setView] = useState(viewRef.current)
      const toastId = useRef(0)

      const toast = useCallback((text) => {
        const id = ++toastId.current
        setToasts((list) => [...list, { id, text }])
        setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), 2600)
      }, [])

      const patchView = useCallback((next) => {
        viewRef.current = Object.assign({}, viewRef.current, next)
        setView(viewRef.current)
      }, [])

      const fitView = useCallback((layout) => {
        const viewport = viewportRef.current
        if (!viewport || !layout) return
        const width = viewport.clientWidth || 800
        const height = viewport.clientHeight || 600
        const scale = clamp(Math.min(width / layout.width, height / layout.height) * 0.88, 0.32, 2.4)
        const ox = (width - layout.width * scale) / 2
        const oy = (height - layout.height * scale) / 2
        viewRef.current.manual = false
        patchView({ ox, oy, scale })
      }, [patchView])

      const load = useCallback(async (opts) => {
        const silent = opts && opts.silent
        if (!silent) setError('')
        try {
          const sid = (opts && opts.sessionId) || sessionId || store.sessionId || ''
          const wanted = (opts && opts.scope) || scope
          const effective = !sid && wanted === 'session' ? 'all' : wanted
          const response = await api(`/graph?sessionId=${encodeURIComponent(sid)}&scope=${encodeURIComponent(effective)}`)
          setData(response)
          if (!sid && response.sessions && response.sessions.length) {
            const first = response.sessions[0]
            setSessionId(first.id)
            store.sessionId = first.id
          }
          if (!silent || !viewRef.current.fitted) {
            fitView(response.layout)
            viewRef.current.fitted = true
          }
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }, [fitView, scope, sessionId])

      useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
      useEffect(() => {
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          if (!busy) void load({ silent: true, sessionId })
        }, 6000)
        return () => clearInterval(timer)
      }, [busy, load, sessionId])

      // 窗口/视口尺寸变化时，图按新比例自适应（用户手动缩放/平移后不再自动抢镜头）
      useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport || typeof ResizeObserver === 'undefined') return
        let timer = 0
        const observer = new ResizeObserver(() => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (!viewRef.current.manual) fitView(data && data.layout)
          }, 120)
        })
        observer.observe(viewport)
        return () => { clearTimeout(timer); observer.disconnect() }
      }, [data, fitView])

      // 浮窗拖动改大小时由 BubbleWindow 广播，作为 ResizeObserver 的兜底
      useEffect(() => {
        if (typeof window === 'undefined') return
        let timer = 0
        const onResize = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (!viewRef.current.manual) fitView(data && data.layout)
          }, 80)
        }
        window.addEventListener('memory-bubble:resize', onResize)
        return () => { clearTimeout(timer); window.removeEventListener('memory-bubble:resize', onResize) }
      }, [data, fitView])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') { setSelected(null); setSettingsOpen(false); setDigestOpen(false); setSearch('') }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const nodes = data && data.layout ? data.layout.nodes : []
      const edges = data && data.layout ? data.layout.edges : []
      const session = (data && data.session) || { enabled: true, tray: [] }
      const config = (data && data.config) || {}
      const stats = (data && data.stats) || { totalNodes: 0 }
      const autoOn = (data && data.auto === true) || config.auto === true
      const scale = view.scale
      const tier = tierOf(scale)

      const enableAuto = async () => {
        try {
          await api('/config', { method: 'POST', body: JSON.stringify({ config: { auto: true } }) })
          if (sessionId) await api('/session', { method: 'POST', body: JSON.stringify({ sessionId, enabled: true }) })
          toast('已开启：只读本会话，聊几轮就会自动长出泡泡')
          await load({ silent: false })
        } catch (err) { toast(String(err.message || err)) }
      }

      // 手动新增：先落下新泡泡，再在页面内弹出编辑小窗（标题/内容/时间/关键词/重要性都可改）
      const addDraft = async () => {
        setBusy('create')
        try {
          const result = await api('/node/create', {
            method: 'POST',
            body: JSON.stringify({ title: '新记忆', summary: '', keywords: [], importance: 55, sessionId: sessionId || 'manual', createdAt: new Date().toISOString() }),
          })
          await load({ silent: true, sessionId })
          if (result && result.id) setSelected({ type: 'node', id: result.id })
          toast('新泡泡出现了，填好内容点保存')
        } catch (err) { toast(String(err.message || err)) } finally { setBusy('') }
      }

      const searchKey = search.trim().toLowerCase()
      const matched = new Set()
      if (searchKey) {
        for (const node of nodes) {
          const haystack = `${node.title} ${node.summary} ${(node.keywords || []).join(' ')}`.toLowerCase()
          if (haystack.includes(searchKey)) matched.add(node.id)
        }
      }

      const nodeById = new Map(nodes.map((node) => [node.id, node]))
      const edgeById = new Map(edges.map((edge) => [edge.id, edge]))
      const selectedNode = selected && selected.type === 'node'
        ? (selected.id === '__new__'
          ? { id: '__new__', title: '', summary: '', keywords: [], importance: 55, kind: 'fact', created: new Date().toISOString(), hits: 1 }
          : nodeById.get(selected.id))
        : null
      const selectedEdge = selected && selected.type === 'edge' ? edgeById.get(selected.id) : null

      const onWheel = (event) => {
        event.preventDefault()
        const viewport = viewportRef.current
        if (!viewport) return
        const rect = viewport.getBoundingClientRect()
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        const current = viewRef.current
        const nextScale = clamp(current.scale * Math.exp(-event.deltaY * 0.0012), 0.3, 2.4)
        const ratio = nextScale / current.scale
        viewRef.current.manual = true
        patchView({
          scale: nextScale,
          ox: px - (px - current.ox) * ratio,
          oy: py - (py - current.oy) * ratio,
        })
      }

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('.mb-node')) return
        if (event.target && event.target.closest && event.target.closest('.mb-edge-hit')) return
        dragRef.current = { x: event.clientX, y: event.clientY, ox: viewRef.current.ox, oy: viewRef.current.oy, moved: false }
        event.currentTarget.classList.add('dragging')
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        if (Math.abs(dx) + Math.abs(dy) > 2) { drag.moved = true; viewRef.current.manual = true }
        patchView({ ox: drag.ox + dx, oy: drag.oy + dy })
      }

      const endDrag = (event) => {
        if (event && event.currentTarget && event.currentTarget.classList) event.currentTarget.classList.remove('dragging')
        dragRef.current = null
      }

      const addToTray = async (nodeId) => {
        if (!sessionId) { toast('先在顶部选择/打开一个会话'); return }
        try {
          await api('/tray', { method: 'POST', body: JSON.stringify({ sessionId, add: nodeId }) })
          await load({ silent: true, sessionId })
          const node = nodeById.get(nodeId)
          toast(`已把「${node ? node.title : nodeId}」放进托盘，会进入本轮记忆简报`)
        } catch (err) { toast(String(err.message || err)) }
      }

      const removeFromTray = async (nodeId) => {
        try {
          await api('/tray', { method: 'POST', body: JSON.stringify({ sessionId, remove: nodeId }) })
          await load({ silent: true, sessionId })
        } catch (err) { toast(String(err.message || err)) }
      }

      const runExtract = async () => {
        if (!sessionId) { toast('先在顶部选择/打开一个会话'); return }
        setBusy('extract')
        try {
          const result = await api('/extract', { method: 'POST', body: JSON.stringify({ sessionId, force: true }) })
          if (result.ok) {
            toast(`AI 记下了 ${result.created + result.updated} 条记忆${result.created ? '，新增 ' + result.created + ' 条' : ''}`)
          } else {
            toast(`总结失败：${result.error || '未知原因'}`)
          }
          await load({ silent: true, sessionId })
        } catch (err) { toast(String(err.message || err)) } finally { setBusy('') }
      }

      const undoLast = async () => {
        if (!confirmUndo) { setConfirmUndo(true); setTimeout(() => setConfirmUndo(false), 3000); return }
        setConfirmUndo(false)
        setBusy('undo')
        try {
          const result = await api('/rollback', { method: 'POST', body: JSON.stringify({ sessionId }) })
          toast(`已撤销上一批：移除 ${result.removed} 条新建，回滚 ${result.restored} 条修改`)
          await load({ silent: true, sessionId })
        } catch (err) { toast(String(err.message || err)) } finally { setBusy('') }
      }

      const exportAll = async () => {
        try {
          const result = await api('/export')
          const blob = new Blob([JSON.stringify(result.graph, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `memory-bubble-${Date.now()}.json`
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          toast(result.file ? `已导出，同时保存到 ${result.file}` : '已导出记忆图')
        } catch (err) { toast(String(err.message || err)) }
      }

      const importFile = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        file.text().then(async (text) => {
          try {
            const report = await api('/import', { method: 'POST', body: JSON.stringify({ graph: JSON.parse(text) }) })
            toast(`继承完成：合并 ${report.report.nodes} 条记忆、${report.report.edges} 条关系`)
            await load({ silent: true, sessionId })
          } catch (err) { toast(String(err.message || err)) }
        }).catch((err) => toast(String(err.message || err)))
      }

      const sessionOptions = (data && data.sessions) || []
      const trayNodes = (session.tray || []).map((id) => nodeById.get(id)).filter(Boolean)

      const header = h('div', { className: 'mb-header' },
        h('div', { className: 'mb-brand' },
          h('div', { className: 'mb-logo' }),
          h('div', null,
            h('div', { className: 'mb-title' }, '忆泡', h('small', null, 'MEMORY BUBBLE')),
            h('div', { className: 'mb-sub' }, '把对话里的记忆，养在一张会呼吸的图里'))),
        h('div', { className: 'mb-spacer' }),
        sessionOptions.length
          ? h('select', {
            value: sessionId,
            onChange: (event) => {
              const next = event.target.value
              setSessionId(next)
              store.sessionId = next
              void load({ sessionId: next })
            },
            style: { maxWidth: 210, border: '1px solid var(--mb-line)', background: 'var(--mb-card)', color: 'var(--mb-ink)', borderRadius: 999, padding: '6px 10px', fontSize: 12 },
          }, sessionOptions.map((item) => h('option', { key: item.id, value: item.id },
            `${item.title || item.id.slice(0, 8)} · ${item.extractCount || 0} 次`)))
          : null,
        h('div', { className: 'mb-seg' },
          h('button', { className: scope === 'session' ? 'on' : '', onClick: () => { setScope('session'); void load({ scope: 'session' }) } }, '本会话'),
          h('button', { className: scope === 'all' ? 'on' : '', onClick: () => { setScope('all'); void load({ scope: 'all' }) } }, '全部记忆')))

      const toolbar = h('div', { className: 'mb-toolbar' },
        h('div', { className: 'mb-search' },
          h('span', { style: { opacity: 0.55 } }, '⌕'),
          h('input', {
            value: search,
            placeholder: '搜索记忆、关键词或摘要…',
            onChange: (event) => setSearch(event.target.value),
          }),
          matched.size && searchKey ? h('span', { style: { fontSize: 11, color: 'var(--mb-coral)', whiteSpace: 'nowrap' } }, `命中 ${matched.size} 条`) : null),
        h('button', { className: 'mb-btn' + (confirmUndo ? ' danger' : ''), onClick: undoLast, disabled: busy === 'undo', title: '撤销最近一次 AI 总结' }, confirmUndo ? '再点一次确认' : '撤销'),
        h('button', { className: 'mb-btn primary', onClick: runExtract, disabled: busy === 'extract', title: '立即用当前模型总结一段新记忆' }, busy === 'extract' ? '总结中…' : '立即总结'),
        h('button', { className: 'mb-icon-btn', onClick: () => setDigestOpen(!digestOpen), title: '查看本轮记忆简报' }, '☰'),
        h('button', { className: 'mb-icon-btn', onClick: () => setSettingsOpen(!settingsOpen), title: '设置' }, '⚙'),
        h('label', { className: 'mb-icon-btn', title: '导入记忆图（继承）', style: { cursor: 'pointer' } },
          '⤓', h('input', { type: 'file', accept: 'application/json', style: { display: 'none' }, onChange: importFile })),
        h('button', { className: 'mb-icon-btn', onClick: exportAll, title: '导出记忆图' }, '⤒'))

      const stage = h('div', { className: 'mb-stage', style: { width: 760, height: 560, transform: `translate(${view.ox}px, ${view.oy}px) scale(${scale})` } },
        h('svg', { className: 'mb-edges', width: 760, height: 560 },
          edges.map((edge) => {
            const from = nodeById.get(edge.from)
            const to = nodeById.get(edge.to)
            if (!from || !to) return null
            const conflict = edge.conflict === true
            const hot = selected && selected.type === 'edge' && selected.id === edge.id
            return h('g', { key: edge.id },
              h('line', {
                x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                className: 'mb-edge-line' + (conflict ? ' conflict' : '') + (hot ? ' hot' : ''),
              }),
              h('line', {
                x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                className: 'mb-edge-hit',
                onClick: (event) => { event.stopPropagation(); setSelected({ type: 'edge', id: edge.id }) },
              }))
          })),
        nodes.map((node) => {
          const palette = tonePalette(node.tone)
          const dim = searchKey && matched.size && !matched.has(node.id)
          const pinned = (session.tray || []).includes(node.id)
          const isSelected = selected && selected.type === 'node' && selected.id === node.id
          return h('div', {
            key: node.id,
            className: 'mb-node' + (dim ? ' dimmed' : '') + (isSelected ? ' sel' : '') + (pinned ? ' pinned' : ''),
            style: {
              left: node.x - node.r,
              top: node.y - node.r,
              width: node.r * 2,
              height: node.r * 2,
              background: `radial-gradient(circle at 32% 26%, rgba(255,255,255,.88), rgba(255,255,255,0) 46%), radial-gradient(circle at 52% 55%, ${palette[0]}, ${palette[1]})`,
              opacity: tier.key === 'far' ? 0.92 : 1,
            },
            onClick: (event) => {
              event.stopPropagation()
              if (event.shiftKey) { void addToTray(node.id); return }
              setSelected({ type: 'node', id: node.id })
            },
            title: node.title,
          }, tier.key === 'near'
            ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: '50%' } },
              h('span', { style: { fontSize: clamp(node.r * 0.32, 9, 15), color: 'rgba(96,56,36,.72)', fontWeight: 600, padding: '0 6px', textAlign: 'center', lineHeight: 1.2 } }, node.title))
            : null)
        }),
        nodes.map((node) => {
          if (tier.key === 'far') return null
          const dim = searchKey && matched.size && !matched.has(node.id)
          if (dim) return null
          const maxWidth = node.r * 2 + 70
          return h('div', {
            key: node.id + '-label',
            className: 'mb-label',
            style: {
              left: node.x - maxWidth / 2,
              top: node.y + node.r + 4,
              width: maxWidth,
              fontSize: 12 / scale,
              opacity: tier.key === 'far' ? 0 : 1,
            },
          },
            tier.key === 'mid' ? shortTitle(node.title) : node.title,
            tier.key === 'near' && (node.keywords || []).length
              ? h('span', { className: 'kw' }, (node.keywords || []).slice(0, 3).map((keyword) => `#${keyword}`).join(' '))
              : null)
        }))

      const emptyPanel = scope === 'session' && stats.totalNodes > 0
        ? h('div', { className: 'mb-empty' },
          h('div', { className: 'bubble' }),
          h('div', null, '本会话还没有记忆泡泡'),
          h('div', { style: { fontSize: 12, opacity: 0.78, textAlign: 'center', maxWidth: 360, lineHeight: 1.75 } },
            `本会话从零开始记录。其他会话里已有 ${stats.totalNodes} 条记忆，但它们不会跑进来——这是故意的，防止串话。`),
          h('div', { style: { display: 'flex', gap: 10, marginTop: 4 } },
            h('button', { className: 'mb-btn ghost', onClick: () => { setScope('all'); void load({ scope: 'all' }) } }, '看看其他会话的记忆'),
            sessionId ? h('button', { className: 'mb-btn ghost', onClick: () => { void load({ silent: false }) } }, '刷新') : null))
        : h('div', { className: 'mb-empty' },
          h('div', { className: 'bubble' }),
          h('div', null, autoOn ? '聊起来，泡泡就会长出来' : '忆泡刚装好，还是空的'),
          h('div', { style: { fontSize: 12, opacity: 0.8, textAlign: 'center', maxWidth: 420, lineHeight: 1.8 } },
            autoOn
              ? '只记录本会话、且只在你说了话之后才会总结；开局没有任何预置人设或记忆，所以它不会假装认识你。'
              : '忆泡不会凭空编记忆。开启后，它只在你说过话的会话里自动总结；也可以先手动记一条试试。'),
          h('div', { style: { display: 'flex', gap: 10, marginTop: 6 } },
            autoOn ? null : h('button', { className: 'mb-btn primary', onClick: () => { void enableAuto() } }, '开启读取对话'),
            h('button', { className: 'mb-btn ghost', onClick: () => { void addDraft() } }, '＋ 手动记一条'),
            h('button', { className: 'mb-btn ghost', onClick: () => { setDigestOpen(true) } }, '看看简报长什么样')))

      const banner = !autoOn && stats.totalNodes > 0
        ? h('div', { className: 'mb-banner' },
          h('span', null, '自动读取对话已关闭：忆泡只会记你手动添加的内容。'),
          h('button', { className: 'mb-btn ghost', onClick: () => { void enableAuto() } }, '开启自动读取'))
        : null

      const viewport = h('div', {
        ref: viewportRef,
        className: 'mb-viewport',
        onWheel,
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerLeave: endDrag,
        onDoubleClick: () => fitView(data && data.layout),
      },
        nodes.length ? stage : emptyPanel,
        h('div', { className: 'mb-legend' }, h('span', null, '大 = 重要'), h('span', { style: { opacity: 0.5 } }, '·'), h('span', null, '中心 = 高频'), h('span', { style: { opacity: 0.5 } }, '·'), h('b', null, tier.label)),
        h('div', { className: 'mb-zoom-pill' }, `${Math.round(scale * 100)}% · 滚轮缩放 · 双击适应`),
        h('button', {
          className: 'mb-btn primary',
          title: '手动新增/编辑一条记忆；自动生成由设置里的开关控制，不会走这个按钮',
          style: { position: 'absolute', right: 18, top: 18, boxShadow: '0 10px 26px rgba(244,113,77,.3)' },
          onClick: () => { void addDraft() },
        }, '＋ 手动记一条'))

      const trayStatus = session.pending ? '总结中…'
        : session.lastError ? '上次失败'
          : session.lastExtractAt ? `上次 ${fmtDate(session.lastExtractAt)}`
            : '尚未总结'

      const tray = sessionId
        ? h('div', { className: 'mb-tray' },
          h('div', { className: 'mb-tray-label' },
            '托盘', trayNodes.length ? h('span', { className: 'mb-tray-badge' }, String(trayNodes.length)) : null),
          h('div', { className: 'mb-tray-chips' },
            trayNodes.length
              ? trayNodes.map((node) => h(Chip, { key: node.id, node, onRemove: () => removeFromTray(node.id) }))
              : h('span', { style: { fontSize: 11, color: 'var(--mb-ink-soft)', opacity: 0.7, whiteSpace: 'nowrap' } }, 'Shift 点泡泡加入')),
          h('div', { className: 'mb-tray-more' },
            h('button', {
              className: 'mb-icon-btn',
              style: { width: 24, height: 24, fontSize: 13 },
              title: '托盘与自动生成状态',
              onClick: (event) => { event.stopPropagation(); setTrayMenu(!trayMenu) },
            }, '⋯'),
            trayMenu
              ? h('div', { className: 'mb-tray-menu' },
                h('div', { className: 'row' },
                  h('span', null, '本会话自动生成'),
                  h(Switch, { on: session.enabled !== false, onClick: async () => {
                    try {
                      await api('/session', { method: 'POST', body: JSON.stringify({ sessionId, enabled: session.enabled === false }) })
                      await load({ silent: true, sessionId })
                      toast(session.enabled === false ? '本会话已恢复自动生成' : '本会话已暂停自动生成')
                    } catch (err) { toast(String(err.message || err)) }
                  } })),
                h('div', { className: 'row' },
                  h('span', null, '本会话记忆'),
                  h('span', { style: { opacity: 0.75 } }, String(stats.sessionNodes || 0) + ' 条')),
                h('div', { className: 'row' },
                  h('span', null, '最近生成'),
                  h('span', { style: { opacity: 0.75 } }, trayStatus)),
                h('div', { className: 'row', style: { marginTop: 2 } },
                  h('button', { className: 'mb-btn ghost', onClick: () => { setTrayMenu(false); setDigestOpen(true) } }, '预览简报'),
                  (stats.sessionNodes || 0) > 0
                    ? h('button', { className: 'mb-btn ghost' + (confirmForget ? ' danger' : ''), onClick: async () => {
                      if (!confirmForget) { setConfirmForget(true); setTimeout(() => setConfirmForget(false), 3000); return }
                      try {
                        const result = await api('/session/forget', { method: 'POST', body: JSON.stringify({ sessionId }) })
                        setConfirmForget(false)
                        setTrayMenu(false)
                        toast(`已清空本会话的 ${result.removed || 0} 条记忆`)
                        await load({ silent: false, sessionId })
                      } catch (err) { toast(String(err.message || err)) }
                    } }, confirmForget ? '确认清空？' : '清空本会话')
                    : null))
              : null))
        : null

      const card = selectedNode
        ? h(NodeCard, { key: selectedNode.id === '__new__' ? 'new' : selectedNode.id, node: selectedNode, sessionId, onClose: () => setSelected(null), onReload: (silent) => load({ silent: true, sessionId }), toast })
        : selectedEdge
          ? h(EdgeCard, { key: selectedEdge.id, edge: selectedEdge, sessionId, onClose: () => setSelected(null), onReload: (silent) => load({ silent: true, sessionId }), toast })
          : null

      const pop = settingsOpen
        ? h('div', { className: 'mb-pop' }, h(ConfigForm, { config, onSaved: (next) => { setData((current) => current ? Object.assign({}, current, { config: next }) : current); toast('设置已保存') }, toast }))
        : null

      const drawer = digestOpen
        ? h('div', { className: 'mb-drawer' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '本轮记忆简报（只含本会话）'),
            h('button', { className: 'mb-close', style: { position: 'static' }, onClick: () => setDigestOpen(false) }, '✕')),
          h('pre', null, (data && data.digest) || '（还没有简报：先聊几轮，或点「立即总结」）'))
        : null

      if (error && !data) {
        return h('div', { className: 'mb-root' },
          h('div', { className: 'mb-empty' }, h('div', { className: 'bubble' }), h('div', null, '忆泡加载失败'), h('div', { style: { fontSize: 12, opacity: 0.8 } }, error),
            h('button', { className: 'mb-btn primary', onClick: () => void load() }, '重试')))
      }

      return h('div', { className: 'mb-root', 'data-mb-theme': scheme },
        header,
        toolbar,
        banner,
        viewport,
        tray,
        card,
        pop,
        drawer,
        h(ToastStack, { toasts }))
    }

    /* ------------------------------------------------------------ 浮窗壳 */

    function BubbleWindow({ ctx }) {
      const state = useWindowState()
      const [rect, setRect] = useState(() => clampRect(win.rect))
      const dragRef = useRef(null)
      const [active, setActive] = useState(false)

      useEffect(() => {
        if (!state.open) return
        setRect(clampRect(win.rect))
      }, [state.open])

      if (!state.open) return null

      const notifyResize = () => {
        try { window.dispatchEvent(new CustomEvent('memory-bubble:resize')) } catch { /* ignore */ }
      }

      const move = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (drag.mode === 'move') {
          setRect(clampRect(Object.assign({}, drag.base, { x: drag.base.x + dx, y: drag.base.y + dy })))
          return
        }
        // 八方向缩放：拖哪条边/哪个角，就只改对应方向；图会按新比例自适应（ResizeObserver + 本事件兜底）
        const dir = drag.dir || 'se'
        let x = drag.base.x
        let y = drag.base.y
        let w = drag.base.w
        let h = drag.base.h
        if (dir.indexOf('e') >= 0) w = drag.base.w + dx
        if (dir.indexOf('s') >= 0) h = drag.base.h + dy
        if (dir.indexOf('w') >= 0) { w = drag.base.w - dx; x = drag.base.x + dx }
        if (dir.indexOf('n') >= 0) { h = drag.base.h - dy; y = drag.base.y + dy }
        if (w < 380) { if (dir.indexOf('w') >= 0) x = drag.base.x + drag.base.w - 380; w = 380 }
        if (h < 360) { if (dir.indexOf('n') >= 0) y = drag.base.y + drag.base.h - 360; h = 360 }
        setRect(clampRect({ x, y, w, h }))
        notifyResize()
      }
      const end = () => {
        if (!dragRef.current) return
        dragRef.current = null
        setActive(false)
        notifyResize()
        if (typeof window !== 'undefined') {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', end)
        }
        setRect((current) => {
          patchWin({ rect: current })
          return current
        })
      }
      const begin = (mode, event, dir) => {
        if (event.button !== 0) return
        if (mode === 'move' && event.target && event.target.closest && event.target.closest('.mb-win-btn')) return
        event.preventDefault()
        event.stopPropagation()
        dragRef.current = { mode, dir: dir || null, dx: event.clientX - rect.x, dy: event.clientY - rect.y, startX: event.clientX, startY: event.clientY, base: rect }
        setActive(true)
        if (typeof window !== 'undefined') {
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', end)
        }
      }
      const reset = () => {
        win.rect = null
        saveWindowPrefs()
        setRect(clampRect(null))
      }

      return h('div', {
        className: 'mb-window',
        style: { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' },
      },
        h('div', { className: 'mb-winbar', onPointerDown: (event) => begin('move', event) },
          h('span', { className: 'dot' }),
          h('b', null, '忆泡'),
          h('span', { className: 'sub' }, '拖动标题栏移动 · 拖边缘缩放'),
          h('div', { className: 'mb-win-actions' },
            h('button', { className: 'mb-win-btn', title: '回到默认位置与大小', onClick: reset }, '⌂'),
            h('button', { className: 'mb-win-btn', title: '关闭（本会话不再显示；侧栏图标可再打开）', onClick: () => patchWin({ open: false }) }, '✕'))),
        h('div', { className: 'mb-window-body' },
          h(GraphPanel, { ctx }),
          ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((dir) =>
            h('div', { key: dir, className: 'mb-rz ' + dir, title: '拖动改变窗口大小', onPointerDown: (event) => begin('resize', event, dir) }))),
        active ? h('div', { style: { position: 'absolute', inset: 0 } }) : null)
    }

    function SideEntry({ ctx }) {
      const state = useWindowState()
      return h('button', {
        className: 'mb-side-entry' + (state.open ? ' on' : ''),
        title: state.open ? '收起忆泡（不停止本会话记录）' : '打开忆泡记忆图',
        'aria-label': '忆泡',
        onClick: () => patchWin({ open: !win.open }),
      }, h('span', { className: 'dot' }))
    }

    /* ------------------------------------------------------------ 详情卡 */

    function NodeCard({ node, sessionId, onClose, onReload, toast }) {
      const isNew = node.id === '__new__'
      const [title, setTitle] = useState(isNew ? '' : node.title)
      const [summary, setSummary] = useState(isNew ? '' : node.summary || '')
      const [keywords, setKeywords] = useState(isNew ? '' : (node.keywords || []).join('、'))
      const [importance, setImportance] = useState(isNew ? 55 : node.importance || 50)
      const [kind, setKind] = useState(isNew ? 'fact' : node.kind || 'fact')
      const [created, setCreated] = useState(toLocalDateTime(node.created || new Date().toISOString()))
      const [saving, setSaving] = useState(false)
      const [deleteArmed, setDeleteArmed] = useState(false)

      const save = async () => {
        if (!title.trim()) { toast('标题不能为空'); return }
        setSaving(true)
        try {
          if (isNew) {
            await api('/node/create', { method: 'POST', body: JSON.stringify({ title, summary, keywords: keywords.split(/[、,，\s]+/).filter(Boolean), importance, kind, sessionId: sessionId || 'manual', createdAt: fromLocalDateTime(created) }) })
            toast('已种下一颗新泡泡')
          } else {
            await api('/node', { method: 'POST', body: JSON.stringify({ id: node.id, sessionId, patch: { title, summary, keywords: keywords.split(/[、,，\s]+/).filter(Boolean), importance, kind, createdAt: fromLocalDateTime(created) } }) })
            toast('已保存，泡泡大小与简报同步更新')
          }
          onClose()
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) } finally { setSaving(false) }
      }

      const remove = async () => {
        if (!deleteArmed) {
          setDeleteArmed(true)
          setTimeout(() => setDeleteArmed(false), 3000)
          return
        }
        try {
          await api('/node/delete', { method: 'POST', body: JSON.stringify({ id: node.id, sessionId }) })
          toast('已删除这条记忆')
          onClose()
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) }
      }

      const quote = async () => {
        if (!sessionId) { toast('先在顶部选择一个会话'); return }
        try {
          await api('/tray', { method: 'POST', body: JSON.stringify({ sessionId, add: node.id }) })
          toast('已放进记忆托盘')
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) }
      }

      return h('div', { className: 'mb-card', onClick: (event) => event.stopPropagation() },
        h('button', { className: 'mb-close', onClick: onClose }, '✕'),
        h('div', { className: 'meta' }, isNew ? '新记忆' : `${fmtDate(node.created)} · 出现 ${node.hits || 1} 次 · ${KIND_LABELS[node.kind] || '事实'}`),
        isNew || !node.evidence
          ? null
          : h('div', { className: 'section-label', style: { marginTop: 2 } }, '依据（用户原话）'),
        isNew || !node.evidence
          ? null
          : h('div', { style: { fontSize: 11.5, color: 'var(--mb-ink-soft)', lineHeight: 1.6, padding: '2px 2px 4px' } }, `「${node.evidence}」`),
        h('div', { className: 'section-label' }, '标题'),
        h('input', { type: 'text', value: title, maxLength: 40, placeholder: '不超过 12 字最好认', onChange: (event) => setTitle(event.target.value) }),
        h('div', { className: 'section-label' }, '记忆本身'),
        h('textarea', { value: summary, maxLength: 600, placeholder: '1–2 句，离开对话也能看懂', onChange: (event) => setSummary(event.target.value) }),
        h('div', { className: 'section-label' }, '关键词（顿号或空格分隔）'),
        h('input', { type: 'text', value: keywords, placeholder: '猫咖、年糕、橘猫', onChange: (event) => setKeywords(event.target.value) }),
        h('div', { className: 'section-label' }, '类型'),
        h('select', { value: kind, onChange: (event) => setKind(event.target.value) },
          Object.keys(KIND_LABELS).map((key) => h('option', { key, value: key }, KIND_LABELS[key]))),
        h('div', { className: 'section-label' }, '记录时间'),
        h('input', { type: 'datetime-local', value: created, onChange: (event) => setCreated(event.target.value) }),
        h('div', { className: 'section-label' }, `重要性 ${importance}`, isNew ? '' : '（越大越重要，影响泡泡大小与简报排序）'),
        h('div', { className: 'row' },
          h('input', { type: 'range', min: 0, max: 100, value: importance, onChange: (event) => setImportance(Number(event.target.value)) }),
          h('span', { style: { fontSize: 12, color: 'var(--mb-coral)', fontWeight: 600, minWidth: 26, textAlign: 'right' } }, String(importance))),
        isNew ? null : h('div', { style: { fontSize: 11, color: 'var(--mb-ink-soft)', lineHeight: 1.6 } },
          '位置由出现频率和关系决定、不能手动拖动；大小代表重要性，可以拖动上面的滑杆修改权重。'),
        h('div', { className: 'actions' },
          isNew ? null : h('button', { className: 'mb-btn ghost', onClick: quote }, '引用到本轮'),
          h('button', { className: 'mb-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : isNew ? '种下泡泡' : '保存修改'),
          isNew ? null : h('button', { className: 'mb-btn danger', onClick: remove }, deleteArmed ? '再点一次确认删除' : '删除')))
    }

    function EdgeCard({ edge, sessionId, onClose, onReload, toast }) {
      const [summary, setSummary] = useState(edge.summary || '')
      const [relation, setRelation] = useState(edge.relation || '相关')
      const [conflict, setConflict] = useState(edge.conflict === true)
      const [saving, setSaving] = useState(false)
      const [armed, setArmed] = useState(false)

      const save = async () => {
        setSaving(true)
        try {
          await api('/edge', { method: 'POST', body: JSON.stringify({ id: edge.id, sessionId, patch: { summary, relation, conflict } }) })
          toast(conflict ? '已保存；仍有冲突，会提醒模型在后续思考中降低权重' : '已保存，冲突提示已清除')
          onClose()
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) } finally { setSaving(false) }
      }

      const reverify = async () => {
        try {
          await api('/edge', { method: 'POST', body: JSON.stringify({ id: edge.id, sessionId, patch: { conflict: false } }) })
          toast('已核验：冲突提示已清除（仅本机记录）')
          setConflict(false)
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) }
      }

      const remove = async () => {
        if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3000); return }
        try {
          await api('/edge/delete', { method: 'POST', body: JSON.stringify({ id: edge.id, sessionId }) })
          toast('已删除这条关系')
          onClose()
          await onReload(true)
        } catch (err) { toast(String(err.message || err)) }
      }

      return h('div', { className: 'mb-card', onClick: (event) => event.stopPropagation() },
        h('button', { className: 'mb-close', onClick: onClose }, '✕'),
        h('div', { className: 'meta' }, '关系详情'),
        conflict
          ? h('div', { style: { background: 'rgba(201,95,66,.12)', border: '1px solid rgba(201,95,66,.35)', borderRadius: 10, padding: '8px 10px', fontSize: 11.5, lineHeight: 1.6, color: '#b4553b', marginBottom: 6 } },
            '⚠ 这两条记忆存在冲突。后续思考会降低该关系权重；消除冲突后警告会消失。')
          : null,
        h('div', { className: 'section-label' }, '关系'),
        h('select', { value: relation, onChange: (event) => setRelation(event.target.value) },
          ['相关', '因果', '印证', '同主题', '对立', '经历'].map((item) => h('option', { key: item, value: item }, item))),
        h('div', { className: 'section-label' }, '关系说明'),
        h('textarea', { value: summary, maxLength: 400, placeholder: '这两条记忆为什么相连？有冲突就写清冲突在哪。', onChange: (event) => setSummary(event.target.value) }),
        h('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, fontSize: 12 } },
          '标记为「有冲突」',
          h(Switch, { on: conflict, onClick: () => setConflict(!conflict) })),
        h('div', { className: 'actions' },
          h('button', { className: 'mb-btn ghost', onClick: reverify }, '重新校验'),
          h('button', { className: 'mb-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
          h('button', { className: 'mb-btn danger', onClick: remove }, armed ? '再点一次确认' : '删除')))
    }

    /* ------------------------------------------------------------ 设置 */

    function ConfigForm({ config, onSaved, toast }) {
      const [auto, setAuto] = useState(config.auto !== false)
      const [maxNew, setMaxNew] = useState(config.maxPerExtraction || 3)
      const [maxTotal, setMaxTotal] = useState(config.maxTotalNodes || 300)
      const [debounce, setDebounce] = useState(Math.round((config.debounceMs || 15000) / 1000))
      const [minInterval, setMinInterval] = useState(Math.round((config.minIntervalMs || 90000) / 1000))
      const [maxChars, setMaxChars] = useState(config.maxTranscriptChars || 6000)
      const [injection, setInjection] = useState(config.injection || 'digest')
      const [saving, setSaving] = useState(false)

      const save = async () => {
        setSaving(true)
        try {
          const result = await api('/config', { method: 'POST', body: JSON.stringify({ config: { auto, maxPerExtraction: maxNew, maxTotalNodes: maxTotal, debounceMs: debounce * 1000, minIntervalMs: minInterval * 1000, maxTranscriptChars: maxChars, injection } }) })
          onSaved(result.config)
        } catch (err) { toast(String(err.message || err)) } finally { setSaving(false) }
      }

      return h('div', null,
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '忆泡设置'),
        h('label', null, h('span', null, '读取对话并自动生成记忆'), h(Switch, { on: auto, onClick: () => setAuto(!auto) })),
        h('div', { className: 'hint', style: { marginTop: -2 } }, '关闭后忆泡不再读新对话；已有记忆、简报和手动记录仍然可用。每个会话在托盘里还能单独暂停。'),
        h('label', null, h('span', null, '每轮最多生成（条）'), h('input', { type: 'number', min: 1, max: 5, step: 1, value: maxNew, onChange: (event) => setMaxNew(Number(event.target.value) || 3) })),
        h('label', null, h('span', null, '记忆总量上限（条）'), h('input', { type: 'number', min: 20, max: 2000, step: 10, value: maxTotal, onChange: (event) => setMaxTotal(Number(event.target.value) || 300) })),
        h('label', null, h('span', null, '停手后等待（秒）'), h('input', { type: 'number', min: 1, max: 300, value: debounce, onChange: (event) => setDebounce(Number(event.target.value) || 1) })),
        h('label', null, h('span', null, '两次总结最小间隔（秒）'), h('input', { type: 'number', min: 5, max: 3600, value: minInterval, onChange: (event) => setMinInterval(Number(event.target.value) || 5) })),
        h('label', null, h('span', null, '转录长度上限（字符）'), h('input', { type: 'number', min: 500, max: 30000, value: maxChars, onChange: (event) => setMaxChars(Number(event.target.value) || 6000) })),
        h('label', null, h('span', null, '注入方式'),
          h('select', { value: injection, onChange: (event) => setInjection(event.target.value) },
            h('option', { value: 'digest' }, '稳定简报（推荐）'),
            h('option', { value: 'tray' }, '只注入托盘'),
            h('option', { value: 'off' }, '不注入'))),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
          h('button', { className: 'mb-btn primary', onClick: save, disabled: saving }, saving ? '保存中…' : '保存设置')))
    }

    function SettingsSection({ ctx }) {
      const [config, setConfig] = useState(null)
      const [toastText, setToastText] = useState('')
      useEffect(() => {
        api('/config').then((result) => setConfig(result.config)).catch(() => setConfig(null))
      }, [])
      if (!config) return h('div', { className: 'mb-settings' }, h('p', null, '忆泡未连接（插件可能未启用）。'))
      return h('div', { className: 'mb-settings', 'data-mb-theme': document.documentElement.dataset.mbTheme || 'light' },
        h('h4', null, '忆泡 Memory Bubble'),
        h('p', null, '把每天和 AI 的对话沉淀成一张可管理、可继承的记忆泡泡图。位置由出现频率决定，大小由重要性决定。'),
        h(ConfigForm, {
          config,
          onSaved: (next) => { setConfig(next); setToastText('设置已保存'); setTimeout(() => setToastText(''), 2200) },
          toast: (text) => { setToastText(text); setTimeout(() => setToastText(''), 2200) },
        }),
        toastText ? h('div', { className: 'hint' }, toastText) : null,
        h('div', { style: { display: 'flex', gap: 10, marginTop: 16 } },
          h('button', { className: 'mb-btn ghost', onClick: async () => {
            try {
              const result = await api('/export')
              const blob = new Blob([JSON.stringify(result.graph, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = `memory-bubble-${Date.now()}.json`
              link.click()
              setTimeout(() => URL.revokeObjectURL(url), 2000)
            } catch { /* ignore */ }
          } }, '导出记忆图'),
          h('label', { className: 'mb-btn ghost', style: { cursor: 'pointer' } }, '导入记忆图',
            h('input', {
              type: 'file', accept: 'application/json', style: { display: 'none' },
              onChange: async (event) => {
                const file = event.target.files && event.target.files[0]
                event.target.value = ''
                if (!file) return
                try {
                  const text = await file.text()
                  const result = await api('/import', { method: 'POST', body: JSON.stringify({ graph: JSON.parse(text) }) })
                  setToastText(`继承完成：${result.report.nodes} 条记忆、${result.report.edges} 条关系`)
                } catch (error) { setToastText(String(error.message || error)) }
                setTimeout(() => setToastText(''), 2600)
              },
            }))))
    }

    /* ------------------------------------------------------------ 输入框小药丸 */

    function TriggerPill({ ctx, ...props }) {
      const sessionId = props && props.sessionId
      useEffect(() => {
        if (sessionId && store.sessionId !== sessionId) store.sessionId = sessionId
      }, [sessionId])
      const [count, setCount] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const sid = sessionId || store.sessionId || ''
            const response = await api(`/graph?sessionId=${encodeURIComponent(sid)}&scope=all`)
            if (alive) setCount(response.stats ? response.stats.nodes : null)
          } catch { if (alive) setCount(null) }
        }
        void load()
        const timer = setInterval(load, 12000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      const open = () => {
        if (sessionId) store.sessionId = sessionId
        try { const layout = ctx.get('layout'); if (layout && layout.selectPanel) { layout.selectPanel(PANEL_ID); return } } catch { /* ignore */ }
        try { window.dispatchEvent(new CustomEvent('dsh:select-panel', { detail: PANEL_ID })) } catch { /* ignore */ }
      }
      return h('button', { className: 'mb-trigger', onClick: open, title: '打开忆泡图谱（记忆会随对话自动注入）' },
        h('i', { className: 'dot' }),
        '忆泡',
        h('b', null, count === null ? '·' : String(count)))
    }

    /* ------------------------------------------------------------ 注册 */

    function apply(ctx) {
      ensureStyle()
      if (typeof document !== 'undefined' && !document.documentElement.dataset.mbTheme) {
        document.documentElement.dataset.mbTheme = 'light'
      }
      try {
        const theme = ctx.get('theme')
        if (theme && theme.getTheme) {
          document.documentElement.dataset.mbTheme = normalizeScheme(theme.getTheme()) === 'dark' ? 'dark' : 'light'
        }
        ctx.on('theme/change', (snapshot) => {
          document.documentElement.dataset.mbTheme = normalizeScheme(snapshot) === 'dark' ? 'dark' : 'light'
        })
      } catch { /* ignore */ }

      const inject = (slot, options, component, label) => {
        try {
          const dispose = ctx.slots.inject(slot, () => ctx.slots.register(options, (props) => h(component, Object.assign({ ctx }, props))))
          if (typeof dispose === 'function') return dispose
        } catch (error) {
          console.warn('[memory-bubble] register slot failed:', slot, error && error.message ? error.message : error)
        }
        return undefined
      }

      // 入口只放侧栏（顺序靠后，不打乱已装插件入口）；主界面不再是“全屏面板”，而是侧栏图标唤起的可拖动浮窗
      inject('sidebar.panellist', { name: 'sidebar.panellist', id: PANEL_ID, order: 900, label: () => '忆泡' }, SideEntry, '忆泡')
      inject('shell.overlay', { name: 'shell.overlay', id: PANEL_ID, order: 60 }, BubbleWindow, '忆泡')
      inject('settings.section', { name: 'settings.section', id: PANEL_ID, order: 70, label: () => '忆泡' }, SettingsSection, '忆泡')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
