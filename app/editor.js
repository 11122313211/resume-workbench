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
  if (dot) dot.className = "rail-dot" + (cls ? " " + cls : "");
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
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap());
  applySnap(undoStack.pop());
  setSaveState("已撤销 ✓", "ok");
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  applySnap(redoStack.pop());
  setSaveState("已重做 ✓", "ok");
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
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal onboard'><div class='m-title'>👋 三步上手简历工作台</div>" +
    "<ol class='ob-steps'>" +
    "<li><b>维护主简历</b>：左侧卡片增删改、拖拽排序，右侧 A4 实时预览，完整版可以是 2 页</li>" +
    "<li><b>投递取舍</b>：AI 助手里贴 JD、点「发起 AI 优化」（提示词自动复制）→ 到你的 AI agent 粘贴运行 → 回来建议自动出现，一键或逐条采纳</li>" +
    "<li><b>一键导出</b>：左侧导航「导出 PDF」得到与预览 1:1 的 A4 打印版</li>" +
    "</ol><p class='ob-tip'>提示：Ctrl+S 保存 · Ctrl+E 导出 · Ctrl+J AI 助手 · Ctrl+Z / Ctrl+Shift+Z 撤销重做 · Ctrl+B 加粗（再按取消）· 点右侧预览可定位左侧卡片 · ? 重看本引导</p>" +
    "<div class='m-row'><button class='btn primary' data-m='ok'>开始使用</button></div></div>";
  document.body.appendChild(ov);
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
    renderRail();
    if (!state.name && state.list.length) { // 恢复上次编辑的文档（localStorage 记忆）
      var last = null;
      try { last = localStorage.getItem("vui-last"); } catch (e) {}
      switchDoc(state.list.indexOf(last) !== -1 ? last : state.list[0]);
    }
  }).catch(function (e) { // 启动时服务不可达：给明确指引（后续操作的失败由各自 catch 提示）
    if (!state.list.length) toast("无法连接本地服务：请双击「启动简历工作台.bat」启动后再刷新页面", 8000);
  });
}
function switchDoc(name) {
  flushSave(); // 先把上一个文档挂起的编辑落盘，避免 900ms 窗口内切档串写
  state.name = name;
  try { localStorage.setItem("vui-last", name); } catch (e) {}
  return getJSON("/api/doc?name=" + encodeURIComponent(name)).then(function (doc) {
    state.doc = doc;
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
    state.appliedAI = {}; // AI 已应用标记不跨文档
    resetAIRequestState();
    if (!document.getElementById("ai-panel").classList.contains("ai-closed")) { aiJdFor = null; toggleAIPanel(true); } // 面板开着：JD 与建议跟随新文档
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
var SVG_EYE = svgI("<path d='M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'/><circle cx='12' cy='12' r='3'/>");
var SVG_FOLDER = svgI("<path d='M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'/>");
var SVG_PIN = svgI("<path d='M12 16v6'/><path d='M8.5 3h7l-1 7 3.5 3.5H6L9.5 10z'/>");
function renderRail() { // 文档列表平铺在侧栏「文档」组，当前文档带指示条；岗位副本悬停出现删除
  var h = "";
  (state.list || []).forEach(function (n) {
    var job = n !== "主简历", active = n === state.name;
    h += "<div class='rail-row" + (active ? " active" : "") + "'>" +
         "<button class='rail-item" + (active ? " active" : "") + "' data-nav='doc' data-doc=\"" + esc(n) +
         "\" title=\"" + esc(n) + "\"" + (active ? " aria-current='true'" : "") + ">" +
         "<span class='ric'>" + (job ? SVG_TARGET : SVG_DOC) + "</span>" +
         "<span class='con'>" + esc(job ? n.replace(/^jobs\//, "") : "主简历") + "</span></button>" +
         (job ? "<button class='rail-del' data-nav='deldoc' data-doc=\"" + esc(n) +
               "\" title='删除此岗位副本（主简历不受影响）' aria-label='删除 " + esc(n) + "'>" + SVG_X + "</button>" : "") +
         "</div>";
  });
  document.getElementById("rail-docs").innerHTML = h;
}

/* ---------- 左侧卡片渲染 ---------- */
function ctlBtns(kind, id) { // 操作集合按钮：常驻低饱和 ⋯，点击弹出 上移/下移/删除 菜单（替代悬停浮现三连钮的死占位）
  return "<button class='ctl-menu' data-menu data-k='" + kind + "' data-id='" + id +
    "' title='操作：上移 / 下移 / 删除' aria-haspopup='menu' aria-expanded='false'>⋯</button>";
}
function showToggle(kind, id, hidden, job) { // 眼睛切换：显示中=灰描边，隐藏=琥珀实心（隐藏是需要处理的例外），不弹 toast
  var tip = job ? "显示中。点击从本岗位版隐藏（主简历不受影响），再点恢复"
                : "显示中。点击隐藏（预览与导出 PDF 均不显示），再点恢复";
  if (hidden) tip = job ? "已隐藏。点击恢复显示（本岗位版）" : "已隐藏。点击恢复显示";
  return "<button class='show-toggle" + (hidden ? " off" : "") + "' data-act='show' data-k='" + kind +
    "' data-id='" + id + "' title='" + tip + "' aria-pressed='" + (hidden ? "false" : "true") +
    "' aria-label='切换显示/隐藏'>" + SVG_EYE + "</button>";
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
  var n = 0;
  (state.doc.sections || []).forEach(function (s) {
    (s.entries || []).forEach(function (e) {
      (e.bullets || []).forEach(function (b) {
        var len = (b.text || "").replace(/\*\*/g, "").length;
        if (!b.hidden) n += len;
        var el = document.querySelector("[data-bc='" + b.id + "']");
        if (el) el.textContent = len ? len + " 字" : "";
      });
    });
  });
  var chip = document.getElementById("chars");
  if (chip) chip.textContent = "成果字数 " + n;
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
function initNativeDrag() { // 原生 HTML5 DnD 兜底（含边缘自动滚动）
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
function doSave(name, doc) {
  setSaveState("✎ 修改中…", "busy");
  return postJSON("/api/save", { name: name, doc: doc }).then(function (r) {
    setSaveState(r.ok ? "✓ 已保存" : "⚠ 保存失败", r.ok ? "ok" : "warn");
    if (!r.ok) saveFailToast();
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
    if (k === "meta") state.doc.meta[f] = v;
    else if (k === "section") { var s = secById(id); if (s) s[f] = v; }
    else if (k === "entry") { var r = findEntry(id); if (r) r.entry[f] = v; }
    else if (k === "bullet") { var b = findBullet(id); if (b) b.text = v; }
    afterChange(false);
  });

  document.addEventListener("click", function (e) { // 委托在 document：⋯ 菜单项（body 级）与卡片按钮共用同一套 act 链
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act"), k = btn.getAttribute("data-k"), id = btn.getAttribute("data-id");
    if (act === "show") { // 眼睛切换：即时生效 + 按压态，不弹 toast
      var f0 = findAny(id);
      if (f0) {
        f0.obj.hidden = !f0.obj.hidden;
      btn.classList.toggle("off", f0.obj.hidden);
      btn.setAttribute("aria-pressed", f0.obj.hidden ? "false" : "true");
        var host = btn.closest(".card, .bullet-row");
        if (host) host.classList.toggle("item-off", f0.obj.hidden);
        afterChange(false, true);
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
    var m = document.createElement("div");
    m.className = "vui-menu"; m.setAttribute("role", "menu");
    m.innerHTML =
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
    flushSave();
    toast("已保存");
  }
  function exportNow(navBtn) {
    function go() {
      if (navBtn) navBtn.disabled = true;
      setSaveState("⬇ 导出中…", "warn");
      postJSON("/api/save", { name: state.name, doc: state.doc }).then(function () {
        return postJSON("/api/export", { name: state.name });
      }).then(function (r) {
        if (navBtn) navBtn.disabled = false;
        setSaveState("✓ 已保存", "ok");
        if (r.ok) { toast("PDF 已导出：" + r.pdf); window.open(r.pdf, "_blank"); }
        else toast("导出失败：" + (r.error || "未知错误"));
      }).catch(function (e) { if (navBtn) navBtn.disabled = false; setSaveState("就绪"); toast("导出失败：" + e.message); });
    }
    if (state.doc && state.doc.kind === "job" && state.gauge && state.gauge.pages > 1) {
      askConfirm("岗位版超过一页", "当前约 " + state.gauge.pages + " 页，导出会逐级收紧排版硬塞进一页，可能偏密——建议先取舍内容。仍要导出吗？", go);
      return;
    }
    go();
  }
  function createJob(name) { // 真正创建：当前文档先落盘，避免竞态
    flushSave();
    postJSON("/api/newjob", { name: name }).then(function (r) {
      if (!r.ok) { toast("创建失败：" + (r.error || "")); return; }
      state.name = null;
      return loadList().then(function () { return switchDoc(r.name); }).then(function () {
        toast("岗位副本已创建（已复制主简历）");
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
        askConfirm("同名副本已存在", "「" + full + "」已存在。继续将用主简历当前内容覆盖它，旧的裁剪成果无法恢复。", function () { createJob(name); });
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
  document.getElementById("rail").addEventListener("click", function (e) {
    var b = e.target.closest("[data-nav]");
    if (!b || b.disabled) return;
    var nav = b.getAttribute("data-nav");
    if (nav === "doc") switchDoc(b.getAttribute("data-doc"));
    else if (nav === "deldoc") {
      var dn = b.getAttribute("data-doc");
      askConfirm("删除岗位副本「" + dn.replace(/^jobs\//, "") + "」？", "将删除该副本及其已导出的 PDF，主简历不受影响，且不可恢复（建议导出留档后再删）。", function () { deleteJob(dn); });
    }
    else if (nav === "newjob") newJobFlow();
    else if (nav === "ai") toggleAIPanel();
    else if (nav === "save") saveNow();
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
  document.getElementById("zoom-select").addEventListener("change", adjustZoom);

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
    railLeaveTO = setTimeout(function () { railEl.classList.remove("rail-leaving"); }, 320);
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

  /* 全局快捷键：Ctrl+S 保存 / Ctrl+Z·Y 撤销重做 / Ctrl+E 导出 / Ctrl+B 加粗切换 / Ctrl+J AI 助手 / ? 引导 / Esc 关弹层 */
  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (k === "escape") {
      if (document.getElementById("modal")) { closeModal(); return; } // Esc 只关最顶层：先弹窗，再操作菜单，最后 AI 面板
      if (menuEl) { closeMenu(); return; }
      toggleAIPanel(false);
      return;
    }
    if (k === "?" && e.target && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") {
      e.preventDefault(); showOnboard(true); return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (k === "s") { e.preventDefault(); saveNow(); }
    else if (k === "e") { e.preventDefault(); exportNow(null); }
    else if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === "j") { e.preventDefault(); toggleAIPanel(); }
    else if (k === "b" && e.target && e.target.tagName === "TEXTAREA") { e.preventDefault(); toggleBold(e.target); }
  });

  /* AI 抽屉：三步闭环（贴 JD → 发起即复制 → agent 运行后建议自动出现）+ 全部应用（开关走侧栏/Ctrl+J） */
  document.getElementById("ai-close").addEventListener("click", function () { toggleAIPanel(false); });
  document.getElementById("ai-jd").addEventListener("input", function () { aiJdFor = state.name; updateAISteps(); });
  document.getElementById("ai-request").addEventListener("click", function () {
    var btn = this;
    if (aiWaiting) { // 等待中再点 = 取消等待；提示词已在缓存，仍可点「复制提示词」手动复制
      endAIWait("发起 AI 优化");
      stopAIPoll();
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
      if (!document.getElementById("ai-panel").classList.contains("ai-closed")) startAIPoll(); // 面板已关则不开轮询，重开时自动恢复
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
      if (!findAny(it.target || "")) return; // 目标缺失的跳过，不阻塞整批
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
function resetAIRequestState() { // 切文档/重置：等待、秒表、轮询、提示词缓存全部清空，一切干净
  setAIWaiting(false);
  stopAIPoll();
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
    updateAISteps();
    startAIPoll(); // 面板开着就轮询（本地请求零成本），agent 何时写完都能自动出现
  } else stopAIPoll();
}
function stopAIPoll() { clearInterval(aiPollTimer); aiPollTimer = null; }
function startAIPoll() { // 面板开启期间轮询建议文件（本地请求零成本），agent 写好后自动出现
  stopAIPoll();
  aiPollTimer = setInterval(function () {
    getJSON("/api/ai-suggestion").then(function (r) {
      var items = (r && r.items) || [];
      var arr = Array.isArray(items) ? items : [];
      var sig = arr.length + ":" + arr.map(function (it) {
        return it.type + "|" + (it.target || "") + "|" + (it.text || it.reason || "");
      }).join(";");
      if (sig !== aiSig) {
        loadSuggestions();
        if (arr.length && r && r.for === state.name) toast("AI 建议已就绪 ✓");
      }
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
function loadSuggestions() {
  getJSON("/api/ai-suggestion").then(function (r) {
    var box = document.getElementById("ai-cards");
    var toolbar = document.getElementById("ai-toolbar");
    var count = document.getElementById("ai-count");
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
      box.innerHTML = "<div class='ai-empty'>还没有建议。按上面 3 步走：贴 JD → 点「发起 AI 优化」→ 到你的 AI agent 粘贴运行；<br>建议写好后会自动出现在这里（也可点 ↻ 手动刷新）</div>";
      updateAISteps();
      return;
    }
    /* 有建议：解除等待态，渲染卡片 */
    aiHaveValidSug = true;
    endAIWait("发起 AI 优化");
    box.__items = arr;
    var applicable = arr.some(function (it, i) {
      return it && it.type !== "note" && !state.appliedAI[i] && findAny(it.target || "");
    });
    toolbar.classList.toggle("hidden", !applicable);
    if (count) count.textContent = arr.length + " 条建议";
    box.innerHTML = arr.map(function (it, i) {
      var applied = state.appliedAI[i];
      var tag = it.type === "rewrite" ? "改写" : it.type === "hide" ? "建议隐藏" : it.type === "show" ? "建议恢复" : "说明";
      var target = findAny(it.target || "");
      var body = esc(it.type === "rewrite" ? (it.text || "") : (it.reason || it.text || ""));
      return "<div class='ai-card" + (applied ? " applied" : "") + "'>" +
        "<span class='tag'>" + tag + "</span> " +
        (target ? "目标：" + esc((target.obj.left || target.obj["标题"] || target.obj.text || "").slice(0, 24)) + "<br>" : "") +
        "<div>" + body.replace(/\n/g, "<br>") + "</div>" +
        (it.type !== "note" && !applied ? "<button class='btn small apply-btn' data-ai='" + i + "'>✓ 应用</button>" : applied ? "（已应用）" : "") +
        "</div>";
    }).join("");
    $("[data-ai]", box).forEach(function (b) {
      b.addEventListener("click", function () {
        var i2 = +b.getAttribute("data-ai"), it = box.__items[i2];
        var found = findAny(it.target || "");
        if (!found) { // 目标可能已被删改：如实告知，不假成功
          toast("第 " + (i2 + 1) + " 条建议的目标条目已不在当前文档中（文档可能已改动）");
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
  var z = parseFloat(document.getElementById("zoom-select").value) || 0.8;
  var frame = document.getElementById("preview");
  var box = document.getElementById("zoom-box");
  var h = frame.offsetHeight || 1123;
  frame.style.transform = "scale(" + z + ")";
  box.style.width = (794 * z) + "px";
  box.style.height = (h * z) + "px";
}

/* ---------- 启动 ---------- */
window.addEventListener("DOMContentLoaded", function () {
  state.folded = loadFoldStore(); // 折叠状态按文档记忆
  bindEvents();
  loadList();
  showOnboard(false); // 首访三步引导（localStorage 记忆）
});
