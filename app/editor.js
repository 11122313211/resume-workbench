"use strict";
/* 简历可视化编辑器：卡片编辑 / 岗位取舍 / 自动保存 / 实时预览 / AI 辅助面板 */

/* ---------- 状态与基础 ---------- */
var state = { list: [], name: null, doc: null, appliedAI: {}, folded: {} };
var $ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
var saveTimer = null, pvTimer = null, iframeReady = false, pendingRender = false;

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
function toast(msg, ms) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  clearTimeout(t.__t); t.__t = setTimeout(function () { t.style.display = "none"; }, ms || 2600);
}
function setSaveState(txt) { document.getElementById("save-state").textContent = txt; }

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
    document.getElementById("density-select").value = (doc.meta && doc.meta.密度) || "标准";
    renderCards();
    pushPreview();
  }).catch(function () { toast("文档加载失败：" + name); });
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
             showToggle("bullet", b.id, b.hidden, job) +
             ctlBtns("bullet", b.id) + "</div>";
      });
      h += "<button class='add-btn' data-act='add-bullet' data-id='" + en.id + "'>＋ 添加成果</button></div>";
    });
    h += "<button class='add-btn' data-act='add-entry' data-id='" + sec.id + "'>＋ 添加条目</button></div>";
  });
  h += "<button class='add-btn' data-act='add-section'>＋ 添加章节</button>";
  box.innerHTML = h;
  document.getElementById("empty-hint").classList.toggle("hidden", !!doc);
  document.getElementById("left").scrollTop = sc;
}

/* ---------- 保存与预览 ---------- */
function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("修改中…");
  saveTimer = setTimeout(function () {
    postJSON("/api/save", { name: state.name, doc: state.doc }).then(function (r) {
      setSaveState(r.ok ? "已保存 ✓" : "保存失败");
    }).catch(function () { setSaveState("保存失败"); });
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
  if (structural) renderCards();
  scheduleSave();
  schedulePreview();
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
      if (!confirm("确认删除？")) return;
      if (k === "section") state.doc.sections = state.doc.sections.filter(function (s) { return s.id !== id; });
      else if (k === "entry") {
        var f1 = findEntry(id);
        if (f1) f1.section.entries = f1.section.entries.filter(function (x) { return x.id !== id; });
      } else if (k === "bullet") {
        var f2 = findBullet(id);
        if (f2) f2.entry.bullets = f2.entry.bullets.filter(function (x) { return x.id !== id; });
      }
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

  /* 拖拽排序 */
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
  cards.addEventListener("dragleave", function (e) {
    var card = e.target.closest("[data-drop]");
    if (card) card.classList.remove("drag-over");
  });
  cards.addEventListener("drop", function (e) {
    var card = e.target.closest("[data-drop]");
    if (!card || !dragInfo) return;
    e.preventDefault();
    card.classList.remove("drag-over");
    var dstId = card.getAttribute("data-id"), dstKind = card.getAttribute("data-drop");
    if (dstKind !== dragInfo.k || dstId === dragInfo.id) { dragInfo = null; return; }
    function relocate(getArr) {
      var src = findAny(dragInfo.id).obj, dst = findAny(dstId).obj;
      var arr = getArr(), i = arr.indexOf(src), j = arr.indexOf(dst);
      if (i < 0 || j < 0) return;
      arr.splice(i, 1);
      arr.splice(arr.indexOf(dst) + (j > i ? 1 : 0), 0, src);
    }
    if (dstKind === "section") relocate(function () { return state.doc.sections; });
    else if (dstKind === "entry") relocate(function () { return findEntry(dstId).section.entries; });
    else if (dstKind === "bullet") relocate(function () { return findBullet(dstId).entry.bullets; });
    dragInfo = null;
    afterChange(true);
  });

  /* 拖拽靠近左栏上下边缘时自动滚动，便于把卡片拖到视野外 */
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

  /* 预览通信 */
  var frame = document.getElementById("preview");
  frame.addEventListener("load", function () { iframeReady = true; pushPreview(); });  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (d.type !== "vui-gauge") return;
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
  document.getElementById("density-select").addEventListener("change", function (e) {
    state.doc.meta["密度"] = e.target.value;
    afterChange(false);
  });
  document.getElementById("btn-save").addEventListener("click", function () {
    postJSON("/api/save", { name: state.name, doc: state.doc }).then(function (r) {
      toast(r.ok ? "已保存" : "保存失败"); setSaveState("已保存 ✓");
    });
  });
  document.getElementById("btn-export").addEventListener("click", function () {
    var btn = this; btn.disabled = true; setSaveState("导出中…");
    postJSON("/api/save", { name: state.name, doc: state.doc }).then(function () {
      return postJSON("/api/export", { name: state.name });
    }).then(function (r) {
      btn.disabled = false; setSaveState("已保存 ✓");
      if (r.ok) { toast("PDF 已导出：" + r.pdf); window.open(r.pdf, "_blank"); }
      else toast("导出失败：" + (r.error || "未知错误"));
    }).catch(function (e) { btn.disabled = false; toast("导出失败：" + e.message); });
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
    setSaveState("上传照片…");
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
});
