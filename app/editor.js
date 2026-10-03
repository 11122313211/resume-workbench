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
function setSaveState(txt, cls) {
  var el = document.getElementById("save-state");
  el.textContent = txt;
  el.className = "save-state" + (cls ? " " + cls : "");
}

/* ---------- 撤销 / 重做（Memento 全量快照，600ms 合帧）---------- */
function snap() { return JSON.stringify(state.doc); }
function beforeChange() { // afterChange 开头调用：把"上一稳定态"压入撤销栈
  if (baseline === null) { baseline = snap(); return; }
  var top = undoStack.length ? undoStack[undoStack.length - 1] : null;
  if (baseline !== top) {
    var now = Date.now();
    if (now - lastPush > 600) { // 合帧窗口内的连续输入只保留爆发前的状态
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
function closeModal() { var m = document.getElementById("modal"); if (m) m.remove(); }
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
function showOnboard(force) {
  if (!force && (localStorage.getItem("vui-onboarded") === "1" || /[?&]nointro=1/.test(location.search))) return;
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov"; ov.id = "modal";
  ov.innerHTML = "<div class='modal onboard'><div class='m-title'>👋 三步上手简历工作台</div>" +
    "<ol class='ob-steps'>" +
    "<li><b>维护主简历</b>：左侧卡片增删改、拖拽排序，右侧 A4 实时预览，完整版可以是 2 页</li>" +
    "<li><b>投递取舍</b>：「＋新建岗位副本」→ 粘贴 JD 让 AI 出建议 → 取消勾选隐藏、调顺序，标尺自动收敛一页</li>" +
    "<li><b>一键导出</b>：「⬇ 导出 PDF」得到与预览 1:1 的 A4 打印版</li>" +
    "</ol><p class='ob-tip'>提示：Ctrl+S 保存 · Ctrl+Z 撤销 · 点右侧预览可定位左侧卡片 · ? 重看本引导</p>" +
    "<div class='m-row'><button class='btn primary' data-m='ok'>开始使用</button></div></div>";
  document.body.appendChild(ov);
  ov.addEventListener("click", function (e) {
    if (e.target === ov || (e.target.getAttribute && e.target.getAttribute("data-m") === "ok")) {
      ov.remove(); localStorage.setItem("vui-onboarded", "1");
    }
  });
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
    var sel = document.getElementById("doc-select");
    sel.innerHTML = state.list.map(function (n) {
      return "<option value=\"" + esc(n) + "\">" + (n === "主简历" ? "📄 主简历（完整版）" : "🎯 " + n) + "</option>";
    }).join("");
    if (!state.name && state.list.length) switchDoc(state.list[0]);
    else if (state.name) sel.value = state.name;
  });
}
function switchDoc(name) {
  state.name = name;
  document.getElementById("doc-select").value = name;
  return getJSON("/api/doc?name=" + encodeURIComponent(name)).then(function (doc) {
    state.doc = doc;
    document.getElementById("kind-badge").textContent = doc.kind === "job" ? "岗位副本" : "主简历";
    document.getElementById("kind-badge").className = "badge" + (doc.kind === "job" ? " job" : "");
    document.getElementById("job-banner").classList.toggle("hidden", doc.kind !== "job");
    var dens = (doc.meta && doc.meta.密度) || "标准";
    $$("#density-seg button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-density") === dens);
    });
    undoStack.length = 0; redoStack.length = 0; baseline = snap(); // 撤销栈不跨文档
    renderCards();
    updateChars();
    pushPreview();
  }).catch(function (e) { toast("文档加载失败：" + name + (e && e.message ? "（" + e.message + "）" : "")); });
}

/* ---------- 左侧卡片渲染 ---------- */
function ctlBtns(kind, id, extra) {
  return "<span class='ctl'>" +
    "<button data-act='up' data-k='" + kind + "' data-id='" + id + "' title='上移'>▲</button>" +
    "<button data-act='down' data-k='" + kind + "' data-id='" + id + "' title='下移'>▼</button>" +
    "<button data-act='del' data-k='" + kind + "' data-id='" + id + "' class='del' title='删除'>✕</button>" +
    (extra || "") + "</span>";
}
function showToggle(kind, id, hidden, job) {
  var tip = job ? "取消勾选 = 从本岗位版隐藏（主简历不受影响）"
                : "取消勾选 = 在主简历中隐藏（预览与导出 PDF 均不显示）";
  return "<label class='show-toggle' title='" + tip + "'>" +
    "<input type='checkbox' data-act='show' data-k='" + kind + "' data-id='" + id + "' " + (hidden ? "" : "checked") + ">显示</label>";
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
         (f === "照片" ? "<button class='btn small' data-act='pick-photo' title='打开文件对话框选择本地图片，自动上传到 data/'>📂 选择</button>" : "") +
         "</div>";
  });
  h += "</div>";

  /* 章节卡 */
  if (!(doc.sections || []).length) {
    h += "<div class='empty-tip big'>还没有章节：点下方「＋ 添加章节」开始搭建，或在 AI 助手里让 AI 帮你搭结构</div>";
  }
  (doc.sections || []).forEach(function (sec) {
    var fd = !!state.folded[sec.id];
    h += "<div class='card section" + (sec.hidden ? " item-off" : "") + (fd ? " folded" : "") + "' data-drop='section' data-id='" + sec.id + "'>";
    h += "<div class='card-head'>" +
         "<button class='fold-btn' data-act='fold' data-id='" + sec.id + "' title='" + (fd ? "展开章节" : "折叠为仅标题（方便拖动排序）") + "'>" + (fd ? "▸" : "▾") + "</button>" +
         "<span class='handle' draggable='true' data-dragk='section' data-id='" + sec.id + "'>⠿</span>" +
         "<input class='title-in' data-k='section' data-f='标题' data-id='" + sec.id + "' value=\"" + esc(sec["标题"]) + "\">" +
         showToggle("section", sec.id, sec.hidden, job) +
         ctlBtns("section", sec.id) + "</div>";
    (sec.entries || []).forEach(function (en) {
      h += "<div class='card entry" + (en.hidden ? " item-off" : "") + "' data-drop='entry' data-id='" + en.id + "'>";
      h += "<div class='row'>" +
           "<span class='handle' draggable='true' data-dragk='entry' data-id='" + en.id + "'>⠿</span>" +
           "<input class='grow' data-k='entry' data-f='left' data-id='" + en.id + "' value=\"" + esc(en.left) + "\" placeholder='主体（公司 / 项目 / 学校）'>" +
           "<input style='width:118px' data-k='entry' data-f='right' data-id='" + en.id + "' value=\"" + esc(en.right) + "\" placeholder='时间'>" +
           showToggle("entry", en.id, en.hidden, job) +
           ctlBtns("entry", en.id) + "</div>";
      h += "<div class='row'><input class='grow meta-input' data-k='entry' data-f='meta' data-id='" + en.id + "' value=\"" + esc(en.meta) + "\" placeholder='灰色说明行：角色 / 团队 / 技术栈（可选）'></div>";
      h += "<div class='row'><input class='grow tags-input' data-k='entry' data-f='tags' data-id='" + en.id + "' value=\"" + esc(en.tags) + "\" placeholder='tags: #标签（AI 匹配用，不打印）'></div>";
      (en.bullets || []).forEach(function (b) {
        h += "<div class='bullet-row" + (b.hidden ? " item-off" : "") + "' data-drop='bullet' data-id='" + b.id + "'>" +
             "<span class='handle' draggable='true' data-dragk='bullet' data-id='" + b.id + "'>⠿</span>" +
             "<textarea data-k='bullet' data-id='" + b.id + "' rows='2' placeholder='一条成果：动词开头 + 量化结果，**加粗** 关键数字'>" + esc(b.text) + "</textarea>" +
             "<span class='bcount' data-bc='" + b.id + "'></span>" +
             "<button class='ctl-b' data-act='bold' data-id='" + b.id + "' title='加粗选中文字（Ctrl+B）' aria-label='加粗选中文字'>B</button>" +
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

/* ---------- 加粗 / 预览定位 ---------- */
function boldSel(ta) {
  var s = ta.selectionStart, e2 = ta.selectionEnd;
  if (s == null || s === e2) { toast("先在成果里选中要加粗的文字"); return; }
  var v = ta.value, sel = v.slice(s, e2).replace(/^\*\*|\*\*$/g, "");
  ta.value = v.slice(0, s) + "**" + sel + "**" + v.slice(e2);
  var fb = findBullet(ta.getAttribute("data-id"));
  if (fb) fb.bullet.text = ta.value;
  ta.focus(); ta.selectionStart = s; ta.selectionEnd = s + sel.length + 4;
  afterChange(false);
}
function locateCard(id) {
  var el = document.querySelector("#cards [data-id='" + id + "']");
  var sec = el && el.closest(".card.section");
  if (sec && sec.classList.contains("folded")) { // 目标在折叠章节内先展开
    state.folded[sec.getAttribute("data-id")] = false;
    renderCards();
    el = document.querySelector("#cards [data-id='" + id + "']");
  }
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(function () { el.classList.remove("flash"); }, 1300);
}

/* ---------- 保存与预览 ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("✎ 修改中…");
  saveTimer = setTimeout(function () {
    postJSON("/api/save", { name: state.name, doc: state.doc }).then(function (r) {
      setSaveState(r.ok ? "✓ 已保存" : "⚠ 保存失败", r.ok ? "ok" : "warn");
    }).catch(function () { setSaveState("⚠ 保存失败", "warn"); });
  }, 900);
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
function afterChange(structural) {
  beforeChange();
  if (structural) renderCards();
  scheduleSave();
  schedulePreview();
  baseline = snap();
  updateChars();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  var cards = document.getElementById("cards");

  cards.addEventListener("input", function (e) {
    var t = e.target, k = t.getAttribute("data-k");
    if (!k) return;
    var v = t.value, id = t.getAttribute("data-id"), f = t.getAttribute("data-f");
    if (k === "meta") state.doc.meta[f] = v;
    else if (k === "section") { var s = secById(id); if (s) s[f] = v; }
    else if (k === "entry") { var r = findEntry(id); if (r) r.entry[f] = v; }
    else if (k === "bullet") { var b = findBullet(id); if (b) b.text = v; }
    afterChange(false);
  });

  cards.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act"), k = btn.getAttribute("data-k"), id = btn.getAttribute("data-id");
    if (act === "show") return; // checkbox 走 change
    if (act === "fold") { // 折叠/展开章节：仅编辑器显示状态，不改文档
      state.folded[id] = !state.folded[id];
      renderCards();
      return;
    }
    if (act === "pick-photo") { // 打开系统文件对话框选照片
      document.getElementById("photo-file").click();
      return;
    }
    if (act === "add-section") {
      state.doc.sections.push({ id: uid("s"), "标题": "新章节", hidden: false, entries: [] });
    } else if (act === "add-entry") {
      var s0 = secById(id);
      if (s0) s0.entries.push({ id: uid("e"), left: "", right: "", meta: "", tags: "", hidden: false, bullets: [{ id: uid("b"), text: "", hidden: false }] });
    } else if (act === "add-bullet") {
      var r0 = findEntry(id);
      if (r0) r0.entry.bullets.push({ id: uid("b"), text: "", hidden: false });
    } else if (act === "del") {
      var what = ({ section: "章节", entry: "条目", bullet: "成果" })[k] || "内容";
      askConfirm("删除这条" + what + "？", "删除后可用 Ctrl+Z 或右下角「撤销」随时恢复。", function () {
        if (k === "section") state.doc.sections = state.doc.sections.filter(function (s) { return s.id !== id; });
        else if (k === "entry") {
          var f1 = findEntry(id);
          if (f1) f1.section.entries = f1.section.entries.filter(function (x) { return x.id !== id; });
        } else if (k === "bullet") {
          var f2 = findBullet(id);
          if (f2) f2.entry.bullets = f2.entry.bullets.filter(function (x) { return x.id !== id; });
        }
        afterChange(true);
        toast("已删除" + what, 5000, { label: "撤销", fn: undo });
      });
      return;
    } else if (act === "bold") {
      var row = btn.closest(".bullet-row");
      var ta2 = row && row.querySelector("textarea");
      if (ta2) boldSel(ta2);
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
  });

  cards.addEventListener("change", function (e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute("data-act") === "show") {
      var found = findAny(t.getAttribute("data-id"));
      if (found) found.obj.hidden = !t.checked;
      t.closest(".card, .bullet-row, .card.section").classList.toggle("item-off", !t.checked);
      afterChange(false);
    }
    if (t.id === "density-select") return;
  });

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
    var job = state.doc && state.doc.kind === "job";
    f.className = "chip " + (job && (d.over || pct > 100) ? "warn" : pct >= 90 ? "ok" : "mid");
    adjustZoom();
  });

  /* 工具栏 */
  document.getElementById("doc-select").addEventListener("change", function (e) { switchDoc(e.target.value); });
  document.getElementById("density-seg").addEventListener("click", function (e) {
    var b = e.target.closest("[data-density]");
    if (!b || !state.doc) return;
    beforeChange();
    state.doc.meta["密度"] = b.getAttribute("data-density");
    $$("#density-seg button").forEach(function (x) { x.classList.toggle("on", x === b); });
    afterChange(false);
    toast("密度已切换：" + b.getAttribute("data-density") + "（右侧预览实时生效）");
  });
  document.getElementById("btn-help").addEventListener("click", function () { showOnboard(true); });
  document.getElementById("btn-save").addEventListener("click", function () {
    postJSON("/api/save", { name: state.name, doc: state.doc }).then(function (r) {
      toast(r.ok ? "已保存" : "保存失败"); setSaveState(r.ok ? "✓ 已保存" : "⚠ 保存失败", r.ok ? "ok" : "warn");
    });
  });
  document.getElementById("btn-export").addEventListener("click", function () {
    var btn = this;
    function go() {
      btn.disabled = true; setSaveState("⬇ 导出中…", "warn");
      postJSON("/api/save", { name: state.name, doc: state.doc }).then(function () {
        return postJSON("/api/export", { name: state.name });
      }).then(function (r) {
        btn.disabled = false; setSaveState("✓ 已保存", "ok");
        if (r.ok) { toast("PDF 已导出：" + r.pdf); window.open(r.pdf, "_blank"); }
        else toast("导出失败：" + (r.error || "未知错误"));
      }).catch(function (e) { btn.disabled = false; setSaveState("就绪"); toast("导出失败：" + e.message); });
    }
    if (state.doc && state.doc.kind === "job" && state.gauge && state.gauge.pages > 1) {
      askConfirm("岗位版超过一页", "当前约 " + state.gauge.pages + " 页，导出会逐级收紧排版硬塞进一页，可能偏密——建议先取舍内容。仍要导出吗？", go);
      return;
    }
    go();
  });
  document.getElementById("btn-newjob").addEventListener("click", function () {
    var name = prompt("岗位副本名称（建议：日期_公司_岗位）", "jobs/2026-XX-XX_公司_岗位");
    if (!name) return;
    postJSON("/api/newjob", { name: name }).then(function (r) {
      if (!r.ok) { toast("创建失败：" + (r.error || "")); return; }
      state.name = null;
      return loadList().then(function () { return switchDoc(r.name); });
    }).then(function () { toast("岗位副本已创建（已复制主简历）"); });
  });
  document.getElementById("zoom-select").addEventListener("change", adjustZoom);

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

  /* 全局快捷键：Ctrl+S 保存 / Ctrl+Z·Y 撤销重做 / Ctrl+E 导出 / Ctrl+B 加粗 / Esc 关弹层 */
  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (k === "escape") {
      closeModal();
      document.getElementById("ai-panel").classList.add("hidden");
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    if (k === "s") { e.preventDefault(); document.getElementById("btn-save").click(); }
    else if (k === "e") { e.preventDefault(); document.getElementById("btn-export").click(); }
    else if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === "b" && e.target && e.target.tagName === "TEXTAREA") { e.preventDefault(); boldSel(e.target); }
  });

  /* AI 面板 */
  document.getElementById("btn-ai").addEventListener("click", function () {
    document.getElementById("ai-panel").classList.toggle("hidden");
    var jd = state.doc && state.doc.job && state.doc.job.jdText;
    if (jd) document.getElementById("ai-jd").value = jd;
  });
  document.getElementById("ai-close").addEventListener("click", function () {
    document.getElementById("ai-panel").classList.add("hidden");
  });
  document.getElementById("ai-request").addEventListener("click", function () {
    var jd = document.getElementById("ai-jd").value.trim();
    if (!jd) { toast("请先粘贴 JD 原文"); return; }
    postJSON("/api/ai-request", { name: state.name, jd: jd }).then(function (r) {
      if (r.ok) toast("AI 请求已写入 data/ai-request.json\n到 ZCode 说：读 ai-request 生成建议");
    });
  });
  document.getElementById("ai-refresh").addEventListener("click", loadSuggestions);
}

/* ---------- AI 建议 ---------- */
function loadSuggestions() {
  getJSON("/api/ai-suggestion").then(function (r) {
    var box = document.getElementById("ai-cards");
    var items = r.items || [];
    if (!items.length) { box.innerHTML = "<div class='ai-empty'>暂无建议。先写入请求，再到 ZCode 生成 ai-suggestion.json</div>"; return; }
    box.innerHTML = items.map(function (it, i) {
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
    box.__items = items;
    $("[data-ai]", box).forEach(function (b) {
      b.addEventListener("click", function () {
        var it = box.__items[+b.getAttribute("data-ai")];
        var found = findAny(it.target);
        if (it.type === "rewrite" && found) found.obj.text = it.text;
        else if (it.type === "hide" && found) found.obj.hidden = true;
        else if (it.type === "show" && found) found.obj.hidden = false;
        state.appliedAI[+b.getAttribute("data-ai")] = true;
        afterChange(true);
        loadSuggestions();
      });
    });
  }).catch(function () {
    document.getElementById("ai-cards").innerHTML =
      "<div class='ai-empty'>还没有 ai-suggestion.json。先「写入 AI 请求」，然后到 ZCode 说：读 ai-request 生成建议</div>";
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
  bindEvents();
  loadList();
  showOnboard(false); // 首访三步引导（localStorage 记忆）
});
