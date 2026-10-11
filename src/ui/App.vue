<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { Snapshot, Settings, LauncherBridge } from '../contracts';
declare global { interface Window { town?: LauncherBridge } }
const state = ref<Snapshot | null>(null);
const tab = ref('home');
const error = ref('');
const pending = ref(false);
const form = ref<Partial<Settings>>({});
let unsubscribe: (() => void) | undefined;
const busy = computed(() => pending.value || Boolean(state.value?.gamePid) ||
  ['importing','bootstrapping','launching','updating','preparing'].includes(state.value?.phase || ''));
const percent = computed(() => Math.min(100, Math.round((state.value?.progress?.bytes || 0) / (state.value?.progress?.total || 1) * 100)));
const phase = computed(() => ({idle:'就绪', error:'需要处理', playing:'游戏运行中', importing:'复制客户端', bootstrapping:'安装运行环境',
  launching:'启动中', updating:'安装更新', preparing:'准备更新'}[state.value?.phase || 'idle']));
const action = async (name: Parameters<LauncherBridge['action']>[0]) => {
  if (!window.town) return;
  pending.value = true; error.value = '';
  try { const result = await window.town.action(name); state.value = result.state;
    if (!result.ok) error.value = result.error || '操作失败';
    form.value = { ...result.state.settings };
  } catch(e) { error.value = String(e); } finally { pending.value = false; }
};
const save = async () => {
  if (!window.town) return;
  try {
    // IPC requires plain data rather than a Vue reactive proxy.
    const result = await window.town.configure({ ...form.value }); state.value = result.state;
    error.value = result.ok ? '' : result.error || '保存失败';
  } catch(e) { error.value = String(e); }
};
onMounted(async () => {
  if (!window.town) { error.value = '界面预览：未连接本机启动服务，操作已禁用。'; return; }
  state.value = await window.town.state(); form.value = { ...state.value.settings };
  unsubscribe = window.town.subscribe(value => { state.value = value; });
});
onUnmounted(() => unsubscribe?.());
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">T<span>·</span></span><div>TOWN<span>LAUNCHER</span></div></div>
      <div class="nav-label">你的世界</div>
      <button :class="{selected:tab==='home'}" @click="tab='home'"><span>◈</span>开始旅程</button>
      <button :class="{selected:tab==='updates'}" @click="tab='updates'"><span>↓</span>下载与更新</button>
      <button :class="{selected:tab==='settings'}" @click="tab='settings'"><span>⚙</span>运行设置</button>
      <button :class="{selected:tab==='logs'}" @click="tab='logs'"><span>≡</span>诊断日志</button>
      <div class="sidebar-bottom"><div class="dev-badge">DEV CHANNEL</div><p>属于你的城市，<br>从这里开始。</p><small>0.1.0 · P0 / P1 / P2</small></div>
    </aside>
    <main>
      <header><div class="breadcrumb">TOWNLIFE <span>/</span> {{ {home:'游戏',updates:'更新中心',settings:'设置',logs:'诊断'}[tab] }}</div><div class="user"><i></i>开发账号 · {{state?.settings.playerName || '未配置'}}<span class="avatar">T</span></div></header>
      <div class="page-heading"><div><p class="eyebrow">A PLACE TO CALL HOME</p><h1>{{{home:'欢迎回到方块世界',updates:'让世界保持新鲜',settings:'按照你的方式游玩',logs:'每一步，都有记录'}[tab]}}</h1></div><span class="status"><i :class="{warning:state?.phase==='error'}"></i>{{phase}}</span></div>
      <div v-if="error" class="error">{{error}}</div>

      <template v-if="tab==='home'">
        <section class="hero">
          <div class="map-grid"></div><div class="sun"></div>
          <svg class="city" viewBox="0 0 900 360" aria-hidden="true">
            <g fill="#182e28" stroke="#426453" stroke-width="1.2">
              <path d="M120 250 410 110 760 247 480 380Z" fill="#213c30"/>
              <path d="M220 230 250 215 560 333 530 349Z" fill="#527867"/>
              <path d="M490 143 522 156 259 285 229 271Z" fill="#527867"/>
              <path d="M354 149 395 132 395 235 354 251Z" fill="#63896e"/><path d="M395 132 446 151 446 252 395 235Z" fill="#365640"/><path d="M354 149 405 168 446 151 395 132Z" fill="#87a484"/>
              <path d="M475 203 516 184 516 271 475 291Z" fill="#738e76"/><path d="M516 184 562 202 562 289 516 271Z" fill="#44634b"/><path d="M475 203 521 220 562 202 516 184Z" fill="#a3b194"/>
              <path d="M281 254 323 233 323 288 281 309Z" fill="#819579"/><path d="M323 233 366 250 366 305 323 288Z" fill="#425f47"/><path d="M281 254 324 271 366 250 323 233Z" fill="#bcc3a5"/>
              <path d="M572 271 611 253 611 303 572 321Z" fill="#709071"/><path d="M611 253 659 271 659 321 611 303Z" fill="#3e6248"/><path d="M572 271 620 289 659 271 611 253Z" fill="#9bb98d"/>
            </g><g fill="#d5e8ab"><path d="M409 178 420 182 420 194 409 190Z"/><path d="M427 184 438 188 438 200 427 196Z"/><path d="M409 204 420 208 420 220 409 216Z"/><path d="M530 230 541 234 541 246 530 242Z"/></g>
            <g stroke="#7ca887" stroke-width="3" fill="#355c3d"><path d="M202 272v-28"/><path d="M453 302v-32"/><path d="M680 274v-30"/><circle cx="202" cy="236" r="14"/><circle cx="453" cy="265" r="16"/><circle cx="680" cy="236" r="18"/></g>
          </svg>
          <div class="hero-copy"><span class="pill">RCT · 开发测试</span><h2>下一站，<br>你的生活。</h2><p>道路通往远方，城市等待故事。<br>准备好，重新出发。</p></div>
          <span class="hero-coordinate">BUILD YOUR EVERYDAY / 01</span>
        </section>
        <div class="bottom-grid">
          <section class="card launch-card"><div class="card-heading"><span>客户端</span><span class="subtle">NEOFORGE</span></div><div class="version-row"><h3>RCT DEV</h3><span>1.21.1</span></div><p class="muted">{{state?.settings.versionId ? '实例已准备 · ' + (state?.releaseId || '运行环境') : '首次使用，请准备一个独立客户端'}}</p><button class="primary" :disabled="busy || !state?.settings.versionId" @click="action('launch')">{{state?.gamePid ? '游戏运行中' : '开始游戏'}}<span>↗</span></button></section>
          <section class="card"><div class="card-heading">首次使用<span class="subtle">01 → 02</span></div><h3>熟悉的世界，新的入口。</h3><p class="muted">复制现有客户端到独立工作区。<br>原有 HMCL、存档和账号不会被修改。</p><div class="button-row"><button class="secondary" :disabled="busy || !state" @click="action('import')">复制现有客户端</button><button class="text-button" :disabled="busy || !state" @click="action('bootstrap')">干净安装</button></div><small>干净安装仅安装 MC／NeoForge；Mod 由发布清单提供。</small></section>
        </div>
      </template>
      <template v-else-if="tab==='updates'">
        <section class="card wide"><div class="card-heading">发布与更新<span class="dev-badge">LOCAL TEST</span></div><h2>下载就绪后，再启用。</h2><p class="muted">验证签名与文件完整性。只更新受管理文件，不清理玩家设置和区块缓存。</p><div class="release-stats"><div><small>当前版本</small><strong>{{state?.releaseId || '尚未安装'}}</strong></div><div><small>可信公钥</small><strong>{{state?.trustedKeys || 0}} 个</strong></div><div><small>渠道</small><strong>DEV</strong></div></div>
        <div class="progress-track"><div :style="{width:percent+'%'}"></div></div><p class="muted">{{state?.message || '等待发布清单'}}<span class="float-right">{{percent}}%</span></p>
        <div class="button-row"><button class="secondary" :disabled="busy || !state" @click="action('key')">导入测试公钥</button><button class="secondary" :disabled="busy || !state" @click="action('prepare')">选择清单预下载</button><button class="primary compact" :disabled="busy || !state" @click="action('install')">验证并安装</button><button class="text-button" :disabled="!busy" @click="action('cancel')">取消</button></div></section>
        <div class="notice">当前阶段没有 COS 和正式渠道连接。清单与公钥需由你明确选择；预览版本不能安装为当前版本。</div>
      </template>
      <section v-else-if="tab==='settings'" class="card wide">
        <div class="card-heading">运行配置<span class="subtle">PRIVATE & LOCAL</span></div>
        <div class="form-grid"><label>开发账号名称<input v-model="form.playerName" :disabled="busy"></label><label>游戏内存（MiB）<input type="number" v-model.number="form.memoryMiB" :disabled="busy"></label>
        <label class="full">Java 21 可执行文件<div class="input-action"><input v-model="form.javaPath" :disabled="busy"><button :disabled="busy" @click="action('java')">选择</button><button :disabled="busy" @click="action('install-java')">安装</button></div></label>
        <label class="full">独立工作区<div class="path-value">{{state?.settings.workspace}}</div><button class="text-button" :disabled="busy" @click="action('workspace')">选择一个空文件夹 →</button></label>
        <label class="full">已安装版本 ID<input v-model="form.versionId" :disabled="busy"></label>
        <label>DEV 地址<input v-model="form.serverAddress" :disabled="busy"></label><label>端口<input type="number" v-model.number="form.serverPort" :disabled="busy"></label>
        <label class="checkbox"><input type="checkbox" v-model="form.autoConnect" :disabled="busy">启动后连接 DEV</label><label class="checkbox"><input type="checkbox" v-model="form.localFixtures" :disabled="busy">允许本机 HTTP 测试源</label></div>
        <div class="button-row"><button class="primary compact" :disabled="busy || !state" @click="save">保存设置</button><span class="muted">仅开发账号；未借用微软应用身份。</span></div>
      </section>
      <section v-else class="card wide"><div class="card-heading">最近输出<button class="text-button" @click="action('logs')">打开游戏日志 ↗</button></div><pre class="log-view">{{state?.logs.join('\n') || '尚无游戏输出。'}}</pre></section>
      <footer><span><i></i>独立客户端 · 现有服务器保持不变</span><span>MINECRAFT 1.21.1 / NEOFORGE 21.1.250</span></footer>
    </main>
  </div>
</template>
