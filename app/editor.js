"use strict";
/* 简历可视化编辑器：卡片编辑 / 岗位取舍 / 自动保存 / 实时预览 / AI 辅助面板 */
window.addEventListener("error", function (e) {
  document.title = "JSERR: " + (e.message || "?") + " @" + (e.lineno || "?") + ":" + (e.colno || "?");
});

/* ---------- 状态与基础 ---------- */
var state = { list: [], name: null, doc: null, appliedAI: {}, folded: {}, gauge: null, sortables: [] };
var $ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
var $$ = $; // 同 $：querySelectorAll 包装，返回数组
var saveTimer = null, pvTimer = null, iframeReady = false, pendingRender = false;
var undoStack = [], redoStack = [], baseline = null, lastPush = 0;

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function uid(p) { return (p || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function getJSON(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
function postJSON(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}
function toast(msg, ms, action) {
  var t = document.getElementById("toast");
  t.innerHTML = esc(msg).replace(/\n/g, "<br>") +
    (action ? " <button class='toast-act' id='toast-act'>" + esc(action.label) + "</button>" : "");
  t.style.display = "block";
  clearTimeout(t.__t); t.__t = setTimeout(function () { t.style.display = "none"; }, ms || 2600);
  if (action) document.getElementById("toast-act").onclick = function () { t.style.display = "none"; action.fn(); };
}
function copyText(txt) { // 复制到剪贴板：clipboard API 优先，execCommand 兜底；失败 reject 由调用方兜底
  return new Promise(function (resolve, reject) {
    function fallback() {
      var t = document.createElement("textarea");
      t.value = txt; t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) {}
      t.remove();
      ok ? resolve() : reject(new Error("复制失败"));
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(resolve, fallback);
    else fallback();
  });
}
function setSaveState(txt, cls) {
  var el = document.getElementById("save-state");
  el.textContent = txt;
  el.className = "save-state" + (cls ? " " + cls : "");
  var dot = document.getElementById("rail-dot");
  if (dot) dot.className = "rail-dot" + (cls && cls !== "ok" ? " " + cls : ""); // 成功即无痕：绿点永不常驻，只有忙/失败以图标徽标浮现
}
var okTimer = null;
function flashOk(txt) { // 成功类反馈就地化：状态行短暂表态后归于中性「就绪」，默认安静，不弹 toast
  setSaveState(txt, "ok");
  clearTimeout(okTimer);
  okTimer = setTimeout(function () {
    var el = document.getElementById("save-state");
    if (el.textContent === txt) setSaveState("就绪", ""); // 期间有新状态则不覆盖
  }, 2000);
}

/* ---------- 撤销 / 重做（Memento 全量快照，600ms 合帧）---------- */
function snap() { return JSON.stringify(state.doc); }
function beforeChange(force) { // afterChange 开头调用：把"上一稳定态"压入撤销栈
  if (baseline === null) { baseline = snap(); return; }
  var top = undoStack.length ? undoStack[undoStack.length - 1] : null;
  if (baseline !== top) {
    var now = Date.now();
    if (force || now - lastPush > 600) { // 打字按 600ms 合帧；切换类操作传 force 独立成步
      undoStack.push(baseline);
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
      lastPush = now;
      updateUndoBtns();
    }
  }
}
function applySnap(s) {
  state.doc = JSON.parse(s);
  baseline = s;
  renderCards();
  scheduleSave();
  schedulePreview();
  updateChars();
}
function syncAppliedAI() { // 撤销/重做后按内容事实重算「已应用」标记（R42）：标记=当前内容与建议一致，不靠应用时的记忆
  var box = document.getElementById("ai-cards");
  var arr = (box && box.__items) || [];
  var marks = {};
  arr.forEach(function (it, i) {
    if (!it || it.type === "note") return;
    var f = findAny(it.target || "");
    if (!f) return;
    if (it.type === "rewrite" && f.obj.text === it.text) marks[i] = true;
    else if (it.type === "hide" && f.obj.hidden === true) marks[i] = true;
    else if (it.type === "show" && f.obj.hidden === false) marks[i] = true;
  });
  state.appliedAI = marks;
}
function aiApplicable(arr) { // 「全部应用」工具条口径（R44 定，R56 抽出共用）：存在真实可应用且尚未应用的建议
  return arr.some(function (it, i) {
    if (!it || it.type === "note" || state.appliedAI[i]) return false;
    var f = findAny(it.target || "");
    return !!f && (it.type !== "rewrite" || f.kind === "bullet");
  });
}
function repaintAppliedAI() { // 手动编辑后就地刷新「已应用」徽标（R56）：不重建卡片，滚动位置与差异视图不被打断
  var box = document.getElementById("ai-cards");
  var arr = (box && box.__items) || [];
  if (!box || !arr.length) return;
  var cards = box.querySelectorAll(".ai-card");
  arr.forEach(function (it, i) {
    var c = cards[i];
    if (!c || !it || it.type === "note") return;
    var applied = !!state.appliedAI[i];
    c.classList.toggle("applied", applied);
    var btn = c.querySelector(".apply-btn"), note = c.querySelector(".applied-note");
    if (applied && btn) {
      btn.remove();
      c.insertAdjacentHTML("beforeend", "<span class='applied-note'>（已应用）</span>");
    } else if (!applied && !btn && note) {
      note.remove();
      c.insertAdjacentHTML("beforeend", "<button class='btn small apply-btn' data-ai='" + i + "'>✓ 应用</button>");
      var nb = c.querySelector(".apply-btn");
      if (nb) nb.addEventListener("click", function () { aiApply(i); });
    }
  });
  var toolbar = document.getElementById("ai-toolbar");
  if (toolbar) toolbar.classList.toggle("hidden", !aiApplicable(arr));
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap());
  applySnap(undoStack.pop());
  updateUndoBtns();
  syncAppliedAI();
  if (!document.getElementById("ai-panel").classList.contains("ai-closed")) loadSuggestions(); // 面板开着：卡片「已应用」态即时回退
  flashOk("已撤销 ✓");
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  applySnap(redoStack.pop());
  updateUndoBtns();
  syncAppliedAI();
  if (!document.getElementById("ai-panel").classList.contains("ai-closed")) loadSuggestions();
  flashOk("已重做 ✓");
}
function updateUndoBtns() { // ↶↷ 可发现性：按钮态跟随撤销栈，不用记快捷键
  var u = document.getElementById("rail-undo"), r = document.getElementById("rail-redo");
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/* ---------- 轻量弹窗 ---------- */
function closeModal() {
  var m = document.getElementById("modal");
  if (m && m.querySelector(".onboard")) { // 引导无论怎么关都记为已读（Esc 与点背景行为一致）
    try { localStorage.setItem("vui-onboarded", "1"); } catch (e) {}
  }
  if (m) m.remove();
}
function askConfirm(title, body, onOk) {
  modalCaptureFocus();
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal'><div class='m-title'>" + esc(title) + "</div>" +
    "<div class='m-body'>" + esc(body) + "</div>" +
    "<div class='m-row'><button class='btn' data-m='no'>取消</button>" +
    "<button class='btn primary' data-m='ok'>确定</button></div></div>";
  document.body.appendChild(ov);
  ov.addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-m");
    if (e.target === ov || a === "no") ov.remove();
    else if (a === "ok") { ov.remove(); onOk(); }
  });
  var ok = ov.querySelector("[data-m='ok']"); if (ok) ok.focus();
}
function askText(title, label, value, placeholder, onOk) { // 带输入框的弹层（替代原生 prompt，交互语言与 askConfirm 一致）
  modalCaptureFocus();
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal'><div class='m-title'>" + esc(title) + "</div>" +
    "<div class='m-body'><label for='m-input' style='display:block;margin-bottom:6px'>" + esc(label) + "</label>" +
    "<input id='m-input' style='width:100%' value=\"" + esc(value || "") + "\" placeholder=\"" + esc(placeholder || "") + "\"></div>" +
    "<div class='m-row'><button class='btn' data-m='no'>取消</button>" +
    "<button class='btn primary' data-m='ok'>确定</button></div></div>";
  document.body.appendChild(ov);
  var inp = ov.querySelector("#m-input");
  inp.focus(); inp.select();
  inp.addEventListener("keydown", function (e) {
    if (e.isComposing || e.keyCode === 229) return; // IME 组合中：回车是选字确认，不是提交弹窗（R69）
    if (e.key === "Enter") { var v1 = inp.value.trim(); ov.remove(); onOk(v1); }
  });
  ov.addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-m");
    if (e.target === ov || a === "no") ov.remove();
    else if (a === "ok") { var v = inp.value.trim(); ov.remove(); onOk(v); }
  });
}
function showOnboard(force) {
  if (!force && (localStorage.getItem("vui-onboarded") === "1" || /[?&]nointro=1/.test(location.search))) return;
  modalCaptureFocus();
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal onboard'><div class='m-title'>👋 三步上手简历工作台</div>" +
    "<ol class='ob-steps'>" +
    "<li><b>维护主简历</b>：左侧卡片增删改、拖拽排序，右侧 A4 实时预览，完整版可以是 2 页</li>" +
    "<li><b>投递取舍</b>：AI 助手里贴 JD、点「发起 AI 优化」（提示词自动复制）→ 到你的 AI agent 粘贴运行 → 回来建议自动出现，一键或逐条采纳</li>" +
    "<li><b>一键导出</b>：左侧导航「导出 PDF」得到与预览 1:1 的 A4 打印版</li>" +
    "</ol><p class='ob-tip'>提示：Ctrl+S 保存 · Ctrl+E / Ctrl+P 导出 · Ctrl+J AI 助手 · Ctrl+Z / Ctrl+Shift+Z 撤销重做 · Ctrl+B 加粗（再按取消）· Ctrl+F 文档内查找（Enter 下一处）· T 取舍模式（j/k 移动 · h 隐藏/恢复 · Esc 退出）· Alt+↑/↓ 切换文档 · 点右侧预览可定位左侧卡片 · AI 建议就绪时左侧 🤖 亮圆点，面板关着也不会错过 · ? 重看本引导</p>" +
    "<div class='m-row'><button class='btn primary' data-m='ok'>开始使用</button></div></div>";
  document.body.appendChild(ov);
  var okb = ov.querySelector("[data-m='ok']"); if (okb) okb.focus(); // 键盘用户 Enter 直接开始（R47 统一）
  ov.addEventListener("click", function (e) {
    if (e.target === ov || (e.target.getAttribute && e.target.getAttribute("data-m") === "ok")) {
      ov.remove(); localStorage.setItem("vui-onboarded", "1");
    }
  });
}

/* ---------- 折叠状态（按文档记忆，localStorage 持久化） ---------- */
var FOLD_KEY = "vui-folded";
function loadFoldStore() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || "{}"); } catch (e) { return {}; }
}
function saveFoldStore() {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(state.folded)); } catch (e) {}
}

/* ---------- 模型查找 ---------- */
function secById(id) { return (state.doc.sections || []).find(function (s) { return s.id === id; }); }
function findEntry(id) {
  var r = null;
  (state.doc.sections || []).forEach(function (s) {
    (s.entries || []).forEach(function (e) { if (e.id === id) r = { entry: e, section: s }; });
  });
  return r;
}
function findBullet(id) {
  var r = null;
  (state.doc.sections || []).forEach(function (s) {
    (s.entries || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) { if (b.id === id) r = { bullet: b, entry: e, section: s }; });
    });
  });
  return r;
}
function findAny(id) {
  return secById(id) ? { obj: secById(id), kind: "section" }
    : findEntry(id) ? { obj: findEntry(id).entry, kind: "entry" }
    : findBullet(id) ? { obj: findBullet(id).bullet, kind: "bullet" } : null;
}

/* ---------- 加载 / 切换 ---------- */
function loadList() {
  return getJSON("/api/list").then(function (r) {
    state.list = r.docs || [];
    state.meta = r.meta || {}; // 各文档 savedAt/exportedAt（服务端时钟），驱动侧栏导出状态点
    renderRail();
    updateStatsBadge(state.meta);
    if (!state.name && state.list.length) { // 恢复上次编辑的文档（localStorage 记忆）
      var last = null;
      try { last = localStorage.getItem("vui-last"); } catch (e) {}
      switchDoc(state.list.indexOf(last) !== -1 ? last : state.list[0]);
    }
  }).catch(function (e) { // 启动时服务不可达：给明确指引（后续操作的失败由各自 catch 提示）
    if (!state.list.length) toast("无法连接本地服务：请双击「启动简历工作台.bat」启动后再刷新页面", 8000);
  });
}
function refreshRailMeta() { // 保存/导出后轻刷新侧栏状态点（只取 meta，不动文档）
  getJSON("/api/list").then(function (r) {
    state.meta = r.meta || {};
    renderRail();
    updateStatsBadge(state.meta);
  }).catch(function () {});
}
function updateStatsBadge(meta) { // 📊 琥珀数字徽标（R36）：导出后又改过（PDF 非最新）的副本数，零点击可见
  var b = document.querySelector("[data-nav='stats']");
  if (!b) return;
  var n = 0, m = meta || {};
  Object.keys(m).forEach(function (k) {
    var d = m[k];
    if (d.savedAt && d.exportedAt && d.savedAt > d.exportedAt) n++;
  });
  var el = b.querySelector(".stale-badge");
  if (n && !el) { el = document.createElement("span"); el.className = "stale-badge"; b.appendChild(el); }
  if (n) {
    el.textContent = n;
    el.title = n + " 份副本导出后又改过，PDF 非最新（点开投递一览查看）";
  } else if (el) el.remove();
}
/* ---------- 交付体检（R26）：导出前的高置信问题清单，宁缺勿滥 ---------- */
function lintDoc(doc) {
  var pats = [/待补充/, /待完善/, /TODO/i, /某公司/, /某某/, /XX公司/, /XX项目/, /XX科技/, /2026-?XX/, /占位/];
  var issues = [];
  function hit(text, where, id) {
    if (!text) return;
    var s = String(text);
    for (var i = 0; i < pats.length; i++) {
      if (pats[i].test(s)) { issues.push({ msg: where + "疑似占位内容「" + s.slice(0, 24) + "」", id: id || "" }); return; }
    }
  }
  var m = doc.meta || {};
  ["姓名", "电话", "邮箱", "城市", "求职意向"].forEach(function (k) { hit(m[k], "基本信息·" + k + "："); });
  var phone = String(m.电话 || "").trim(), mail = String(m.邮箱 || "").trim();
  if (!phone && !mail) issues.push({ msg: "基本信息缺联系方式（电话/邮箱都为空）", id: "" });
  else { // 格式粗查（R48）：只拦明显破损（位数离谱/缺 @），不做正则审判，宁缺勿滥
    var digits = phone.replace(/\D/g, "");
    if (phone && (digits.length < 6 || digits.length > 15)) issues.push({ msg: "基本信息·电话：数字位数 " + digits.length + " 可疑（常见 6~15 位）", id: "" });
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) issues.push({ msg: "基本信息·邮箱：格式不像有效邮箱（缺 @ 或域名）", id: "" });
  }
  (doc.sections || []).forEach(function (s) {
    if (s.hidden) return;
    hit(s.标题, "章节标题：", s.id);
    (s.entries || []).forEach(function (en) {
      if (en.hidden) return;
      ["left", "right", "meta", "tags"].forEach(function (k) { hit(en[k], "「" + (s.标题 || "") + "」条目：", en.id); });
      (en.bullets || []).forEach(function (b) {
        if (b.hidden) return;
        hit(b.text, "「" + (s.标题 || "") + "」正文：", b.id);
        if (!String(b.text || "").trim()) issues.push({ msg: "「" + (s.标题 || "") + "」有空内容行（可填写或隐藏）", id: b.id });
      });
    });
  });
  return issues;
}
/* ---------- 文档内查找（Ctrl+F，R35）：焦点常驻查找条，命中行高亮 + 滚动居中，折叠章节自动展开 ---------- */
var findState = { q: "", hits: [], idx: -1 };
function findOpen() { var b = document.getElementById("find-bar"); return !!(b && b.classList.contains("on")); }
function findBar() { // 惰性创建：结构只建一次
  var b = document.getElementById("find-bar");
  if (b) return b;
  b = document.createElement("div");
  b.id = "find-bar";
  b.innerHTML = "<input id='find-in' placeholder='在本文档内查找（章节 / 条目 / 成果）'>" +
    "<span id='find-count'></span>" +
    "<button id='find-prev' title='上一处（Shift+Enter）' aria-label='上一处'>↑</button>" +
    "<button id='find-next' title='下一处（Enter）' aria-label='下一处'>↓</button>" +
    "<button id='find-x' title='关闭（Esc）' aria-label='关闭查找'>✕</button>";
  document.body.appendChild(b);
  document.getElementById("find-in").addEventListener("input", function () { findScan(this.value); });
  document.getElementById("find-in").addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); return; } // stopPropagation：Esc 只关最顶层（查找条），不连带关 AI 抽屉（与 rail-search 同法）
    if (e.isComposing || e.keyCode === 229) return; // IME 组合中：回车是选字确认，不跳命中（R69）
    if (e.key === "Enter") { e.preventDefault(); findGoto(e.shiftKey ? -1 : 1); return; }
    e.stopPropagation(); // 查找条内按键不进全局分发
  });
  b.addEventListener("click", function (e) {
    if (e.target.id === "find-next") findGoto(1);
    else if (e.target.id === "find-prev") findGoto(-1);
    else if (e.target.id === "find-x") closeFind();
  });
  return b;
}
function pushHits(k, id, secId, f, text, low) {
  if (!text) return;
  var t = String(text).toLowerCase(), i = 0;
  while ((i = t.indexOf(low, i)) !== -1) { findState.hits.push({ k: k, id: id, secId: secId, f: f, at: i }); i += 1; }
}
function findScan(q) {
  findState.q = q; findState.hits = []; findState.idx = -1;
  var doc = state.doc;
  if (q && doc) {
    var low = q.toLowerCase();
    (doc.sections || []).forEach(function (s) {
      pushHits("section", s.id, s.id, "标题", s["标题"], low);
      (s.entries || []).forEach(function (en) {
        ["left", "right", "meta", "tags"].forEach(function (f) { pushHits("entry", en.id, s.id, f, en[f], low); });
        (en.bullets || []).forEach(function (b) { pushHits("bullet", b.id, s.id, "text", b.text, low); });
      });
    });
  }
  updateFindCount();
}
function findGoto(dir) {
  var hits = findState.hits;
  if (!hits.length) { updateFindCount(); return; }
  findState.idx = (findState.idx + (dir || 1) + hits.length) % hits.length;
  var h = hits[findState.idx];
  var row = document.querySelector('#cards [data-id="' + h.id + '"]');
  if (!row || row.offsetParent === null) { // 命中在折叠章节内：先展开再定位
    var fdoc = state.folded[state.name] || (state.folded[state.name] = {});
    if (fdoc[h.secId]) { fdoc[h.secId] = false; saveFoldStore(); renderCards(); row = document.querySelector('#cards [data-id="' + h.id + '"]'); }
  }
  if (!row) return;
  $$("#cards .find-cur").forEach(function (x) { x.classList.remove("find-cur"); });
  row.classList.add("find-cur");
  row.scrollIntoView({ block: "center" });
  updateFindCount();
}
function updateFindCount() {
  var el = document.getElementById("find-count");
  if (!el) return;
  var n = findState.hits.length;
  el.textContent = !findState.q ? "" : !n ? "无" : findState.idx < 0 ? n + " 处" : (findState.idx + 1) + "/" + n;
}
function openFind() {
  var b = findBar();
  b.classList.add("on");
  var inp = document.getElementById("find-in");
  inp.focus(); inp.select();
  findScan(inp.value); // 重开保留上次关键词并重新扫描（模型可能已变）
}
function closeFind() {
  var b = document.getElementById("find-bar");
  if (b) b.classList.remove("on");
  $$("#cards .find-cur").forEach(function (x) { x.classList.remove("find-cur"); });
  findState.idx = -1;
}

var DELIV_ST = ["未投", "已投", "面试", "通过", "挂"]; // 投递状态循环顺序（与 serve.py DELIV_ST 白名单一致）
function cycleDeliv(name, cur, back) { // 投递状态跟踪（R33）：点胶囊循环推进、Shift+点反向退回（R58），服务端 sidecar 记录，刷新后重建一览
  var i = DELIV_ST.indexOf(cur), n = DELIV_ST.length;
  if (i < 0) i = 0;
  var nxt = DELIV_ST[((back ? i - 1 : i + 1) % n + n) % n];
  postJSON("/api/delivery", { name: name, st: nxt }).then(function () { showStats(); })
    .catch(function () { toast("状态保存失败：本地服务可能没在运行"); });
}
function exportByName(name) { // 一览行内一键导出（R34）：跳到该副本再程序化点侧栏导出按钮——体检/超页兜底/反馈整条链路复用，不另造一份导出逻辑
  closeModal();
  switchDoc(name).then(function () {
    var b = document.querySelector('[data-nav="export"]');
    if (b) b.click(); else toast("找不到导出入口");
  }).catch(function () { toast("打开副本失败：" + name.replace(/^jobs\//, "")); });
}
var statsData = null, statsFilter = ""; // 一览数据快照与当前投递状态筛选（R36：筛选切换就地重建，不重新请求）
var statsSort = { key: "date", dir: "desc" }; // 表头排序（R46）：默认日期倒序=最新投递在前，与 R34 行为一致
function statSortVal(it) {
  switch (statsSort.key) {
    case "company": return it.company;
    case "role": return it.role;
    case "st": return { "已导出": 0, "改过未重导": 1, "未导出": 2 }[it.st];
    case "exp": return it.exp;
    case "dv": return DELIV_ST.indexOf(it.dv.st || "未投");
    default: return it.date === "—" ? "" : it.date; // date：无日期副本沉底
  }
}
function showStats() {
  modalCaptureFocus();
  closeModal();
  getJSON("/api/list").then(function (r) { statsData = r; renderStats(); })
    .catch(function () { toast("读取投递状态失败：本地服务可能没在运行"); });
}
function buildStatsItems(r) { // 一览行数据（R37 从 renderStats 抽出）：文档列表 → 日期/公司/岗位/导出状态/投递状态；弹窗与 CSV 导出共用同一口径
  var meta = r.meta || {};
  var dlv = r.delivery || {};
  var items = (r.docs || []).filter(function (n) { return n !== "主简历"; }).map(function (n) {
    var short = n.replace(/^jobs\//, "");
    var parts = short.split("_");
    var date = /^\d{4}-\d{2}-\d{2}$/.test(parts[0] || "") ? parts[0] : "—";
    var company = parts[1] || "—";
    var role = parts.slice(2).join("_") || "—";
    var m = meta[n] || {};
    var st, cls;
    if (m.exportedAt && m.savedAt && m.savedAt > m.exportedAt) { st = "改过未重导"; cls = "warn"; }
    else if (m.exportedAt) { st = "已导出"; cls = "ok"; }
    else { st = "未导出"; cls = "none"; }
    return { n: n, date: date, company: company, role: role, st: st, cls: cls,
             exp: (m.exportedAt || "").replace("T", " ").slice(0, 16) || "—", dv: dlv[n] || {} };
  });
  var d = statsSort.dir === "asc" ? 1 : -1;
  items.sort(function (a, b) { // 表头排序（R46）：中文走 localeCompare；无值（无日期/占位—）升降序都沉底
    var va = statSortVal(a), vb = statSortVal(b);
    var ea = va === "" || va == null, eb = vb === "" || vb == null;
    if (ea !== eb) return ea ? 1 : -1;
    if (va === vb) return 0;
    if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb), "zh") * d;
    return va < vb ? -d : d;
  });
  return items;
}
function csvCell(v) { // CSV 单元格转义：含逗号/引号/换行时整体加引号，内部引号翻倍；以 =+-@\t 开头时加 ' 前缀防 Excel 公式注入（R38 终审加固）
  v = String(v == null ? "" : v);
  if (/^[=+\-@\t]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function buildDeliveryCsv(items) { // 台账导出（R37）：一览行 → CSV 文本；开头的 UTF-8 BOM 让 Excel 正确识别中文
  var lines = [["文件名", "日期", "公司", "岗位", "导出状态", "导出时间", "投递状态"].join(",")].concat(items.map(function (it) {
    return [csvCell(it.n), csvCell(it.date), csvCell(it.company), csvCell(it.role),
            csvCell(it.st), csvCell(it.exp), csvCell(it.dv.st || "未投")].join(",");
  }));
  return "\uFEFF" + lines.join("\r\n");
}
function downloadDeliveryCsv() { // 所见即所得：按当前筛选导出台账（全部 / 某个投递状态）
  if (!statsData) return;
  var shown = buildStatsItems(statsData).filter(function (it) {
    return statsFilter === "" || (it.dv.st || "未投") === statsFilter;
  });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buildDeliveryCsv(shown)], { type: "text/csv;charset=utf-8" }));
  a.download = "投递台账-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000); // 下载启动后回收 objectURL
}
function renderStats() { // 用 statsData + statsFilter 构建投递一览弹窗
  closeModal();
  var items = buildStatsItems(statsData || {});
  var chips = "<button class='stats-tab" + (statsFilter === "" ? " on" : "") + "' data-sf=''>全部 " + items.length + "</button>" +
    DELIV_ST.map(function (s) {
      var c = 0;
      items.forEach(function (it) { if ((it.dv.st || "未投") === s) c++; });
      return "<button class='stats-tab" + (statsFilter === s ? " on" : "") + "' data-sf='" + s + "'>" + s + " " + c + "</button>";
    }).join("");
  var shown = statsFilter === "" ? items : items.filter(function (it) { return (it.dv.st || "未投") === statsFilter; });
  var rows = shown.map(function (it) {
    var di = Math.max(0, DELIV_ST.indexOf(it.dv.st || "未投"));
    return "<tr class='stats-row' tabindex='0' data-doc=\"" + esc(it.n) + "\"><td>" + esc(it.date) + "</td><td>" + esc(it.company) +
      "</td><td>" + esc(it.role) + "</td><td><span class='stats-dot " + it.cls + "'></span>" + it.st +
      "</td><td class='stats-time'>" + esc(it.exp) +
      "</td><td><button class='deliv-pill d" + di + "' data-dv=\"" + esc(it.n) +
      "\" title=\"点击推进到「" + DELIV_ST[(di + 1) % DELIV_ST.length] + "」，Shift+点击退回「" + DELIV_ST[((di - 1) % DELIV_ST.length + DELIV_ST.length) % DELIV_ST.length] + "」\">" + esc(it.dv.st || "未投") + "</button></td>" +
      "<td>" + (it.st !== "已导出" ? "<button class='stats-export' data-ex=\"" + esc(it.n) +
      "\" title=\"跳到该副本并走标准导出（含交付体检）\">" + (it.st === "改过未重导" ? "⬇ 重导" : "⬇ 导出") + "</button>" : "") + "</td></tr>";
  }).join("");
  var body;
  var ths = [["date", "日期"], ["company", "公司"], ["role", "岗位"], ["st", "导出状态"], ["exp", "导出时间"], ["dv", "投递状态"]].map(function (t) {
    var on = statsSort.key === t[0];
    return "<th class='sort-th" + (on ? " on" : "") + "' data-sk='" + t[0] + "' tabindex='0'" +
      " title=\"点击或回车按此列排序（再点切换升/降序）\" aria-sort='" + (on ? (statsSort.dir === "asc" ? "ascending" : "descending") : "none") + "'>" +
      t[1] + (on ? (statsSort.dir === "asc" ? " ▲" : " ▼") : "") + "</th>";
  }).join("");
  if (rows) body = "<table class='stats-table'><thead><tr>" + ths + "<th></th></tr></thead><tbody>" +
      rows + "</tbody></table><p class='ob-tip'>点行跳到对应副本，点状态胶囊推进投递进度（未投→已投→面试→通过→挂，Shift+点击反向退回）；点表头按列排序，再点切换升/降序；「改过未重导」= 导出后又编辑过，点 ⬇ 重导即补最新版（主简历不计入投递）</p>";
  else body = "<div class='ai-empty'>" + (items.length ? "没有「" + esc(statsFilter) + "」状态的副本" :
      "还没有岗位副本。左侧「＋新建岗位副本」创建后，这里会汇总各份的导出状态") + "</div>";
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal modal-wide'><div class='m-title'>📊 投递一览</div>" +
    "<div class='stats-tabs'>" + chips + "</div>" + body +
    "<div class='m-row'><button class='btn' data-m='new'>＋ 新建岗位副本</button><button class='btn' data-m='csv' title=\"把当前台账（含筛选结果）存为 CSV，可直接用 Excel 打开\">⬇ 导出 CSV</button><button class='btn' data-m='no'>关闭</button></div></div>";
  document.body.appendChild(ov);
  ov.addEventListener("keydown", function (e) { // 表头键盘可达（R54）：Tab 聚焦后 Enter/空格触发排序
    var th = e.target.closest && e.target.closest(".sort-th");
    if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); th.click(); return; }
    var pill = e.target.closest && e.target.closest(".deliv-pill"); // 行内按钮键盘可达（R73）：必须在行跳转之前分流，否则回车被 closest('.stats-row') 劫持成跳副本
    if (pill && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pill.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: e.shiftKey })); return; } // click 带 shiftKey：Shift+回车与 Shift+点击同语义（反向退回）
    var ex = e.target.closest && e.target.closest(".stats-export");
    if (ex && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ex.click(); return; }
    var tr = e.target.closest && e.target.closest(".stats-row");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); ov.remove(); switchDoc(tr.getAttribute("data-doc")); } // 行跳转键盘可达（R65）
  });
  ov.addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-m");
    if (e.target === ov || a === "no") { ov.remove(); return; }
    if (a === "new") { ov.remove(); var nb = document.querySelector('[data-nav="newjob"]'); if (nb) nb.click(); return; }
    if (a === "csv") { downloadDeliveryCsv(); return; }
    var th = e.target.closest && e.target.closest(".sort-th");
    if (th) { // 表头排序（R46）：同列再点切换升/降序，换列默认降序；就地重建不重新请求
      var sk = th.getAttribute("data-sk");
      if (statsSort.key === sk) statsSort.dir = statsSort.dir === "asc" ? "desc" : "asc";
      else { statsSort.key = sk; statsSort.dir = "desc"; }
      renderStats();
      return;
    }
    var tab = e.target.closest && e.target.closest(".stats-tab");
    if (tab) { statsFilter = tab.getAttribute("data-sf") || ""; renderStats(); return; } // 筛选切换就地重建
    var ex = e.target.closest && e.target.closest(".stats-export");
    if (ex) { exportByName(ex.getAttribute("data-ex")); return; } // 一键导出优先于行跳转
    var pill = e.target.closest && e.target.closest(".deliv-pill");
    if (pill) { cycleDeliv(pill.getAttribute("data-dv"), pill.textContent, e.shiftKey); return; } // 胶囊优先于行跳转；Shift+点击反向（R58）
    var tr = e.target.closest && e.target.closest(".stats-row");
    if (tr) { ov.remove(); switchDoc(tr.getAttribute("data-doc")); }
  });
}

/* ---------- 弹窗焦点归还（R47）：打开时记触发点，任一关闭路径（Esc/点背景/动作/替换）后焦点归位 ---------- */
var modalReturnFocus = null;
function modalCaptureFocus() { // 各弹窗入口在抢焦点之前同步调用；弹窗接力（体检→确认）时保留最初的触发点
  if (document.getElementById("modal")) return;
  var ae = document.activeElement;
  modalReturnFocus = (ae && ae !== document.body) ? ae : null;
}
var modalWatch = new MutationObserver(function () {
  if (!document.getElementById("modal") && modalReturnFocus) {
    try { modalReturnFocus.focus(); } catch (e) {}
    modalReturnFocus = null;
  }
});

function showLintModal(issues, onExport) { // 体检清单 → 用户拍板：取消导出 / 仍要导出（不阻断，只提示）
  modalCaptureFocus();
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal'><div class='m-title'>🩺 交付体检：发现 " + issues.length + " 项问题</div>" +
    "<div class='lint-list'>" + issues.slice(0, 8).map(function (it) {
      var loc = it && it.id ? " data-loc='" + esc(it.id) + "' title='点击定位到这张卡片（去修好再导出）'" : "";
      return "<div class='lint-item'" + loc + ">" + esc(it.msg) + "</div>";
    }).join("") +
    (issues.length > 8 ? "<div class='lint-item'>… 共 " + issues.length + " 项</div>" : "") + "</div>" +
    "<div class='bk-tip'>带下划线的条目可点击，直接定位到问题卡片；修好再导出</div>" +
    "<div class='m-row'><button class='btn' data-m='no'>取消导出</button>" +
    "<button class='btn primary' data-m='ok'>仍要导出</button></div></div>";
  document.body.appendChild(ov);
  var ok = ov.querySelector("[data-m='ok']"); if (ok) ok.focus(); // 键盘用户直接 Enter=仍要导出（与 askConfirm 同法）
  ov.addEventListener("click", function (e) {
    var li = e.target.closest && e.target.closest("[data-loc]");
    if (li) { var loc = li.getAttribute("data-loc"); ov.remove(); locateCard(loc); return; } // 点条目定位卡片（R68）：用户去修，导出流程中止
    var a = e.target.getAttribute && e.target.getAttribute("data-m");
    if (e.target === ov || a === "no") ov.remove();
    else if (a === "ok") { ov.remove(); onExport(); }
  });
}
function showPhotoZoom(src) { // 预览照片放大：点任意处或 Esc 关闭（查看类弹层，无按钮）
  modalCaptureFocus();
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov photo-zoom"; ov.id = "modal";
  ov.innerHTML = "<img class='photo-zoom-img' src=\"" + esc(src) + "\" alt='照片放大查看'>";
  document.body.appendChild(ov);
  ov.addEventListener("click", function () { ov.remove(); });
}
/* ---------- 取舍模式（键盘流 triage：t 进入 · j/k 移动 · h 隐藏/恢复 · Esc/t 退出） ---------- */
var triageIds = [];    // 可导航行 id（DOM 序，含已隐藏压缩行，h 可恢复）
var triageIdx = -1;    // -1 = 未进入

function triageCollect() { // 折叠章节里的行不可见（offsetParent=null）不进导航
  triageIds = $$("#cards [data-id]").filter(function (el) {
    return el.matches(".card.section, .card.entry, .bullet-row") && el.offsetParent !== null;
  }).map(function (el) { return el.getAttribute("data-id"); });
}
function triageHud(el) { // el=当前高亮行（由 triagePaint 传入）：HUD 顺带展示该行的 JD 命中徽标
  var hud = document.getElementById("triage-hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "triage-hud";
    hud.setAttribute("role", "status");
    hud.setAttribute("aria-live", "polite");
    document.body.appendChild(hud);
  }
  var hitEl = el && el.querySelector(".jd-hit");
  hud.textContent = "取舍模式 " + (triageIdx + 1) + "/" + triageIds.length +
    (hitEl ? " · " + hitEl.textContent : "") + " · j/k 移动 · h 隐藏/恢复 · Esc 退出";
}
function triagePaint() {
  $$("#cards .triage-cur").forEach(function (el) { el.classList.remove("triage-cur"); });
  var id = triageIds[triageIdx];
  var el = id && document.querySelector('#cards [data-id="' + id + '"]');
  if (el) { el.classList.add("triage-cur"); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  triageHud(el);
}
function triageStart() { // 从视口内最近的一行开始，不在视口就从头
  triageCollect();
  if (!triageIds.length) { toast("当前文档没有可取舍的条目"); return; }
  var best = Infinity, mid = 0, vh = window.innerHeight;
  triageIds.forEach(function (id, i) {
    var el = document.querySelector('#cards [data-id="' + id + '"]');
    if (!el) return;
    var r = el.getBoundingClientRect();
    var d = r.top < 0 ? -r.top : r.top > vh ? r.top - vh : 0;
    if (d < best) { best = d; mid = i; }
  });
  triageIdx = mid;
  triagePaint();
}
function triageExit() {
  if (triageIdx < 0) return;
  triageIdx = -1; triageIds = [];
  var hud = document.getElementById("triage-hud");
  if (hud) hud.remove();
  $$("#cards .triage-cur").forEach(function (el) { el.classList.remove("triage-cur"); });
}
function countHiddenRows(doc) { // 与 updateChars 的 hid 同口径：隐藏章节/条目/成果行各计 1，章节整体隐藏不重复计内部（R72）
  var n = 0;
  (doc.sections || []).forEach(function (s) {
    if (s.hidden) { n++; return; }
    (s.entries || []).forEach(function (e) {
      if (e.hidden) { n++; return; }
      (e.bullets || []).forEach(function (b) { if (b.hidden) n++; });
    });
  });
  return n;
}
function triageExitGuide() { // 用户主动退出（Esc/T）的下一步引导（R72）：取舍→导出 闭环；切文档触发的退出（switchDoc）不打扰
  var n = countHiddenRows(state.doc);
  toast(n ? "取舍结束 · 本文档已隐藏 " + n + " 行，Ctrl+E 随时可导出" : "取舍结束 · Ctrl+E 随时可导出", 8000,
    { label: "导出 PDF", fn: function () { exportByName(state.name); } });
}
function triageMove(step) {
  triageIdx = Math.min(triageIds.length - 1, Math.max(0, triageIdx + step));
  triagePaint();
}
function triageToggle() { // 与行内眼睛同一语义：主简历可见行没有眼睛（低频走 ⋯ 菜单），这里同样拦截
  var id = triageIds[triageIdx];
  var f0 = id && findAny(id);
  if (!f0) return;
  if (state.name === "主简历" && !f0.obj.hidden) { toast("主简历里隐藏是低频操作，请用行尾 ⋯ 菜单"); return; }
  f0.obj.hidden = !f0.obj.hidden;
  afterChange(true, true); // 全量重渲染：压缩、琥珀眼睛、「已隐藏 N」chip 全部同步（切换类：不弹 toast）
  triageCollect();         // 重渲染后行数可能变化（压缩不改行数，防御性重收集）
  if (triageIdx >= triageIds.length) triageIdx = triageIds.length - 1;
  triagePaint();
}

/* ---------- JD 相关性标记（取舍辅助：用 AI 面板里的 JD 提取高频词，行尾 ★命中数；无 JD 无痕） ---------- */
var JD_STOP = "的了和与及或在是对于有为把你我不他们这个那些等请需具备优先熟练熟悉能够负责参与相关工作经验岗位要求任职我们以上以及进行通过".split("");
var jdKwsCache = { jd: null, kws: [] };
function extractKws(jd) { // 零依赖启发式：英文词出现即计，中文取相邻二字组合且需出现 ≥2 次（标记是提示不是结论）
  var freq = {};
  (jd.match(/[A-Za-z][A-Za-z0-9+#./-]{1,19}/g) || []).forEach(function (w) {
    w = w.toLowerCase();
    freq[w] = (freq[w] || 0) + 2;
  });
  (jd.match(/[\u4e00-\u9fff]{2,}/g) || []).forEach(function (seg) {
    for (var i = 0; i + 1 < seg.length; i++) {
      var bi = seg.charAt(i) + seg.charAt(i + 1);
      if (JD_STOP.indexOf(bi.charAt(0)) >= 0 || JD_STOP.indexOf(bi.charAt(1)) >= 0) continue;
      freq[bi] = (freq[bi] || 0) + 1;
    }
  });
  return Object.keys(freq).filter(function (k) { return freq[k] >= 2; })
    .sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 30);
}
function updateJdMarks() {
  $$("#cards .jd-hit").forEach(function (el) { el.remove(); });
  var jd = (document.getElementById("ai-jd").value || "").trim();
  if (jdKwsCache.jd !== jd) jdKwsCache.jd = jd, jdKwsCache.kws = jd ? extractKws(jd) : [];
  if (!jdKwsCache.kws.length) return;
  var low = jdKwsCache.kws.map(function (k) { return k.toLowerCase(); });
  $$("#cards .card.section, #cards .card.entry, #cards .bullet-row").forEach(function (row) {
    var text = $$("input", row).map(function (i) { return i.value; }).join(" ");
    var ta2 = row.querySelector("textarea");
    if (ta2) text += " " + ta2.value;
    text = text.toLowerCase();
    var hits = 0;
    low.forEach(function (k) { if (text.indexOf(k) !== -1) hits++; });
    if (!hits) return;
    var s = document.createElement("span");
    s.className = "jd-hit";
    s.textContent = "★" + hits;
    s.title = "与 JD 命中 " + hits + " 个关键词（取舍时优先保留）";
    var head = row.querySelector(".card-head");
    (head || row).appendChild(s);
  });
}

/* ---------- 数据完整性守卫：id 缺失/重复会让 ⋯菜单、隐藏、查找命中错误条目（R13 教训的防线） ---------- */
function normalizeIds() {
  var seen = {}, changed = false, seq = 0;
  var tag = (state.name || "doc").replace(/^jobs\//, "").replace(/[^\w]/g, "").slice(0, 6);
  function fix(o, pfx) { // 确定性重编号：pfx-文档标签-序号，do/while 保证不与已有 id 冲突
    seq++;
    if (!o.id || seen[o.id]) {
      var nid;
      do { seq++; nid = pfx + "-" + tag + seq; } while (seen[nid]);
      o.id = nid;
      changed = true;
    }
    seen[o.id] = true;
  }
  (state.doc.sections || []).forEach(function (s) {
    fix(s, "s");
    (s.entries || []).forEach(function (e) {
      fix(e, "e");
      (e.bullets || []).forEach(function (b) { fix(b, "b"); });
    });
  });
  return changed;
}

/* ---------- 时间列格式助手：宽松校验（2024 / 2024.06 / 2024-06 / A~B / A-至今…），非法 amber 提示，不阻断不改数据 ---------- */
function timeFmtOk(v) {
  v = (v || "").trim();
  if (!v) return true;
  var p = "(\\d{4}([.\\-]\\d{1,2})?|至今|现在|now)";
  return new RegExp("^" + p + "\\s*(~|—|–|-|至)\\s*" + p + "$|^" + p + "$", "i").test(v);
}
function updateTimeFmt() {
  $$("input[data-k='entry'][data-f='right']").forEach(function (i) {
    var ok = timeFmtOk(i.value);
    i.classList.toggle("time-warn", !ok);
    i.title = ok ? "" : "建议格式：2024.06 ~ 至今（或 2024-06、2024.06 - 2025.03）；仅提示，不阻断输入";
  });
}

/* ---------- 照片文件存在性：字段指向的文件在 data/ 里不存在 → 输入框警示（R57），预览/导出将没有照片 ---------- */
function checkPhotoFile() {
  var inp = document.querySelector("#cards input[data-k='meta'][data-f='照片']");
  if (!inp) return;
  var name = (state.doc.meta["照片"] || "").trim();
  if (!name) { inp.classList.remove("time-warn"); inp.removeAttribute("title"); return; }
  fetch("/data/" + encodeURIComponent(name)).then(function (r) {
    if (r.body && r.body.cancel) r.body.cancel(); // 只要存在性，不下载图片内容
    var cur = document.querySelector("#cards input[data-k='meta'][data-f='照片']");
    if (!cur) return; // 期间重渲染：旧结果作废
    var missing = !r.ok;
    cur.classList.toggle("time-warn", missing);
    if (missing) cur.title = "data/ 里没有这个文件：预览与导出将没有照片。检查文件名，或点「选择」重新上传";
    else cur.removeAttribute("title");
  }).catch(function () {});
}

function cycleDoc(dir) { // Alt+↑/↓ 循环切换文档（R28）：主简历与副本同列，切完 toast 报名
  var list = state.list || [];
  if (!list.length) return;
  var i = list.indexOf(state.name);
  var next = list[(i + dir + list.length) % list.length];
  if (next === state.name) return;
  switchDoc(next);
  toast("切换到 " + (next === "主简历" ? "主简历" : next.replace(/^jobs\//, "")));
}
function switchDoc(name) {
  flushSave(); // 先把上一个文档挂起的编辑落盘，避免 900ms 窗口内切档串写
  triageExit(); // 取舍模式不跨文档：高亮与 HUD 是旧文档 DOM 的引用
  closeFind(); // 查找命中不跨文档：旧 id 在新文档里可能恰好存在，跳转会定位到错误内容
  state.name = name;
  try { localStorage.setItem("vui-last", name); } catch (e) {}
  return getJSON("/api/doc?name=" + encodeURIComponent(name)).then(function (doc) {
    state.doc = doc;
    if (normalizeIds()) scheduleSave(); // 打开即修复 id 缺失/重复并落盘
    var job = doc.kind === "job";
    document.getElementById("rail-docicon").innerHTML = job ? SVG_TARGET : SVG_DOC;
    document.getElementById("rail-docname").textContent = job ? name.replace(/^jobs\//, "") : "主简历";
    var kEl = document.getElementById("rail-kind");
    kEl.textContent = job ? "岗位副本" : "主简历（完整版）";
    kEl.className = job ? "job" : "";
    var dc = document.getElementById("doc-chip");
    if (dc) dc.textContent = job ? "🎯 " + name.replace(/^jobs\//, "") : "📄 主简历";
    document.getElementById("job-banner").classList.toggle("hidden", !job);
    var dens = (doc.meta && doc.meta.密度) || "标准";
    $$("#density-seg button").forEach(function (b) {
      var on = b.getAttribute("data-density") === dens;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    undoStack.length = 0; redoStack.length = 0; baseline = snap(); // 撤销栈不跨文档
    updateUndoBtns();
    state.appliedAI = {}; // AI 已应用标记不跨文档
    resetAIRequestState();
    if (!document.getElementById("ai-panel").classList.contains("ai-closed")) { aiJdFor = null; toggleAIPanel(true); } // 面板开着：JD 与建议跟随新文档
    state.gauge = null; // 陈旧页数不跨文档：导出超页兜底只认新测量值（未测完则跳过兜底，R34）
    renderCards();
    updateChars();
    renderRail();
    pushPreview();
  }).catch(function (e) { toast("文档加载失败：" + name + (e && e.message ? "（" + e.message + "）" : "")); });
}

/* ---------- 侧边导航 ---------- */
function svgI(paths) {
  return "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>" + paths + "</svg>";
}
var SVG_DOC = svgI("<path d='M7 3h7l4 4v14H7z'/><path d='M14 3v4h4'/>");
var SVG_TARGET = svgI("<circle cx='12' cy='12' r='8'/><circle cx='12' cy='12' r='3.5'/>");
var SVG_X = svgI("<path d='M6 6l12 12M18 6L6 18'/>");
var SVG_REN = svgI("<path d='M4 20h4L19 9l-4-4L4 16v4z'/>");
var SVG_BK = svgI("<circle cx='12' cy='12' r='8'/><path d='M12 8v4l3 2'/>");
var SVG_EYE = svgI("<path d='M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'/><circle cx='12' cy='12' r='3'/>");
var SVG_FOLDER = svgI("<path d='M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>");
var SVG_PIN = svgI("<path d='M12 16v6'/><path d='M8.5 3h7l-1 7 3.5 3.5H6L9.5 10z'/>");
var railFilter = "";
function renderRail() { // 文档列表平铺在侧栏「文档」组，当前文档带指示条；岗位副本悬停出现删除；railFilter 非空时按名称筛选
  var f = (railFilter || "").toLowerCase();
  var rows = "";
  (state.list || []).forEach(function (n) {
    if (f && n.toLowerCase().indexOf(f) === -1) return;
    var job = n !== "主简历", active = n === state.name;
    var m = (state.meta || {})[n] || {}; // 导出状态：绿=已导出最新，琥珀=导出后有改动（R24）
    var exp = "";
    if (m.exportedAt) {
      var stale = !!(m.savedAt && m.savedAt > m.exportedAt);
      exp = "<span class='rail-exp" + (stale ? " stale" : " ok") + "' title='" +
            (stale ? "导出后内容有改动，PDF 还是旧版——重新导出即可" : "已导出 PDF（" + esc(m.exportedAt.replace("T", " ")) + "）") +
            "' aria-label='" + (stale ? "有改动未重新导出" : "已导出") + "'></span>";
    }
    var mm = (state.meta || {})["主简历"] || {}; // 漂移提示（R30）：主简历在副本创建后又保存过 → 该副本行带 ↑
    var drift = job && m.masterAt && mm.savedAt && mm.savedAt > m.masterAt;
    rows += "<div class='rail-row" + (active ? " active" : "") + "'>" +
         "<button class='rail-item" + (active ? " active" : "") + "' data-nav='doc' data-doc=\"" + esc(n) +
         "\" title=\"" + esc(n) + (drift ? "（主简历创建后已更新，可新建副本带入最新内容）" : "") + "\"" + (active ? " aria-current='true'" : "") + ">" +
         "<span class='ric'>" + (job ? SVG_TARGET : SVG_DOC) + "</span>" +
         "<span class='con'>" + (drift ? "<span class='drift' title='主简历创建后已更新，可新建副本带入最新内容'>↑</span>" : "") +
         esc(job ? n.replace(/^jobs\//, "") : "主简历") + "</span></button>" +
         exp +
         (job ? "<button class='rail-ren' data-nav='rendoc' data-doc=\"" + esc(n) +
               "\" title='重命名此岗位副本' aria-label='重命名 " + esc(n) + "'>" + SVG_REN + "</button>" : "") +
         "<button class='rail-bk' data-nav='bkdoc' data-doc=\"" + esc(n) +
         "\" title='历史备份与恢复' aria-label='历史备份 " + esc(n) + "'>" + SVG_BK + "</button>" +
         (job ? "<button class='rail-del' data-nav='deldoc' data-doc=\"" + esc(n) +
               "\" title='删除此岗位副本（主简历不受影响）' aria-label='删除 " + esc(n) + "'>" + SVG_X + "</button>" : "") +
         "</div>";
  });
  document.getElementById("rail-docs").innerHTML = (!rows && f) ? "<div class='rail-empty'>无匹配文档</div>" : rows;
}

/* ---------- 左侧卡片渲染 ---------- */
function ctlBtns(kind, id) { // 操作集合按钮：常驻低饱和 ⋯，点击弹出 上移/下移/删除 菜单（替代悬停浮现三连钮的死占位）
  return "<button class='ctl-menu' data-menu data-k='" + kind + "' data-id='" + id +
    "' title='操作：上移 / 下移 / 删除' aria-haspopup='menu' aria-expanded='false'>⋯</button>";
}
function showToggle(kind, id, hidden, job) { // 显示/隐藏切换：琥珀实心=已隐藏（例外态），不弹 toast。
  // 放置跟随频率、模式决定常驻：岗位取舍是全产品最高频动作 → 岗位副本可见行保留一键眼睛；
  // 主简历隐藏是低频清理 → 可见行不放按钮，走行尾 ⋯ 菜单首项（两模式的菜单里都有同一操作）。
  if (hidden || job) {
    var tip = hidden ? (job ? "已隐藏。点击恢复显示（本岗位版）" : "已隐藏。点击恢复显示")
                     : "显示中。点击从本岗位版隐藏（主简历不受影响），再点恢复";
    return "<button class='show-toggle" + (hidden ? " off" : "") + "' data-act='show' data-k='" + kind +
      "' data-id='" + id + "' title='" + tip + "' aria-pressed='" + (hidden ? "false" : "true") +
      "' aria-label='切换显示/隐藏'>" + SVG_EYE + "</button>";
  }
  return ""; // 主简历可见行：低频操作收进 ⋯ 菜单
}
function renderCards() {
  var doc = state.doc;
  var box = document.getElementById("cards");
  var sc = document.getElementById("left").scrollTop;
  if (!doc) { box.innerHTML = ""; return; }
  var job = doc.kind === "job";
  var h = "";

  /* 头部信息卡 */
  h += "<div class='card'><div class='card-head'><strong>基本信息</strong></div>";
  ["姓名", "电话", "邮箱", "年龄", "城市", "求职意向", "照片"].forEach(function (f) {
    var ph = f === "照片" ? "点「选择」上传，或填 data/ 里已有的图片文件名" : f;
    h += "<div class='row'><span class='meta-input' style='width:56px'>" + f + "</span>" +
         "<input class='grow' data-k='meta' data-f='" + f + "' value=\"" + esc(doc.meta[f] || "") + "\" placeholder=\"" + ph + "\">" +
         (f === "照片" ? "<button class='btn small' data-act='pick-photo' title='打开文件对话框选择本地图片，自动上传到 data/'>" + SVG_FOLDER + " 选择</button>" +
           (doc.meta["照片"] ? "<button class='btn small' data-act='remove-photo' title='从简历移除照片（文件保留在 data/）'>✕ 移除</button>" : "") : "") +
         "</div>";
  });
  h += "</div>";

  /* 章节卡 */
  if (!(doc.sections || []).length) {
    h += "<div class='empty-tip big'>还没有章节：点下方「＋ 添加章节」开始搭建，或在 AI 助手里让 AI 帮你搭结构</div>";
  }
  (doc.sections || []).forEach(function (sec) {
    var fd = !!(state.folded[state.name] || {})[sec.id];
    h += "<div class='card section" + (sec.hidden ? " item-off" : "") + (fd ? " folded" : "") + "' data-drop='section' data-id='" + sec.id + "'>";
    h += "<div class='card-head'>" +
         "<button class='fold-btn' data-act='fold' data-id='" + sec.id + "' aria-expanded='" + (fd ? "false" : "true") + "' title='" + (fd ? "展开章节" : "折叠为仅标题（方便拖动排序）") + "'>" + (fd ? "▸" : "▾") + "</button>" +
         "<span class='handle' draggable='true' data-dragk='section' data-id='" + sec.id + "'>⠿</span>" +
         "<input class='title-in' data-k='section' data-f='标题' data-id='" + sec.id + "' value=\"" + esc(sec["标题"]) + "\">" +
         showToggle("section", sec.id, sec.hidden, job) +
         ctlBtns("section", sec.id) + "</div>";
    (sec.entries || []).forEach(function (en) {
      h += "<div class='card entry" + (en.hidden ? " item-off" : "") + "' data-drop='entry' data-id='" + en.id + "'>";
      h += "<div class='row'>" +
           "<span class='handle' draggable='true' data-dragk='entry' data-id='" + en.id + "'>⠿</span>" +
           "<input class='grow' data-k='entry' data-f='left' data-id='" + en.id + "' value=\"" + esc(en.left) + "\" placeholder='主体（公司 / 项目 / 学校）'>" +
           "<input style='width:140px;flex:none' data-k='entry' data-f='right' data-id='" + en.id + "' value=\"" + esc(en.right) + "\" placeholder='时间'>" +
           showToggle("entry", en.id, en.hidden, job) +
           ctlBtns("entry", en.id) + "</div>";
      h += "<div class='row'><input class='grow meta-input' data-k='entry' data-f='meta' data-id='" + en.id + "' value=\"" + esc(en.meta) + "\" placeholder='灰色说明行：角色 / 团队 / 技术栈（可选）'></div>";
      h += "<div class='row'><input class='grow tags-input' data-k='entry' data-f='tags' data-id='" + en.id + "' value=\"" + esc(en.tags) + "\" placeholder='tags: #标签（AI 匹配用，不打印）'></div>";
      (en.bullets || []).forEach(function (b) {
        h += "<div class='bullet-row" + (b.hidden ? " item-off" : "") + "' data-drop='bullet' data-id='" + b.id + "'>" +
             "<span class='handle' draggable='true' data-dragk='bullet' data-id='" + b.id + "'>⠿</span>" +
             "<textarea data-k='bullet' data-id='" + b.id + "' rows='2' placeholder='一条成果：动词开头 + 量化结果，**加粗** 关键数字'>" + esc(b.text) + "</textarea>" +
             "<span class='bcount' data-bc='" + b.id + "'></span>" +
             "<button class='ctl-b' data-act='bold' data-id='" + b.id + "' title='加粗选中文字；已加粗时点击取消（Ctrl+B 同）' aria-label='加粗/取消加粗' aria-pressed='false'>B</button>" +
             showToggle("bullet", b.id, b.hidden, job) +
             ctlBtns("bullet", b.id) + "</div>";
      });
      if (!(en.bullets || []).length) h += "<div class='empty-tip'>建议加 2~4 条量化成果：动词开头 + **加粗数字**</div>";
      h += "<button class='add-btn' data-act='add-bullet' data-id='" + en.id + "'>＋ 添加成果</button></div>";
    });
    if (!(sec.entries || []).length) h += "<div class='empty-tip'>空章节：点下方按钮添加第一条经历（教育 / 实习 / 项目…）</div>";
    h += "<button class='add-btn' data-act='add-entry' data-id='" + sec.id + "'>＋ 添加条目</button></div>";
  });
  h += "<button class='add-btn' data-act='add-section'>＋ 添加章节</button>";
  box.innerHTML = h;
  document.getElementById("empty-hint").classList.toggle("hidden", !!doc);
  document.getElementById("left").scrollTop = sc;
  initSortables();
  updateChars();
}

/* ---------- 字数统计 ---------- */
function updateChars() {
  var n = 0, hid = 0;
  (state.doc.sections || []).forEach(function (s) {
    if (s.hidden) { hid++; return; } // 隐藏章节整体计 1，内部不再重复计
    (s.entries || []).forEach(function (e) {
      if (e.hidden) { hid++; return; }
      (e.bullets || []).forEach(function (b) {
        var len = (b.text || "").replace(/\*\*/g, "").length;
        if (!b.hidden) n += len; else hid++;
        var el = document.querySelector("[data-bc='" + b.id + "']");
        if (el) el.textContent = len ? len + " 字" : "";
      });
    });
  });
  var chip = document.getElementById("chars");
  if (chip) chip.textContent = "成果字数 " + n;
  var hc = document.getElementById("hidden-chip");
  if (hc) { hc.textContent = "已隐藏 " + hid; hc.classList.toggle("hidden", hid === 0); } // 0 时无痕
  updateJdMarks();
  updateTimeFmt();
  checkPhotoFile(); // 照片字段指向的文件缺失时警示（R57）
  updateDocTitle(); // 标签页标题随文档联动（R64）
}
var lastDocTitle = ""; // 标题去抖（R64）：没换文档就不重复赋值
function updateDocTitle() { // 标签页标题随文档联动（R64）：多标签/多窗口一眼分清（配合 R59 冲突提示场景）
  var t = state.name ? state.name.replace(/^jobs\//, "") + " · 简历工作台" : "简历工作台";
  if (t !== lastDocTitle) { lastDocTitle = t; document.title = t; }
}

/* ---------- 拖拽排序（SortableJS 三层嵌套；无库时退回原生 DnD）---------- */
function syncOrderFromDOM() { // 拖完按 DOM 顺序回写数据模型（条目可跨章节移动，成果可跨条目移动）
  var newSections = [];
  $$("#cards > .card.section").forEach(function (se) {
    var s = secById(se.getAttribute("data-id"));
    if (!s) return;
    s.entries = $$(".card.entry", se).map(function (ee) {
      var f = findEntry(ee.getAttribute("data-id"));
      f.entry.bullets = $$(".bullet-row", ee).map(function (be) {
        var fb = findBullet(be.getAttribute("data-id"));
        return fb ? fb.bullet : null;
      }).filter(Boolean);
      return f.entry;
    });
    newSections.push(s);
  });
  if (newSections.length) state.doc.sections = newSections;
  afterChange(true);
}
function initSortables() {
  state.sortables.forEach(function (s) { try { s.destroy(); } catch (e) {} });
  state.sortables = [];
  if (!window.Sortable) { initNativeDrag(); return; } // 渐进增强：断网/库缺失退回原生
  var common = { animation: 150, forceFallback: true, fallbackOnBody: true,
                 ghostClass: "drag-ghost", chosenClass: "drag-chosen", dragClass: "drag-fly",
                 onEnd: function () { syncOrderFromDOM(); } };
  state.sortables.push(new Sortable(document.getElementById("cards"), Object.assign({}, common,
    { handle: "[data-dragk='section']", draggable: ".card.section", group: "sec" })));
  $$("#cards .card.section").forEach(function (se) {
    state.sortables.push(new Sortable(se, Object.assign({}, common,
      { handle: "[data-dragk='entry']", draggable: ".card.entry", group: "entry" })));
  });
  $$("#cards .card.entry").forEach(function (en) {
    state.sortables.push(new Sortable(en, Object.assign({}, common,
      { handle: "[data-dragk='bullet']", draggable: ".bullet-row", group: "bullet" })));
  });
}
function initNativeDrag() { // 原生 HTML5 DnD 兜底（含边缘自动滚动）；只绑一次（renderCards 每次重建都会调到 initSortables，重复绑定会导致一次 drop 触发多次 syncOrderFromDOM）
  if (state.nativeDragBound) return;
  state.nativeDragBound = true;
  var cards = document.getElementById("cards");
  var dragInfo = null;
  cards.addEventListener("dragstart", function (e) {
    var h = e.target.closest(".handle");
    if (!h) return;
    dragInfo = { k: h.getAttribute("data-dragk"), id: h.getAttribute("data-id") };
    e.dataTransfer.setData("text/plain", "move");
    e.dataTransfer.effectAllowed = "move";
  });
  cards.addEventListener("dragover", function (e) {
    var card = e.target.closest("[data-drop]");
    if (card && dragInfo) { e.preventDefault(); $("[data-drop]").forEach(function (c) { c.classList.remove("drag-over"); }); card.classList.add("drag-over"); }
  });
  cards.addEventListener("drop", function (e) {
    var card = e.target.closest("[data-drop]");
    if (!card || !dragInfo) return;
    e.preventDefault();
    card.classList.remove("drag-over");
    var dstId = card.getAttribute("data-id"), dstKind = card.getAttribute("data-drop");
    if (dstKind !== dragInfo.k || dstId === dragInfo.id) { dragInfo = null; return; }
    var src = findAny(dragInfo.id).obj, dst = findAny(dstId).obj;
    var arr = dstKind === "section" ? state.doc.sections
      : dstKind === "entry" ? findEntry(dstId).section.entries
      : findBullet(dstId).entry.bullets;
    var i = arr.indexOf(src), j = arr.indexOf(dst);
    if (i >= 0 && j >= 0) {
      arr.splice(i, 1);
      arr.splice(arr.indexOf(dst) + (j > i ? 1 : 0), 0, src);
      afterChange(true);
    }
    dragInfo = null;
  });
  /* 拖拽靠近左栏上下边缘时自动滚动 */
  var leftPane = document.getElementById("left");
  var edgeEvt = null, edgeRaf = 0;
  function edgeScroll() {
    if (!dragInfo || !edgeEvt) { edgeRaf = 0; return; }
    var r = leftPane.getBoundingClientRect(), y = edgeEvt.clientY, v = 0;
    if (y < r.top + 60) v = -16 * (1 - Math.max(0, y - r.top) / 60);
    else if (y > r.bottom - 60) v = 16 * (1 - Math.max(0, r.bottom - y) / 60);
    if (v) leftPane.scrollTop += v;
    edgeRaf = requestAnimationFrame(edgeScroll);
  }
  leftPane.addEventListener("dragover", function (e) {
    edgeEvt = e;
    if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScroll);
  });
  document.addEventListener("dragover", function (e) {
    if (!leftPane.contains(e.target)) edgeEvt = null; // 拖出左栏即停
  });
  leftPane.addEventListener("dragleave", function (e) {
    if (!e.relatedTarget || !leftPane.contains(e.relatedTarget)) edgeEvt = null; // 拖进右侧预览区即停
  });
  leftPane.addEventListener("drop", function () { edgeEvt = null; });
  leftPane.addEventListener("dragend", function () { edgeEvt = null; });
}

/* ---------- 加粗（** 标记切换）/ 预览定位 ---------- */
/* 解析 ** 加粗构造：顺序扫描、两两配对（与 preview.html 的 inlineMd 是同一套规则，改动需两边同步） */
function boldRanges(v) {
  var ranges = [], i = 0, close;
  while ((i = v.indexOf("**", i)) !== -1) {
    close = v.indexOf("**", i + 2);
    if (close === -1) break; // 无闭合标记，剩余 ** 按普通文本处理
    ranges.push({ ms: i, me: close + 2, cs: i + 2, ce: close }); // ms/me=含标记跨度，cs/ce=内容跨度
    i = close + 2;
  }
  return ranges;
}
function setTa(ta, v, selStart, selEnd) { // 回写 textarea + 数据模型 + 撤销/预览/字数
  ta.value = v;
  var fb = findBullet(ta.getAttribute("data-id"));
  if (fb) fb.bullet.text = v;
  ta.focus(); ta.selectionStart = selStart; ta.selectionEnd = selEnd;
  afterChange(false, true); // force：每次加粗切换独立成一个撤销步（连点两次 B = 两步）
  syncBoldState();
}
function toggleBold(ta) { // WYSIWYG 标准语义：全加粗选区 -> 取消；其余 -> 全部加粗
  var s = ta.selectionStart, e2 = ta.selectionEnd, v = ta.value;
  if (s == null) return;
  var ranges = boldRanges(v), i, r, t;
  if (s === e2) { // 空选区：光标在加粗构造内 -> 整段取消；否则插入空对 **** 继续输入
    for (i = 0; i < ranges.length; i++) {
      r = ranges[i];
      if (s >= r.ms && s <= r.me) return unwrapBold(ta, r, s, s);
    }
    return setTa(ta, v.slice(0, s) + "****" + v.slice(s), s + 2, s + 2);
  }
  s = normEdge(s, ranges); e2 = normEdge(e2, ranges); // 端点卡在标记字符上时对齐到构造边界
  if (s > e2) { t = s; s = e2; e2 = t; }
  for (i = 0; i < ranges.length; i++) { // 选区完整落在一组标记内（含星号）-> 取消加粗
    r = ranges[i];
    if (s >= r.ms && e2 <= r.me) return unwrapBold(ta, r, s, e2);
  }
  wrapBold(ta, s, e2, ranges); // 其余（部分加粗/跨构造）-> 先拆重叠构造再整体包一层
}
function normEdge(p, ranges) {
  for (var i = 0; i < ranges.length; i++) {
    var r = ranges[i];
    if (p > r.ms && p < r.cs) return r.ms;  // 卡在开标记 ** 中间
    if (p > r.ce && p < r.me) return r.me;  // 卡在闭标记 ** 中间
  }
  return p;
}
function unwrapBold(ta, r, s, e2) { // 拆掉一组 ** 标记，选区按位移恢复
  var v = ta.value;
  var nv = v.slice(0, r.ms) + v.slice(r.cs, r.ce) + v.slice(r.me);
  function shift(p) { return p >= r.me ? p - 4 : p > r.ms ? p - 2 : p; }
  setTa(ta, nv, shift(s), shift(e2));
}
function wrapBold(ta, s, e2, ranges) { // 全部加粗：先拆掉与选区重叠的已有构造（从后往前，位置不受影响），再整体包一层
  var v = ta.value, i, r;
  for (i = ranges.length - 1; i >= 0; i--) {
    r = ranges[i];
    if (r.ms < e2 && r.me > s) {
      v = v.slice(0, r.ms) + v.slice(r.cs, r.ce) + v.slice(r.me);
      if (s >= r.me) { s -= 4; e2 -= 4; } else if (s > r.ms) { s -= 2; e2 -= e2 >= r.me ? 4 : 2; }
      else if (e2 > r.ms) { e2 -= e2 >= r.me ? 4 : 2; }
    }
  }
  v = v.slice(0, s) + "**" + v.slice(s, e2) + "**" + v.slice(e2);
  setTa(ta, v, s + 2, e2 + 2);
}
function syncBoldState() { // 光标/选区落在加粗内 -> 该行 B 按钮亮起（aria-pressed），失焦熄灭
  var ta = document.activeElement;
  if (!(ta && ta.tagName === "TEXTAREA" && ta.getAttribute("data-k") === "bullet")) ta = null;
  $$(".ctl-b.on").forEach(function (b) { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); });
  if (!ta) return;
  var s = ta.selectionStart, e2 = ta.selectionEnd;
  if (s == null) return;
  var a = Math.min(s, e2), b2 = Math.max(s, e2), ranges = boldRanges(ta.value), inside = false, i, r;
  for (i = 0; i < ranges.length; i++) {
    r = ranges[i];
    if (a === b2 ? (a >= r.ms && a <= r.me) : (a >= r.ms && b2 <= r.me)) { inside = true; break; }
  }
  var row = ta.closest(".bullet-row"), btn = row && row.querySelector(".ctl-b");
  if (btn) { btn.classList.toggle("on", inside); btn.setAttribute("aria-pressed", inside ? "true" : "false"); }
}
function locateCard(id) {
  var el = document.querySelector("#cards [data-id='" + id + "']");
  var sec = el && el.closest(".card.section");
  if (sec && sec.classList.contains("folded")) { // 目标在折叠章节内先展开
    var fid = sec.getAttribute("data-id");
    var fsec = state.folded[state.name] || (state.folded[state.name] = {});
    delete fsec[fid];
    saveFoldStore();
    renderCards();
    el = document.querySelector("#cards [data-id='" + id + "']");
  }
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(function () { el.classList.remove("flash"); }, 1300);
}

/* ---------- 保存与预览 ---------- */
var pendingSave = null; // 待落盘的 {name, doc}：捕获触发时的归属，切文档前强制落盘防串写
function saveFailToast() {
  toast("保存失败——内容仍在页面上，点「重试」或右下状态文字", 8000, { label: "重试", fn: flushSave });
}
var staleWarn = { name: "", at: 0 }; // 多窗口冲突提示节流（R59）：同文档 5 分钟只提醒一次
function doSave(name, doc) {
  setSaveState("✎ 修改中…", "busy");
  return postJSON("/api/save", { name: name, doc: doc }).then(function (r) {
    if (r.ok) {
      if (r.savedAt && doc && doc.meta) doc.meta.savedAt = r.savedAt; // 基线推进：自己下一次保存不误报（R59）
      flashOk("✓ 已保存"); refreshRailMeta(); // savedAt 变化 → 侧栏状态点即时转琥珀
      if (r.stale && name) { // 别的窗口在本文档加载后保存过：本窗口的覆盖生效了，必须让用户知道（R59）；一键直达历史备份（R66）
        // 注意顺序：放在 flashOk 之后写入，冲突提示（12s、带动作）不被 ✓闪现覆盖
        var nw = Date.now();
        if (name !== staleWarn.name || nw - staleWarn.at > 5 * 60 * 1000) {
          staleWarn.name = name; staleWarn.at = nw;
          toast("这份文档刚被其他窗口修改过——本次保存以当前窗口内容为准", 12000,
            { label: "打开历史备份", fn: function () { // openBackups 声明在 bindEvents 作用域内，顶层不可直达：点侧栏 🕘 走既有委托链（同 exportByName 模式）
                var bk = null;
                $$(".rail-bk").forEach(function (x) { if (x.getAttribute("data-doc") === name) bk = x; });
                if (bk) bk.click(); else toast("未找到该文档的备份入口（文档列表可能未就绪）");
              } });
        }
      }
    }
    else { setSaveState("⚠ 保存失败", "warn"); saveFailToast(); }
  }).catch(function () {
    setSaveState("⚠ 保存失败", "warn"); saveFailToast();
  });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  pendingSave = { name: state.name, doc: state.doc }; // doc 为引用：切档后旧引用不再变，落盘内容正确
  setSaveState("✎ 修改中…", "busy");
  saveTimer = setTimeout(flushSave, 900);
}
function flushSave() { // 立即落盘挂起的修改（切文档/删除前调用，避免 900ms 窗口竞态）
  clearTimeout(saveTimer); saveTimer = null;
  if (!pendingSave) return;
  var p = pendingSave; pendingSave = null;
  doSave(p.name, p.doc);
}
function flushOnHide(force) { // 关页/切走兜底（R37）：900ms 防抖窗口内直接关页会丢最后一批修改，这里强制立即落盘
  if (!pendingSave) return;
  var p = pendingSave; pendingSave = null;
  clearTimeout(saveTimer); saveTimer = null;
  if ((force || document.visibilityState === "hidden") && navigator.sendBeacon) {
    try { // 卸载过程中的 fetch 会被浏览器取消，sendBeacon 不随页面卸载取消
      if (navigator.sendBeacon("/api/save", new Blob([JSON.stringify(p)], { type: "application/json" }))) {
        flashOk("✓ 已保存"); return;
      }
    } catch (e) { /* sendBeacon 不可用则落回 doSave */ }
  }
  doSave(p.name, p.doc);
}
window.addEventListener("beforeunload", function () { flushOnHide(true); });
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushOnHide(true); });
function pushPreview() {
  var f = document.getElementById("preview");
  if (!f.contentWindow) return;
  if (!iframeReady) { pendingRender = true; return; } // iframe 未就绪，等 load 后补发
  pendingRender = false;
  f.contentWindow.postMessage({ type: "render", doc: state.doc }, "*");
}
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(pushPreview, 250);
}
function afterChange(structural, force) {
  beforeChange(force);
  if (structural) renderCards();
  scheduleSave();
  schedulePreview();
  baseline = snap();
  updateChars();
  updateJdMarks();
  updateTimeFmt(); // 手打时间实时校验提示
  syncAppliedAI(); // 内容事实变化 → 按事实重算「已应用」标记（R56）：徽标=当前内容，不靠应用时的记忆
  if (!document.getElementById("ai-panel").classList.contains("ai-closed")) repaintAppliedAI(); // 面板开着：徽标与工具条就地跟进
  if (findOpen() && findState.q) findScan(findState.q); // 查找条开着时编辑内容 → 命中实时重扫，计数不说谎
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  var cards = document.getElementById("cards");
  var pendingFocus = null; // 添加后聚焦新输入框，连续录入不用再点一次

  cards.addEventListener("input", function (e) {
    var t = e.target, k = t.getAttribute("data-k");
    if (!k) return;
    var v = t.value, id = t.getAttribute("data-id"), f = t.getAttribute("data-f");
    if (k !== "bullet" && !f) return; // 防脏键：无字段名的控件（如旧复选框）不得写模型
    if (k === "meta") { state.doc.meta[f] = v; if (f === "照片") checkPhotoFile(); } // 手填照片文件名即时校验存在性（R57）
    else if (k === "section") { var s = secById(id); if (s) s[f] = v; }
    else if (k === "entry") { var r = findEntry(id); if (r) r.entry[f] = v; }
    else if (k === "bullet") { var b = findBullet(id); if (b) b.bullet.text = v; } // 写 b.bullet.text（findBullet 返回包装对象；曾误写 b.text 导致手打 bullet 从未落模型）
    afterChange(false);
  });

  document.addEventListener("click", function (e) { // 委托在 document：⋯ 菜单项（body 级）与卡片按钮共用同一套 act 链
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act"), k = btn.getAttribute("data-k"), id = btn.getAttribute("data-id");
    if (act === "show") { // 显示切换（行内眼睛或 ⋯ 菜单首项）：即时生效 + 按压态，不弹 toast
      var f0 = findAny(id);
      if (f0) {
        f0.obj.hidden = !f0.obj.hidden;
        if (btn.closest(".vui-menu")) { // 菜单发起：点击的不是行内眼睛，重建行以同步琥珀眼睛（主简历隐藏后眼睛才出现）
          afterChange(true, true);
        } else {
          btn.classList.toggle("off", f0.obj.hidden);
          btn.setAttribute("aria-pressed", f0.obj.hidden ? "false" : "true");
          var host = btn.closest(".card, .bullet-row");
          if (host) host.classList.toggle("item-off", f0.obj.hidden);
          afterChange(false, true);
        }
      }
      return;
    }
    if (act === "fold") { // 折叠/展开章节：仅编辑器显示状态，不改文档；按文档记忆
      var fs = state.folded[state.name] || (state.folded[state.name] = {});
      fs[id] = !fs[id];
      saveFoldStore();
      renderCards();
      return;
    }
    if (act === "pick-photo") { // 打开系统文件对话框选照片
      document.getElementById("photo-file").click();
      return;
    }
    if (act === "remove-photo") { // 从简历移除照片：可撤销（文件仍留在 data/）
      var prev = state.doc.meta["照片"] || "";
      state.doc.meta["照片"] = "";
      renderCards();
      afterChange(false, true);
      toast("已从简历移除照片（文件保留在 data/）", 8000, { label: "撤销", fn: function () {
        state.doc.meta["照片"] = prev; renderCards(); afterChange(false, true);
      } });
      return;
    }
    if (act === "add-section") {
      var ns = { id: uid("s"), "标题": "新章节", hidden: false, entries: [] };
      state.doc.sections.push(ns);
      pendingFocus = { sel: "#cards .card.section[data-id='" + ns.id + "'] .title-in" };
    } else if (act === "add-entry") {
      var s0 = secById(id);
      if (s0) {
        var ne = { id: uid("e"), left: "", right: "", meta: "", tags: "", hidden: false, bullets: [{ id: uid("b"), text: "", hidden: false }] };
        s0.entries.push(ne);
        pendingFocus = { sel: "#cards .card.entry[data-id='" + ne.id + "'] input[data-f='left']" };
      }
    } else if (act === "add-bullet") {
      var r0 = findEntry(id);
      if (r0) {
        var nb = { id: uid("b"), text: "", hidden: false };
        r0.entry.bullets.push(nb);
        pendingFocus = { sel: "#cards .bullet-row[data-id='" + nb.id + "'] textarea" };
      }
    } else if (act === "del") {
      var what = ({ section: "章节", entry: "条目", bullet: "成果" })[k] || "内容";
      askConfirm("删除这条" + what + "？", "删除后可用 Ctrl+Z 或提示条上的「撤销」按钮随时恢复。", function () {
        if (k === "section") state.doc.sections = state.doc.sections.filter(function (s) { return s.id !== id; });
        else if (k === "entry") {
          var f1 = findEntry(id);
          if (f1) f1.section.entries = f1.section.entries.filter(function (x) { return x.id !== id; });
        } else if (k === "bullet") {
          var f2 = findBullet(id);
          if (f2) f2.entry.bullets = f2.entry.bullets.filter(function (x) { return x.id !== id; });
        }
        afterChange(true);
        toast("已删除" + what, 8000, { label: "撤销", fn: undo });
      });
      return;
    } else if (act === "bold") {
      var row = btn.closest(".bullet-row");
      var ta2 = row && row.querySelector("textarea");
      if (ta2) toggleBold(ta2);
      return;
    } else if (act === "up" || act === "down") {
      var d = act === "up" ? -1 : 1;
      function mv(arr, item) {
        var i = arr.indexOf(item); var j = i + d;
        if (i < 0 || j < 0 || j >= arr.length) return;
        arr.splice(i, 1); arr.splice(j, 0, item);
      }
      if (k === "section") mv(state.doc.sections, secById(id));
      else if (k === "entry") { var f3 = findEntry(id); if (f3) mv(f3.section.entries, f3.entry); }
      else if (k === "bullet") { var f4 = findBullet(id); if (f4) mv(f4.entry.bullets, f4.bullet); }
    }
    afterChange(true);
    if (pendingFocus) { // 新增的输入框直接聚焦，连续录入不中断
      var fe = document.querySelector(pendingFocus.sel);
      if (fe) { fe.focus(); if (fe.select) fe.select(); }
      pendingFocus = null;
    }
  });

  /* ⋯ 操作菜单：开合、定位（贴底自动上翻）、外点/滚动/缩放关闭 */
  var menuEl = null, menuBtn = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (menuBtn) { menuBtn.setAttribute("aria-expanded", "false"); menuBtn = null; }
  }
  function openMenu(btn) {
    closeMenu();
    menuBtn = btn; btn.setAttribute("aria-expanded", "true");
    var k = btn.getAttribute("data-k"), id = btn.getAttribute("data-id");
    var job = state.doc && state.doc.kind === "job";
    var f0 = findAny(id), hid = !!(f0 && f0.obj.hidden);
    var showTip = hid ? "恢复后重新进入预览与导出"
      : job ? "本岗位版预览与导出不显示，主简历不受影响；行尾眼睛按钮同样一键切换"
      : "预览与导出 PDF 均不显示；行尾眼睛按钮同样一键切换";
    var m = document.createElement("div");
    m.className = "vui-menu"; m.setAttribute("role", "menu");
    m.innerHTML =
      "<button role='menuitem' data-act='show' data-k='" + k + "' data-id='" + id + "' title='" + showTip + "'>" +
        SVG_EYE + (hid ? "恢复显示" : "隐藏") + "</button>" +
      "<button role='menuitem' data-act='up' data-k='" + k + "' data-id='" + id + "'>▲ 上移</button>" +
      "<button role='menuitem' data-act='down' data-k='" + k + "' data-id='" + id + "'>▼ 下移</button>" +
      "<button role='menuitem' class='del' data-act='del' data-k='" + k + "' data-id='" + id + "'>✕ 删除</button>";
    document.body.appendChild(m); menuEl = m;
    var r = btn.getBoundingClientRect(), top = r.bottom + 6;
    if (top + m.offsetHeight > window.innerHeight - 8) top = r.top - m.offsetHeight - 6; // 贴近视口底部改为上翻
    m.style.top = top + "px";
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + "px";
    var first = m.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  }
  document.addEventListener("click", function (e) { // 注册在 act 委托之后：菜单项先跑动作，这里只负责开关与收尾
    var t = e.target.closest ? e.target.closest("[data-menu]") : null;
    if (t) { if (menuBtn === t) closeMenu(); else openMenu(t); return; }
    if (menuEl) {
      if (menuEl.contains(e.target)) setTimeout(closeMenu, 0);
      else closeMenu();
    }
  });
  document.addEventListener("scroll", closeMenu, { capture: true, passive: true });
  window.addEventListener("resize", closeMenu);

  /* 显示/隐藏已改为眼睛按钮（走上方 click 委托），无需 change 监听 */

  /* 拖拽：由 initSortables()（SortableJS）接管；库缺失时退回 initNativeDrag() */

  /* 预览通信 */
  var frame = document.getElementById("preview");
  frame.addEventListener("load", function () { iframeReady = true; pushPreview(); });  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type === "locate" && d.id) { locateCard(d.id); return; }
    if (d.type === "photoZoom" && d.src) { showPhotoZoom(d.src); return; } // 预览里点照片：放大查看
    if (d.type !== "vui-gauge") return;
    state.gauge = d;
    var p = document.getElementById("gauge-pages"), f = document.getElementById("gauge-fill");
    p.textContent = d.pages + " 页";
    p.className = "chip " + (d.pages > 1 && state.doc && state.doc.kind === "job" ? "warn" : "");
    var pct = d.fill || 0;
    f.textContent = "版面 " + pct + "%";
    f.title = "内容高度占版心比例；超过 100% 会溢出一页，建议取舍或收紧";
    var job = state.doc && state.doc.kind === "job";
    f.className = "chip " + ((d.over || pct > 100) ? "warn" : pct >= 90 ? "ok" : "mid"); // 溢出一律警示，不分主副简历
    adjustZoom();
  });

  /* 侧边导航：事件委托分发（文档/删除副本/新建副本/AI/保存/导出/引导/图钉） */
  function saveNow() {
    pendingSave = { name: state.name, doc: state.doc };
    flushSave(); // 反馈就在状态行本身：就绪 → ✎修改中 → ✓已保存 → 2s 后归于就绪，不弹 toast
  }
  function exportNow(navBtn) {
    function go() {
      if (navBtn) navBtn.disabled = true;
      setSaveState("⬇ 导出中…", "warn");
      postJSON("/api/save", { name: state.name, doc: state.doc }).then(function (sv) {
        if (sv && sv.savedAt && state.doc.meta) state.doc.meta.savedAt = sv.savedAt; // 基线推进（R59）
        return postJSON("/api/export", { name: state.name });
      }).then(function (r) {
        if (navBtn) navBtn.disabled = false;
        flashOk("✓ 已保存");
        if (r.ok) {
          if (r.savedAt && state.doc.meta) state.doc.meta.savedAt = r.savedAt; // 导出也推进磁盘 savedAt：基线同步，别让自己的导出误报冲突（R59）
          refreshRailMeta();
          var w = null;
          try { w = window.open(r.pdf, "_blank"); } catch (e) {}
          if (w) toast("PDF 已导出：" + r.pdf);
          else toast("PDF 已导出：" + r.pdf, 12000, { label: "打开", fn: function () { window.open(r.pdf, "_blank"); } }); // 异步链路里自动打开常被弹窗拦截：给一个手势内必成的「打开」按钮（R53）
        }
        else toast("导出失败：" + (r.error || "未知错误"));
      }).catch(function (e) { if (navBtn) navBtn.disabled = false; setSaveState("就绪"); toast("导出失败：" + e.message); });
    }
    function proceed() { // 超页兜底确认（体检之后）
      if (state.doc && state.doc.kind === "job" && state.gauge && state.gauge.pages > 1) {
        askConfirm("岗位版超过一页", "当前约 " + state.gauge.pages + " 页，导出会逐级收紧排版硬塞进一页，可能偏密——建议先取舍内容。仍要导出吗？", go);
        return;
      }
      go();
    }
    var issues = state.doc ? lintDoc(state.doc) : [];
    if (issues.length) showLintModal(issues, proceed); // 交付体检：有问题先过目，用户拍板
    else proceed();
  }
  function createJob(name) { // 真正创建：当前文档先落盘，避免竞态
    flushSave();
    postJSON("/api/newjob", { name: name }).then(function (r) {
      if (!r.ok) { toast("创建失败：" + (r.error || "")); return; }
      state.name = null;
      return loadList().then(function () { return switchDoc(r.name); }).then(function () {
        toast("副本已创建（内容=主简历）。下一步：取舍压到一页，或直接导出", 10000,
          { label: "进入取舍模式", fn: function () { triageStart(); } }); // 创建→取舍 闭环引导（R67）
      });
    }).catch(function (e) { // 服务不可达/中途异常：必须说话，不能看起来像无响应
      toast("创建失败：" + (e && e.message ? e.message : "") + "\n本地服务可能没在运行——双击「启动简历工作台.bat」后再试", 8000);
    });
  }
  function newJobFlow() {
    askText("新建岗位副本", "副本名称（建议：日期_公司_岗位）", "jobs/2026-XX-XX_公司_岗位", "如：2026-10-03_某公司_前端开发", function (name) {
      if (!name) { toast("名称不能为空"); return; }
      var full = name.indexOf("jobs/") === 0 ? name : "jobs/" + name;
      if (state.list.indexOf(full) !== -1) { // 同名已存在：明确确认后才覆盖
        askConfirm("同名副本已存在", "「" + full + "」已存在。继续将用主简历当前内容覆盖它；旧版本已自动留底，可随时在「历史备份」里找回。", function () { createJob(name); });
        return;
      }
      createJob(name);
    });
  }
  function deleteJob(name) {
    flushSave(); // 若删的是当前文档，先落盘避免删除后又被补写回磁盘
    postJSON("/api/delete", { name: name }).then(function (r) {
      if (!r.ok) { toast("删除失败：" + (r.error || "")); return; }
      toast("已删除 " + name);
      if (state.name === name) state.name = null;
      return loadList().then(function () {
        if (!state.name && state.list.length) return switchDoc(state.list[0]);
      });
    }).catch(function (e) { toast("删除失败：" + e.message); });
  }
  function renameFlow(name) {
    askText("重命名岗位副本", "新名称（建议：日期_公司_岗位）", name.replace(/^jobs\//, ""), "如：2026-10-03_某公司_前端开发", function (nv) {
      if (!nv) { toast("名称不能为空"); return; }
      var to = nv.indexOf("jobs/") === 0 ? nv : "jobs/" + nv;
      if (to === name) return;
      if (state.list.indexOf(to) !== -1) { toast("同名副本已存在，换个名称"); return; }
      renameJob(name, to);
    });
  }
  function renameJob(from, to) { // JSON 与 PDF 一起改名；当前文档被改名则跟随切换；可撤销（撤销=改回去）
    flushSave();
    var wasActive = state.name === from;
    postJSON("/api/rename", { from: from, to: to }).then(function (r) {
      if (!r.ok) { toast("改名失败：" + (r.error || "")); return; }
      return loadList().then(function () {
        if (wasActive) return switchDoc(to);
      }).then(function () {
        toast("已重命名为「" + to.replace(/^jobs\//, "") + "」", 8000, { label: "撤销", fn: function () { renameJob(to, from); } });
      });
    }).catch(function (e) { toast("改名失败：" + e.message); });
  }
function openBackups(name) { // 历史备份与恢复（R25）：恢复=破坏类操作 → 确认 + 可撤销（撤销=把恢复前的内容存回去）
  modalCaptureFocus();
  flushSave(); // 恢复覆盖的是磁盘内容：先把未落盘的修改写掉，避免恢复后又被补写回
    var shortName = name.replace(/^jobs\//, "");
    getJSON("/api/backups?name=" + encodeURIComponent(name)).then(function (r) {
      var items = (r && r.items) || [];
      closeModal();
      var ov = document.createElement("div");
      ov.className = "modal-ov"; ov.id = "modal";
      ov.innerHTML = "<div class='modal'><div class='m-title'>🕘 历史备份 · " + esc(shortName) + "</div>" +
        (items.length
          ? "<div class='bk-tip'>每次覆盖保存前的旧版本自动留底（最近 " + items.length + " 份）。恢复前当前内容会先自动备份，恢复后可撤销。</div><div class='bk-list'>" +
            items.map(function (it) {
              return "<div class='bk-row'><span class='bk-ts'>" + esc(it.ts) + "</span>" +
                     "<button class='btn small' data-bk=\"" + esc(it.file) + "\">恢复此版本</button></div>";
            }).join("") + "</div>"
          : "<div class='bk-empty'>还没有备份。这份文档每次「覆盖保存」前的旧版本会自动留底（每份文档保留最近 10 份）。</div>") +
        "<div class='m-row'><button class='btn' data-m='no'>关闭</button></div></div>";
      document.body.appendChild(ov);
      ov.addEventListener("click", function (e) {
        if (e.target === ov || (e.target.getAttribute && e.target.getAttribute("data-m") === "no")) { ov.remove(); return; }
        var btn = e.target.closest && e.target.closest("[data-bk]");
        if (!btn) return;
        var file = btn.getAttribute("data-bk");
        var prevDoc = state.name === name ? JSON.parse(JSON.stringify(state.doc)) : null; // 撤销快照
        askConfirm("恢复到 " + file.slice(0, 15) + "？", "将把「" + shortName + "」覆盖为此备份版本；当前内容会先自动留底，恢复后可撤销。", function () {
          postJSON("/api/restore", { name: name, file: file }).then(function (rr) {
            if (!rr.ok) { toast("恢复失败：" + (rr.error || "")); return; }
            ov.remove();
            var after = state.name === name ? switchDoc(name) : Promise.resolve(); // 正在看这份文档：就地重载
            return Promise.resolve(after).then(function () {
              refreshRailMeta();
              toast("已恢复到 " + file.slice(0, 15), 8000, prevDoc ? { label: "撤销", fn: function () {
                postJSON("/api/save", { name: name, doc: prevDoc }).then(function () {
                  if (state.name === name) return switchDoc(name);
                }).then(function () { refreshRailMeta(); toast("已撤销恢复"); });
              } } : null);
            });
          }).catch(function (e2) { toast("恢复失败：" + e2.message); });
        });
      });
    }).catch(function () { toast("备份列表读取失败"); });
  }
  document.getElementById("rail").addEventListener("click", function (e) {
    var b = e.target.closest("[data-nav]");
    if (!b || b.disabled) return;
    var nav = b.getAttribute("data-nav");
    if (nav === "doc") switchDoc(b.getAttribute("data-doc"));
    else if (nav === "rendoc") renameFlow(b.getAttribute("data-doc"));
    else if (nav === "bkdoc") openBackups(b.getAttribute("data-doc"));
    else if (nav === "deldoc") {
      var dn = b.getAttribute("data-doc");
      askConfirm("删除岗位副本「" + dn.replace(/^jobs\//, "") + "」？", "将删除该副本及其已导出的 PDF，主简历不受影响；界面内不可恢复（自动留底文件仍保留在 data/.backup/ 下，特殊情况可人工找回）。建议导出留档后再删。", function () { deleteJob(dn); });
    }
    else if (nav === "newjob") newJobFlow();
    else if (nav === "ai") toggleAIPanel();
    else if (nav === "save") saveNow();
    else if (nav === "undo") undo();
    else if (nav === "redo") redo();
    else if (nav === "stats") showStats();
    else if (nav === "export") exportNow(b);
    else if (nav === "help") showOnboard(true);
    else if (nav === "pin") {
      var rail = document.getElementById("rail");
      var on = !rail.classList.contains("pinned");
      rail.classList.toggle("pinned", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.title = on ? "取消钉住（恢复悬停展开）" : "钉住导航（保持展开）";
      try { localStorage.setItem("vui-pinned", on ? "1" : "0"); } catch (err) {}
    }
  });
  document.getElementById("rail-search").addEventListener("input", function () {
    railFilter = this.value.trim();
    renderRail();
  });
  document.getElementById("hidden-chip").addEventListener("click", function () { // 复查隐藏内容：一键进取舍并跳到第一个隐藏行
    triageStart();
    var firstHidden = -1;
    triageIds.forEach(function (id, i) {
      if (firstHidden >= 0) return;
      var f0 = findAny(id);
      if (f0 && f0.obj.hidden) firstHidden = i;
    });
    if (firstHidden >= 0) { triageIdx = firstHidden; triagePaint(); }
  });
  document.getElementById("hidden-chip").addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.click(); }
  });
  document.getElementById("rail-search").addEventListener("keydown", function (e) {
    if (e.isComposing || e.keyCode === 229) return; // IME 组合中：Esc 先撤销候选，不清空筛选（R69）
    if (e.key === "Escape") { e.stopPropagation(); this.value = ""; railFilter = ""; renderRail(); this.blur(); }
  });
  document.getElementById("density-seg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-density]");
    if (!b || !state.doc) return;
    state.doc.meta["密度"] = b.getAttribute("data-density");
    $$("#density-seg button").forEach(function (x) {
      var on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    afterChange(false, true); // 切换类：即时生效 + 按压态即可，不弹 toast（右侧预览实时变化即反馈）
  });
  document.getElementById("zoom-select").addEventListener("change", function () {
    try { localStorage.setItem("vui-zoom", this.value); } catch (e) {} // 缩放档位记忆（R45）
    adjustZoom();
  });
  window.addEventListener("resize", function () { // 适应宽度跟随窗口/分栏变化
    if (document.getElementById("zoom-select").value === "fit") adjustZoom();
  });

  /* 左右分栏拖拽：拖动调占比、双击复位、位置记忆 */
  var split = document.getElementById("splitter"), leftPane = document.getElementById("left");
  var SPLIT_MIN = 380, RIGHT_MIN = 440;
  function applySplit(w, persist) {
    w = Math.max(SPLIT_MIN, Math.min(w, window.innerWidth - RIGHT_MIN));
    leftPane.style.width = w + "px";
    leftPane.style.minWidth = "0";
    if (persist) { try { localStorage.setItem("vui-split", String(w)); } catch (e) {} }
    adjustZoom();
  }
  if (split) {
    var dragX = 0, dragW = 0, dragging = false;
    split.addEventListener("pointerdown", function (e) {
      dragging = true; dragX = e.clientX; dragW = leftPane.getBoundingClientRect().width;
      split.setPointerCapture(e.pointerId);
      document.body.classList.add("splitting");
      e.preventDefault();
    });
    split.addEventListener("pointermove", function (e) {
      if (dragging) applySplit(dragW + e.clientX - dragX, false);
    });
    split.addEventListener("pointerup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("splitting");
      applySplit(leftPane.getBoundingClientRect().width, true);
    });
    split.addEventListener("dblclick", function () { // 双击恢复默认 46%
      leftPane.style.width = ""; leftPane.style.minWidth = "";
      try { localStorage.removeItem("vui-split"); } catch (e) {}
      adjustZoom();
    });
    try {
      var sw = parseInt(localStorage.getItem("vui-split") || "0", 10);
      if (sw) applySplit(sw, false); // 恢复上次分栏
    } catch (e) {}
    window.addEventListener("resize", function () {
      if (leftPane.style.width) applySplit(leftPane.getBoundingClientRect().width, false);
    });
  }

  /* 保存状态文字可点击 = 立即保存（失败后的快捷重试入口） */
  document.getElementById("save-state").addEventListener("click", saveNow);

  /* 侧栏收起过渡期不吞点击 */
  var railEl = document.getElementById("rail"), railLeaveTO = null;
  railEl.addEventListener("mouseleave", function () {
    railEl.classList.add("rail-leaving");
    clearTimeout(railLeaveTO);
    railLeaveTO = setTimeout(function () { railEl.classList.remove("rail-leaving"); }, 380); // 覆盖 .15s 宽限 + .22s 收起动画
  });
  /* 图钉状态恢复 */
  try {
    if (localStorage.getItem("vui-pinned") === "1") {
      railEl.classList.add("pinned");
      var pb = railEl.querySelector("[data-nav='pin']");
      if (pb) { pb.setAttribute("aria-pressed", "true"); pb.title = "取消钉住（恢复悬停展开）"; }
    }
  } catch (e) {}

  /* 照片上传：本地图片 -> data/ -> 填入照片字段 */
  document.getElementById("photo-file").addEventListener("change", function () {
    var f = this.files && this.files[0];
    this.value = ""; // 允许再次选择同一文件
    if (!f) return;
    var m = /\.(jpe?g|png|webp|gif)$/i.exec(f.name);
    if (!m) { toast("仅支持 jpg / png / webp / gif 图片"); return; }
    if (f.size > 5 * 1024 * 1024) { toast("图片请小于 5MB"); return; }
    setSaveState("⇪ 上传照片…", "warn");
    fetch("/api/upload-photo?ext=" + encodeURIComponent("." + m[1].toLowerCase()), { method: "POST", body: f })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || "上传失败");
        state.doc.meta["照片"] = r.name;
        renderCards();
        afterChange(false);
        toast("照片已存入 data/" + r.name);
      })
      .catch(function (e) { setSaveState("就绪"); toast("照片上传失败：" + e.message); });
  });

  /* 加粗按压态跟踪：光标/选区在 ** 内时点亮该行 B 按钮 */
  document.addEventListener("selectionchange", syncBoldState);

/* ---------- 剪贴板粘贴图片：直接上传为简历照片（与「📂 选择」共用上传端点与照片落位） ---------- */
document.addEventListener("paste", function (e) {
  if (!state.doc) return;
  var items = (e.clipboardData || {}).items;
  if (!items) return;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
      var f = it.getAsFile();
      if (!f) continue;
      var ext = (it.type.split("/")[1] || "png").toLowerCase();
      if (ext === "jpeg") ext = "jpg";
      e.preventDefault();
      uploadPhotoBlob(f, "." + ext);
      return;
    }
  }
});
function uploadPhotoBlob(blob, ext) {
  fetch("/api/upload-photo?ext=" + encodeURIComponent(ext), { method: "POST", body: blob })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r.ok) { toast("照片上传失败：" + (r.error || "未知错误")); return; }
      var prev = state.doc.meta["照片"] || "";
      state.doc.meta["照片"] = r.name;
      renderCards();
      afterChange(false, true);
      toast("已导入剪贴板照片 " + r.name, 8000, { label: "撤销", fn: function () {
        state.doc.meta["照片"] = prev; renderCards(); afterChange(false, true);
      } });
    })
    .catch(function () { toast("照片上传失败：本地服务可能没在运行"); });
}

  /* 全局快捷键：Ctrl+S 保存 / Ctrl+Z·Y 撤销重做 / Ctrl+E 导出 / Ctrl+B 加粗切换 / Ctrl+F 文档内查找 / Ctrl+J AI 助手 / T 取舍模式 / ? 引导 / Esc 关弹层 */
  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (k === "escape") {
      if (document.getElementById("modal")) { closeModal(); return; } // Esc 只关最顶层：先弹窗，再查找条，再操作菜单，再取舍模式，最后 AI 面板
      if (findOpen()) { closeFind(); return; }
      if (menuEl) { closeMenu(); return; }
      if (triageIdx >= 0) { triageExit(); triageExitGuide(); return; }
      toggleAIPanel(false);
      return;
    }
    var typing = e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT");
    if (!typing && !document.getElementById("modal") && e.altKey && (k === "arrowdown" || k === "arrowup")) {
      e.preventDefault(); cycleDoc(k === "arrowdown" ? 1 : -1); return; // Alt+↑/↓：循环切换文档
    }
    if (!typing && !document.getElementById("modal") && triageIdx >= 0) { // 取舍模式键位（输入框聚焦时让位给正常打字）
      if (k === "j" || k === "arrowdown") { e.preventDefault(); triageMove(1); return; }
      if (k === "k" || k === "arrowup") { e.preventDefault(); triageMove(-1); return; }
      if (k === "h") { e.preventDefault(); triageToggle(); return; }
      if (k === "t") { e.preventDefault(); triageExit(); triageExitGuide(); return; }
    }
    if (!typing && !document.getElementById("modal") && !menuEl && k === "t") { e.preventDefault(); triageStart(); return; }
    if (!typing && !document.getElementById("modal") && k === "/") { // /：聚焦文档筛选（:focus-within 自动展开侧栏）
      e.preventDefault();
      var si = document.getElementById("rail-search");
      si.focus(); si.select();
      return;
    }
    if (!typing && !document.getElementById("modal") && /^[1-9]$/.test(k) &&
        !document.getElementById("ai-panel").classList.contains("ai-closed")) { // AI 面板开着：1-9 快速应用对应建议
      var aiBox = document.getElementById("ai-cards");
      if (aiBox.__items && aiBox.__items[+k - 1]) { e.preventDefault(); aiApply(+k - 1); return; }
    }
    if (k === "?" && e.target && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
      e.preventDefault(); showOnboard(true); return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (k === "s") { e.preventDefault(); saveNow(); }
    else if (k === "e") { e.preventDefault(); exportNow(null); }
    else if (k === "p") { e.preventDefault(); exportNow(null); } // Ctrl+P 劫持为标准导出（R72）：浏览器默认会把工作台界面整页打印出去，而不是简历
    else if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === "j") { e.preventDefault(); toggleAIPanel(); }
    else if (k === "f" && !document.getElementById("modal")) { e.preventDefault(); openFind(); } // 文档内查找（弹窗开着不穿透开查找条，Esc 层序以弹窗为顶）
    else if (k === "b" && e.target && e.target.tagName === "TEXTAREA" && e.target.getAttribute("data-k") === "bullet") { e.preventDefault(); toggleBold(e.target); } // Ctrl+B 只在成果行生效（R55）：JD 框等其余 textarea 不被偷偷插 **
  });

  /* AI 抽屉：三步闭环（贴 JD → 发起即复制 → agent 运行后建议自动出现）+ 全部应用（开关走侧栏/Ctrl+J） */
  document.getElementById("ai-close").addEventListener("click", function () { toggleAIPanel(false); });
  document.getElementById("ai-jd").addEventListener("input", function () {
    aiJdFor = state.name;
    updateAISteps();
    updateJdMarks();
    if (!state.doc) return;
    var v = this.value;
    if (!state.doc.job) state.doc.job = {};
    if (state.doc.job.jdText !== v) { // JD 贴上即随文档自动保存（R50）：没点「发起」就切档/关页也不丢
      state.doc.job.jdText = v;
      scheduleSave();
    }
  });
  document.getElementById("ai-request").addEventListener("click", function () {
    var btn = this;
    if (aiWaiting) { // 等待中再点 = 取消等待；提示词已在缓存，仍可点「复制提示词」手动复制
      endAIWait("发起 AI 优化");
      toast("已取消等待");
      return;
    }
    if (aiReqBusy) return; // 上一次请求还在写入，防连点
    var jd = document.getElementById("ai-jd").value.trim();
    if (!jd) { toast("请先粘贴岗位 JD 原文"); return; }
    var reqName = state.name; // 捕获归属：响应回来时若已切文档则作废
    aiReqBusy = true;
    btn.disabled = true; btn.classList.remove("waiting"); btn.textContent = "⏳ 写入请求…";
    postJSON("/api/ai-request", { name: reqName, jd: jd }).then(function (r) {
      aiReqBusy = false;
      if (state.name !== reqName) { endAIWait("发起 AI 优化"); return; } // 请求期间切了文档：结果不留尾巴
      if (!r.ok) { endAIWait("发起 AI 优化"); toast("写入失败：" + (r.error || "未知错误")); return; }
      if (!state.doc.job) state.doc.job = {};
      state.doc.job.jdText = jd; // JD 随文档落盘，刷新/切档不丢、不串
      aiJdFor = state.name;
      scheduleSave();
      aiPromptCache = r.agentPrompt || ""; // 提示词入缓存：复制按钮解锁，随时可再复制
      document.getElementById("ai-copy").disabled = false;
      aiSig = null; // 让轮询能识别到"新文件/更新"
      setAIWaiting(true); // 按钮秒表 + 120s 超时兜底
      loadSuggestions(); // 服务端已作废旧建议：立即刷新，不等下一次轮询
      if (!aiPromptCache) { toast("请求已写入 data/ai-request.json，但提示词为空——请重新发起", 8000); return; }
      copyText(aiPromptCache).then(function () { // 发起即自动复制（第②步零操作）
        toast("请求已写入，提示词已自动复制 ✓\n到你的 AI agent 粘贴运行即可");
      }).catch(function () {
        toast("请求已写入 data/ai-request.json。自动复制失败，可点「复制提示词」重试", 8000);
      });
    }).catch(function (e) {
      aiReqBusy = false;
      endAIWait("发起 AI 优化");
      toast("写入失败：" + (e && e.message ? e.message : "") + "\n本地服务可能没在运行——双击「启动简历工作台.bat」后再试", 8000);
    });
  });
  document.getElementById("ai-copy").addEventListener("click", function () {
    if (!aiPromptCache) return; // 无缓存时按钮本就禁用，双保险
    copyText(aiPromptCache).then(function () {
      toast("提示词已复制，粘贴到你的 AI agent 即可");
    }).catch(function () {
      toast("复制失败，请手动复制提示词全文：\n" + aiPromptCache, 10000);
    });
  });
  document.getElementById("ai-apply-all").addEventListener("click", function () {
    var box = document.getElementById("ai-cards");
    var items = box.__items || [];
    var batch = [];
    items.forEach(function (it, i) {
      if (!it || it.type === "note" || state.appliedAI[i]) return;
      var f = findAny(it.target || "");
      if (!f) return; // 目标缺失的跳过，不阻塞整批
      if (it.type === "rewrite" && f.kind !== "bullet") return; // 改写打在章节/条目上是打空炮，同样跳过（R44）
      applyItem(it);
      state.appliedAI[i] = true;
      batch.push(i);
    });
    if (!batch.length) { toast("没有可应用的建议（可能均已应用，或目标条目已不在当前文档中）"); return; }
    afterChange(true, true); // 整批只算一个撤销步
    locateCard(items[batch[0]].target); // 定位到第一条
    toast("已应用 " + batch.length + " 条建议", 8000, { label: "撤销", fn: function () {
      batch.forEach(function (i) { delete state.appliedAI[i]; });
      undo(); loadSuggestions();
    } });
    loadSuggestions();
  });
  document.getElementById("ai-refresh").addEventListener("click", loadSuggestions);
}

/* ---------- AI 面板开关与自动轮询 ---------- */
var aiPollTimer = null, aiSig = null, aiWaiting = false, aiWaitTO = null, aiJdFor = null; // aiJdFor=JD 输入框内容归属的文档
var aiHistMode = false; // 历史建议只读回看中（R52）：期间 1-9 不应用、轮询不顶掉回看画面
var aiSeenSig = (function () { try { return localStorage.getItem("vui-ai-seen") || ""; } catch (e) { return ""; } })(); // 已看过的建议签名（跨刷新记忆）
var aiPromptCache = null, aiSecTimer = null, aiReqBusy = false, aiHaveValidSug = false; // 提示词缓存/秒表/请求写入中/当前文档有可用建议
function setAIWaiting(on) { // 等待态：1s 秒表更新按钮文案 + 120s 超时兜底
  aiWaiting = on;
  clearInterval(aiSecTimer); aiSecTimer = null;
  clearTimeout(aiWaitTO); aiWaitTO = null;
  var btn = document.getElementById("ai-request");
  if (!btn) return;
  btn.classList.toggle("waiting", on);
  if (!on) return;
  var t0 = Date.now();
  btn.disabled = false;
  btn.textContent = "⏳ 已等待 0s · 点击取消";
  aiSecTimer = setInterval(function () {
    btn.textContent = "⏳ 已等待 " + Math.round((Date.now() - t0) / 1000) + "s · 点击取消";
  }, 1000);
  aiWaitTO = setTimeout(function () { // 两分钟无果自动解除等待，避免永久卡死
    if (!aiWaiting) return;
    endAIWait("重新生成");
    toast("已等待 120 秒仍未检测到新建议。\n请确认你的 AI agent 是否已运行完成：完成后点 ↻ 读取，或点「重新生成」再发起", 9000);
  }, 120000);
}
function endAIWait(label) { // 解除等待并复位按钮文案；请求写入中则不抢按钮状态
  setAIWaiting(false);
  if (aiReqBusy) return;
  var btn = document.getElementById("ai-request");
  if (btn && label) { btn.disabled = false; btn.textContent = label; }
}
function resetAIRequestState() { // 切文档/重置：等待、秒表、徽标、提示词缓存全部清空，一切干净
  setAIWaiting(false);
  setAIBadge(false); // 徽标归属当前文档：换文档先熄灭，下个轮询周期按新文档重评
  aiPromptCache = null;
  aiHaveValidSug = false;
  var rb = document.getElementById("ai-request");
  if (rb && !aiReqBusy) { rb.disabled = false; rb.textContent = "发起 AI 优化"; }
  var cp = document.getElementById("ai-copy");
  if (cp) cp.disabled = true;
  updateAISteps();
}
function updateAISteps() { // 三步引导：完成的步骤打勾（切文档/取消后同步回退）
  var steps = $$("#ai-steps .ai-step");
  if (!steps.length) return;
  var jd = document.getElementById("ai-jd");
  steps[0].classList.toggle("done", !!(jd && jd.value.trim()));
  steps[1].classList.toggle("done", aiWaiting || !!aiPromptCache);
  steps[2].classList.toggle("done", aiHaveValidSug);
}
function restoreAIRequest() { // 发起后切走再回来（R51）：从服务端恢复在途请求——提示词可再复制、未完成则回到等待态，不必重发起
  var name = state.name;
  getJSON("/api/ai-request").then(function (r) {
    if (state.name !== name) return; // 请求期间又切了档
    if (!r || !r.exists || r.for !== state.name || !r.agentPrompt) return;
    aiPromptCache = r.agentPrompt;
    var cp = document.getElementById("ai-copy");
    if (cp) cp.disabled = false;
    if (!aiHaveValidSug && !aiWaiting && r.time) { // 有请求没建议：视为在途，恢复等待态（只认 10 分钟内的请求）
      var t0 = new Date(String(r.time).replace(" ", "T")).getTime();
      if (isFinite(t0) && Date.now() - t0 < 10 * 60000) setAIWaiting(true);
    }
    updateAISteps();
  }).catch(function () {});
}

function toggleAIPanel(open) {
  var p = document.getElementById("ai-panel");
  var willOpen = open == null ? p.classList.contains("ai-closed") : open;
  p.classList.toggle("ai-closed", !willOpen);
  if (willOpen) {
    var box = document.getElementById("ai-jd");
    if (aiJdFor !== state.name) { // JD 按文档归属：换文档即换内容，不串
      box.value = (state.doc && state.doc.job && state.doc.job.jdText) || "";
      aiJdFor = state.name;
    }
    loadSuggestions();
    loadAIHistory(); // 历史建议归档列表：重新发起前的上一轮不丢，可只读回看
    restoreAIRequest();
    aiHistMode = false; // 打开面板回到当前建议视图（R52）
    updateAISteps();
    updateJdMarks(); // JD 随文档恢复后立即刷新命中徽标
    setAIBadge(false); // 打开即视为查看：徽标熄灭（loadSuggestions 会记已读）
  }
}

function loadAIHistory() { // 历史建议：服务端在每次发起时归档旧建议（保留最近 20 份）
  getJSON("/api/ai-history").then(function (r) {
    var box = document.getElementById("ai-history");
    if (!box) return;
    var items = (r && r.items) || [];
    if (!items.length) { box.innerHTML = ""; return; }
    box.innerHTML = "<div class='ai-hist-title'>历史建议</div>" + items.map(function (h) {
      return "<button class='ai-hist-row' data-hist='" + esc(h.file) + "'>" +
        esc(h.file.replace(/\.json$/, "")) + " · " + esc((h.for || "").replace(/^jobs\//, "")) +
        " · " + h.count + " 条</button>";
    }).join("");
    $("[data-hist]", box).forEach(function (b) {
      b.addEventListener("click", function () {
        getJSON("/data/ai-history/" + encodeURIComponent(b.getAttribute("data-hist"))).then(function (d) {
          var arr = Array.isArray(d.items) ? d.items : [];
          var toolbar = document.getElementById("ai-toolbar");
          if (toolbar) toolbar.classList.add("hidden");
          var box2 = document.getElementById("ai-cards");
          box2.__items = null; // 回看态清掉当前建议缓存：1-9 与应用按钮无处生效（R52）
          aiHistMode = true;
          box2.innerHTML = "<div class='ai-hist-banner'>只读回看：" + esc(d.for || "") +
            "（历史建议不随当前文档状态应用）<button class='btn small' id='ai-hist-back'>↩ 返回当前建议</button></div>" +
            arr.map(function (it) {
              var tag = it.type === "rewrite" ? "改写" : it.type === "hide" ? "建议隐藏" : it.type === "show" ? "建议恢复" : "说明";
              return "<div class='ai-card'><span class='tag'>" + tag + "</span> " +
                (it.target ? "对象：" + esc(String(it.target)) + "<br>" : "") +
                "<div>" + esc(it.type === "rewrite" ? (it.text || "") : (it.reason || it.text || "")).replace(/\n/g, "<br>") + "</div></div>";
            }).join("");
          var back = document.getElementById("ai-hist-back");
          if (back) back.addEventListener("click", function () { aiHistMode = false; loadSuggestions(); });
        }).catch(function () { toast("历史建议读取失败"); });
      });
    });
  }).catch(function () {}); // 历史列表失败不打扰：主流程的建议渲染有自己的报错
}
function setAIBadge(on) { // AI 就绪徽标：当前文档有未查看的建议时，侧栏 🤖 亮圆点（面板关着也有感知）
  var b = document.querySelector("[data-nav='ai']");
  if (!b) return;
  var d = b.querySelector(".ai-ready");
  if (on && !d) { d = document.createElement("span"); d.className = "ai-ready"; d.title = "有新建议"; b.appendChild(d); }
  else if (!on && d) d.remove();
}
function markAISeen() { // 建议已在面板里渲染给用户看过：记入 localStorage，重开页面不再重复提醒
  if (!aiSig) return;
  aiSeenSig = aiSig;
  try { localStorage.setItem("vui-ai-seen", aiSig); } catch (e) {}
}
function startAIPoll() { // 全局常驻轮询（本地请求零成本）：面板开着就地渲染，关着亮徽标+toast——切走跑 agent 回来零点击感知
  if (aiPollTimer) return;
  aiPollTimer = setInterval(function () {
    getJSON("/api/ai-suggestion").then(function (r) {
      var items = (r && r.items) || [];
      var arr = Array.isArray(items) ? items : [];
      var sig = arr.length + ":" + arr.map(function (it) {
        return it.type + "|" + (it.target || "") + "|" + (it.text || it.reason || "");
      }).join(";");
      if (sig === aiSig) return;
      var open = !document.getElementById("ai-panel").classList.contains("ai-closed");
      if (open) { if (!aiHistMode) loadSuggestions(); return; } // 就地渲染（历史回看中不顶掉画面，R52）
      aiSig = sig; // 面板关着：只记账，打开面板时 loadSuggestions 会重新渲染
      if (arr.length && r && r.for === state.name && sig !== aiSeenSig) {
        setAIBadge(true);
        toast("AI 建议已就绪 ✓", 8000, { label: "查看", fn: function () { toggleAIPanel(true); } }); // 通知→行动 闭环（R71）：一键开面板，不必再找侧栏 🤖
      } else if (!arr.length || sig === aiSeenSig) setAIBadge(false);
    }).catch(function () {}); // 文件尚不存在：静默等待下一次轮询
  }, 2500);
}

/* ---------- AI 建议 ---------- */
function applyItem(it) { // 把一条建议写入文档模型（调用方负责 afterChange/撤销/重渲染）
  var found = findAny(it.target || "");
  if (!found) return false;
  if (it.type === "rewrite") found.obj.text = it.text;
  else if (it.type === "hide") found.obj.hidden = true;
  else if (it.type === "show") found.obj.hidden = false;
  return true;
}
function charDiff(a, b) { // 字符级轻量 diff：公共前后缀对齐，中段即实际改动（零依赖，条目长度足够）
  var s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  var e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { pre: a.slice(0, s), midOld: a.slice(s, a.length - e), midNew: b.slice(s, b.length - e), post: a.slice(a.length - e) };
}

function aiApply(i2) { // 应用第 i2 条建议：按钮点击与键盘 1-9 共用
  if (aiHistMode) return; // 历史回看是只读态（R52）：面板上展示的不是当前建议，数字键不得暗中生效
  var box = document.getElementById("ai-cards");
  var it = box.__items && box.__items[i2];
  if (!it || it.type === "note" || state.appliedAI[i2]) return;
  var found = findAny(it.target || "");
  if (!found) { // 目标可能已被删改：如实告知，不假成功
    toast("第 " + (i2 + 1) + " 条建议的目标条目已不在当前文档中（文档可能已改动）");
    return;
  }
  if (it.type === "rewrite" && found.kind !== "bullet") { // rewrite 打在章节/条目上只会写入死属性（R44）
    toast("第 " + (i2 + 1) + " 条建议的改写目标不是成果行，已跳过（rewrite 只对成果生效）");
    return;
  }
  applyItem(it);
  state.appliedAI[i2] = true;
  afterChange(true, true);
  locateCard(it.target);
  toast("已应用 AI 建议", 8000, { label: "撤销", fn: function () {
    delete state.appliedAI[i2]; undo(); loadSuggestions();
  } });
  loadSuggestions();
}
function loadSuggestions() {
  getJSON("/api/ai-suggestion").then(function (r) {
    var box = document.getElementById("ai-cards");
    var toolbar = document.getElementById("ai-toolbar");
    var count = document.getElementById("ai-count");
    var panel = document.getElementById("ai-panel"); // 真正的滚动容器是 #ai-panel（overflow:auto），#ai-cards 自己从不滚（R70 教训）
    var keepScroll = panel ? panel.scrollTop : 0; // 重渲染前记住阅读位置（R70）
    var raw = (r && r.items) || [];
    var arr = Array.isArray(raw) ? raw : [];
    aiSig = arr.length + ":" + arr.map(function (it) {
      return it.type + "|" + (it.target || "") + "|" + (it.text || it.reason || "");
    }).join(";");
    if (!Array.isArray(raw)) { // items 不是数组：协议被破坏，如实告知
      aiHaveValidSug = false; box.__items = null;
      endAIWait("发起 AI 优化");
      toolbar.classList.add("hidden");
      box.innerHTML = "<div class='ai-error'>建议文件格式无法解析（items 不是数组）。请重新点「发起 AI 优化」生成新请求，再让 agent 重写 data/ai-suggestion.json</div>";
      updateAISteps();
      return;
    }
    var wrong = r && r.for ? r.for !== state.name : arr.length > 0; // for 缺失且有内容的旧文件同样视为错档
    if (wrong) { // 属于其他文档或旧格式：不渲染建议、无应用按钮
      aiHaveValidSug = false; box.__items = null;
      endAIWait("发起 AI 优化");
      toolbar.classList.add("hidden");
      box.innerHTML = "<div class='ai-wrongdoc'>这份建议属于其他文档或旧格式，不是当前文档。点「发起 AI 优化」即可为当前文档重新生成</div>";
      updateAISteps();
      return;
    }
    if (!arr.length) { // 无建议：空状态对接新三步
      aiHaveValidSug = false; box.__items = null;
      toolbar.classList.add("hidden");
      box.innerHTML = "<div class='ai-empty'>还没有建议。按上面 3 步走：贴 JD → 点「发起 AI 优化」→ 到你的 AI agent 粘贴运行；<br>建议写好后会自动出现在这里（也可点 ↻ 手动刷新），按 1-9 数字键可快速应用对应建议</div>";
      updateAISteps();
      return;
    }
    /* 有建议：解除等待态，渲染卡片 */
    aiHaveValidSug = true;
    endAIWait("发起 AI 优化");
    markAISeen(); // 渲染给用户看了：记已读，徽标/提醒不再重复
    box.__items = arr;
    syncAppliedAI(); // 渲染前按内容事实重算「已应用」（R56）：面板关着期间的手动编辑不再留陈旧徽标
    var applicable = aiApplicable(arr);
    toolbar.classList.toggle("hidden", !applicable);
    if (count) count.textContent = arr.length + " 条建议";
    box.innerHTML = arr.map(function (it, i) {
      var applied = state.appliedAI[i];
      var tag = it.type === "rewrite" ? "改写" : it.type === "hide" ? "建议隐藏" : it.type === "show" ? "建议恢复" : "说明";
      var target = findAny(it.target || "");
      var body = esc(it.type === "rewrite" ? (it.text || "") : (it.reason || it.text || ""));
      var objText = target ? (target.obj.text || target.obj.left || target.obj["标题"] || "") : "";
      var diffHtml = "";
      if (it.type === "rewrite" && target && typeof target.obj.text === "string") {
        var d = charDiff(target.obj.text, it.text || ""); // 应用前先看差异：原/改两行，改动中段高亮
        if (d.midOld || d.midNew) {
          diffHtml = "<div class='ai-diff'>" +
            "<div class='d-old'>原 " + esc(d.pre) + (d.midOld ? "<del>" + esc(d.midOld) + "</del>" : "") + esc(d.post) + "</div>" +
            "<div class='d-new'>改 " + esc(d.pre) + (d.midNew ? "<ins>" + esc(d.midNew) + "</ins>" : "") + esc(d.post) + "</div>" +
            "</div>";
        }
      }
      return "<div class='ai-card" + (applied ? " applied" : "") + "'>" +
        "<span class='tag'>" + tag + "</span><span class='ai-num'>" + (i + 1) + "</span> " +
        (target ? "对象：" + esc(objText.slice(0, 40)) + "<br>" : "") +
        diffHtml +
        (it.type !== "rewrite" ? "<div>" + body.replace(/\n/g, "<br>") + "</div>" : "") +
        (it.type !== "note" && !applied ? "<button class='btn small apply-btn' data-ai='" + i + "'>✓ 应用</button>" : applied ? "<span class='applied-note'>（已应用）</span>" : "") +
        "</div>";
    }).join("");
    if (panel) panel.scrollTop = Math.min(keepScroll, Math.max(0, panel.scrollHeight - panel.clientHeight)); // 恢复阅读位置（R70）：轮询/刷新重建卡片不打断阅读；内容不变时为幂等 no-op
    $("[data-ai]", box).forEach(function (b) {
      b.addEventListener("click", function () {
        aiApply(+b.getAttribute("data-ai"));
      });
    });
    updateAISteps();
  }).catch(function () { // 服务不可达：诚实文案，不假装没有建议
    aiHaveValidSug = false;
    var toolbar = document.getElementById("ai-toolbar");
    if (toolbar) toolbar.classList.add("hidden");
    document.getElementById("ai-cards").innerHTML =
      "<div class='ai-error'>读取建议失败：本地服务可能没在运行——双击「启动简历工作台.bat」后再试</div>";
  });
}

/* ---------- 缩放 ---------- */
function adjustZoom() {
  var sel = document.getElementById("zoom-select");
  var z = sel.value === "fit" ? 0 : (parseFloat(sel.value) || 0.8);
  var frame = document.getElementById("preview");
  var box = document.getElementById("zoom-box");
  if (!z) { // 适应宽度（R45）：按预览区可用宽实时计算（clientWidth 含左右 14px 内边距），下限防碎片、上限防失真
    var avail = document.getElementById("preview-scroll").clientWidth - 28;
    z = Math.max(0.35, Math.min(1.6, avail / 794));
  }
  var h = frame.offsetHeight || 1123;
  frame.style.transform = "scale(" + z + ")";
  box.style.width = (794 * z) + "px";
  box.style.height = (h * z) + "px";
}

/* ---------- 启动 ---------- */
window.addEventListener("DOMContentLoaded", function () {
  state.folded = loadFoldStore(); // 折叠状态按文档记忆
  bindEvents();
  modalWatch.observe(document.body, { childList: true }); // 弹窗焦点归还观察器（R47）
  try { // 恢复上次缩放档位（R45）
    var zv = localStorage.getItem("vui-zoom");
    var zs = document.getElementById("zoom-select");
    if (zv && zs && zs.querySelector("option[value='" + zv + "']")) zs.value = zv;
  } catch (e) {}
  adjustZoom();
  loadList();
  startAIPoll(); // 全局常驻轮询：建议文件一变即有感知（面板开着渲染，关着亮徽标）
  showOnboard(false); // 首访三步引导（localStorage 记忆）
});
