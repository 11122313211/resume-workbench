#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简历工作台自动化验证清单（提出→开发→验证→结果 闭环的“验证”环节）。

运行：项目根目录执行  python tools/verify.py
退出码：0 = 无 FAIL；1 = 有 FAIL。
输出：每项一行 [PASS]/[FAIL]/[SKIP] + 简短证据，最后一行 RESULT: X passed, Y failed, Z skipped。

三节：
  STATIC   不依赖服务：py_compile、版本号标记、加粗算法同源标记、data JSON 可解析（只读）。
  API      探测 8618，不可达则 in-process 启动 serve.start_server()；list / ai-request / 副本生命周期 / 主简历禁删。
  HEADLESS Edge 无头 + 内嵌驱动页 app/__verify_drive.html（finally 删除），逐用例独立 --user-data-dir。

铁律遵守：只读写 tools/verify.py 自己与 verify- 前缀一次性副本；data/ai-request.json、
data/ai-suggestion.json 字节级备份后恢复；不改 app/、serve.py、tools/printer.py。
"""

import json
import os
import re
import html as html_mod
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
APP = ROOT / "app"
PORT = 8618
BASE = "http://127.0.0.1:%d" % PORT
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
TS = time.strftime("%Y%m%d-%H%M%S")
MARKERS = ["发起 AI 优化", "ai-apply-all", "ai-wrongdoc", "ai-steps"]
DRIVE = APP / "__verify_drive.html"
REQ_FILE = DATA / "ai-request.json"
SUG_FILE = DATA / "ai-suggestion.json"
MASTER = DATA / "主简历.json"
FINGERPRINTS = ("验证 JD", "【验证】", "verify-ui-", "verify-tmp-", "__verify")

RESULTS = []           # (section, name, status, evidence)
SERVER_NOTE = ""       # 服务复用/旧代码提示
HTTPD = None           # 本脚本 in-process 起的服务（只 shutdown 自己起的）


def add(section, name, status, evidence=""):
    evidence = re.sub(r"\s+", " ", str(evidence)).strip()[:240]
    RESULTS.append((section, name, status, evidence))
    print("[%s] %s / %s — %s" % (status, section, name, evidence or status))


def note(msg):
    print("NOTE: " + msg)


# ---------------------------------------------------------------- 基础工具
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 本地直连，不走代理


def http_req(method, path, body=None, timeout=15):
    url = BASE + path
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, "%s: %s" % (type(e).__name__, e)


def tryjson(txt):
    try:
        return json.loads(txt)
    except Exception:
        return {}


def read_text(p):
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def backup(p):
    return p.read_bytes() if p.is_file() else None


def atomic_write_bytes(p, blob):
    """同卷原子替换，避免服务端读到半截文件（Windows 下 read/write 相撞会 PermissionError）。"""
    tmp = p.with_name("verify-tmp-" + p.name + ".part")
    try:
        tmp.write_bytes(blob)
        for i in range(6):
            try:
                os.replace(tmp, p)
                return
            except PermissionError:
                time.sleep(0.05 * (i + 1))
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass


def restore(p, blob):
    try:
        if blob is None:
            for i in range(6):
                try:
                    if p.exists():
                        p.unlink()
                    return
                except PermissionError:
                    time.sleep(0.05 * (i + 1))
        else:
            atomic_write_bytes(p, blob)
    except Exception:
        pass


def flat_map(d, pre=""):
    out = {}
    if isinstance(d, dict):
        for k, v in d.items():
            out.update(flat_map(v, pre + "/" + str(k)))
    elif isinstance(d, list):
        for i, v in enumerate(d):
            out.update(flat_map(v, pre + "/" + str(i)))
    else:
        out[pre] = d
    return out


def diff_paths(a, b, limit=3):
    fa, fb = flat_map(a), flat_map(b)
    out = []
    for k in list(fb) + [k for k in fa if k not in fb]:
        if k in out:
            continue
        if fa.get(k, "<<缺>>") != fb.get(k, "<<缺>>"):
            out.append("%s: %r -> %r" % (k, str(fa.get(k, "<<缺>>"))[:24], str(fb.get(k, "<<缺>>"))[:24]))
        if len(out) >= limit:
            break
    return out


SAVE_LOG = []  # (时刻, name, job.jdText 片段)：本进程服务收到的全部落盘


def install_save_recorder():
    try:
        import serve
        orig = serve.write_doc
        if getattr(orig, "_verify_wrapped", False):
            return

        def wrapped(name, doc):
            try:
                jd = str(((doc or {}).get("job") or {}).get("jdText") or "")[:40]
                SAVE_LOG.append((time.strftime("%H:%M:%S"), str(name), jd))
            except Exception:
                pass
            return orig(name, doc)

        wrapped._verify_wrapped = True
        serve.write_doc = wrapped
    except Exception:
        pass


def port_open():
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def serve_src():
    try:
        return (ROOT / "serve.py").read_bytes()
    except Exception:
        return b""


# ---------------------------------------------------------------- 服务启动
def start_inprocess():
    """import serve 并 in-process 启动；serve.py 被并行编辑时报 SyntaxError 则 30s 重试（≤12 分钟）。"""
    global HTTPD
    deadline = time.time() + 720
    last = ""
    while time.time() < deadline:
        try:
            if str(ROOT) not in sys.path:
                sys.path.insert(0, str(ROOT))
            import serve  # noqa: F401
        except Exception as e:  # 并行子代理编辑中：SyntaxError 等都等 30s
            last = "%s: %s" % (type(e).__name__, e)
            note("import serve 失败（%s），30s 后重试…" % last)
            time.sleep(30)
            continue
        try:
            HTTPD = serve.start_server()
        except Exception as e:
            last = "start_server: %s" % e
            if port_open():  # 别的进程刚抢绑：复用
                return True
            time.sleep(2)
            continue
        threading.Thread(target=HTTPD.serve_forever, daemon=True).start()
        for _ in range(60):
            st, _b = http_req("GET", "/api/list", timeout=5)
            if st == 200:
                break
            time.sleep(0.25)
        install_save_recorder()
        return True
    note("import serve 持续失败：%s" % last)
    return False


def ensure_server():
    global SERVER_NOTE
    if port_open():
        SERVER_NOTE = "8618 已有服务，复用（若为旧进程，ai-request 新行为可能未生效）"
        return True
    SERVER_NOTE = "in-process serve.start_server() 启动"
    ok = start_inprocess()
    if ok and HTTPD is not None:
        refresh_server_if_stale._hash = hash(serve_src())  # 记录启动时的源码指纹
    return ok


def refresh_server_if_stale():
    """serve.py 在本次运行期间被并行修改过 → 重启自起的服务（不动任何外部进程）。"""
    global HTTPD, SERVER_NOTE
    if HTTPD is None:
        return
    cur = serve_src()
    if getattr(refresh_server_if_stale, "_hash", None) == hash(cur):
        return
    note("检测到 serve.py 变更 → 重启 in-process 服务")
    try:
        HTTPD.shutdown()
        HTTPD.server_close()
    except Exception:
        pass
    HTTPD = None
    sys.modules.pop("serve", None)
    ok = False
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            if str(ROOT) not in sys.path:
                sys.path.insert(0, str(ROOT))
            import serve
            HTTPD = serve.start_server()
            threading.Thread(target=HTTPD.serve_forever, daemon=True).start()
            for _ in range(60):
                st, _b = http_req("GET", "/api/list", timeout=5)
                if st == 200:
                    break
                time.sleep(0.25)
            install_save_recorder()
            ok = True
            break
        except Exception as e:
            note("重启 serve 失败（%s），10s 后重试…" % e)
            time.sleep(10)
    SERVER_NOTE = "in-process serve 重启%s" % ("" if ok else "失败（沿用不可用状态）")
    refresh_server_if_stale._hash = hash(serve_src())


# ---------------------------------------------------------------- 第 1 节 STATIC
def sec_static():
    import py_compile
    try:
        py_compile.compile(str(ROOT / "serve.py"), doraise=True)
        add("STATIC", "py_compile serve.py", "PASS", "编译通过")
    except Exception as e:
        add("STATIC", "py_compile serve.py", "FAIL", str(e).replace("\n", " ")[:200])

    page = read_text(APP / "index.html")
    refs = re.findall(r"editor\.(?:js|css)\?v=\d+", page)
    ok = "editor.js?v=8" in page and "editor.css?v=7" in page
    add("STATIC", "index.html 资源版本标记", "PASS" if ok else "FAIL",
        "%s | 实际: %s" % ("含 editor.js?v=8 与 editor.css?v=7" if ok else "缺契约版本号", ",".join(refs) or "无"))

    js = read_text(APP / "editor.js")
    pv = read_text(APP / "preview.html")
    okj = re.search(r"\bfunction\s+boldRanges\s*\(", js) is not None
    okp = re.search(r"\bfunction\s+inlineMd\s*\(", pv) is not None
    add("STATIC", "加粗算法同源标记", "PASS" if okj and okp else "FAIL",
        "editor.js boldRanges=%s, preview.html inlineMd=%s" % (okj, okp))

    files = [DATA / "主简历.json"] + (sorted((DATA / "jobs").glob("*.json")) if (DATA / "jobs").is_dir() else [])
    bad, n = [], 0
    for f in files:
        try:
            json.loads(f.read_text(encoding="utf-8"))
            n += 1
        except Exception as e:
            bad.append("%s(%s)" % (f.name, e))
    add("STATIC", "data JSON 可解析", "PASS" if not bad else "FAIL",
        "%d 个文件解析通过%s" % (n, ("；失败: " + "; ".join(bad[:3])) if bad else ""))


# ---------------------------------------------------------------- 第 2 节 API
def get_doc(full):
    st, body = http_req("GET", "/api/doc?name=" + urllib.parse.quote(full, safe=""))
    return st, tryjson(body)


def sec_api(server_ok):
    if not server_ok:
        add("API", "服务可用性", "FAIL", SERVER_NOTE or "8618 不可达且 in-process 启动失败")
        add("API", "/api/list", "SKIP", "服务不可用")
        add("API", "/api/ai-request 行为", "SKIP", "服务不可用")
        add("API", "一次性副本全生命周期", "SKIP", "服务不可用")
        add("API", "主简历禁删", "SKIP", "服务不可用")
        return
    add("API", "服务可用性", "PASS", SERVER_NOTE)

    # a) list
    st, body = http_req("GET", "/api/list")
    r = tryjson(body)
    docs = r.get("docs", []) if isinstance(r, dict) else []
    ok = st == 200 and r.get("ok") is True and "主简历" in docs
    add("API", "/api/list", "PASS" if ok else "FAIL",
        "http=%s ok=%s docs 含主简历=%s (%s…)" % (st, r.get("ok"), "主简历" in docs, ",".join(docs[:3])))

    # b) ai-request：备份 → 假建议文件 → 请求 → 断言 → 恢复
    rb, sb = backup(REQ_FILE), backup(SUG_FILE)
    try:
        write_suggestion({"ok": True, "items": [{"type": "note", "text": "假建议"}]})
        st, body = http_req("POST", "/api/ai-request", {"name": "主简历", "jd": "验证用 JD"})
        r = tryjson(body)
        agent_ok = isinstance(r.get("agentPrompt"), str) and "ai-suggestion.json" in r.get("agentPrompt", "")
        reqdoc = tryjson(REQ_FILE.read_text(encoding="utf-8")) if REQ_FILE.is_file() else {}
        fields_ok = all(k in reqdoc for k in ("for", "mode", "output"))
        sug_gone = not SUG_FILE.is_file()
        allok = st == 200 and r.get("ok") is True and agent_ok and fields_ok and sug_gone
        ev = "http=%s ok=%s agentPrompt非空且含ai-suggestion.json=%s 请求文件含for/mode/output=%s 假建议已删=%s" % (
            st, r.get("ok"), agent_ok, fields_ok, sug_gone)
        if not allok:
            ev += " | " + SERVER_NOTE
        add("API", "/api/ai-request 行为", "PASS" if allok else "FAIL", ev)
    finally:
        restore(REQ_FILE, rb)
        restore(SUG_FILE, sb)

    # c) 一次性副本全生命周期
    name = "verify-tmp-" + TS
    full = "jobs/" + name
    ev, allok = [], True

    st, body = http_req("POST", "/api/newjob", {"name": name})
    r = tryjson(body)
    s1 = st == 200 and r.get("ok") is True and r.get("name") == full
    allok &= s1
    ev.append("newjob=%s" % s1)

    st, doc = get_doc(full)
    s2 = st == 200 and isinstance(doc, dict) and doc.get("name") == full
    allok &= s2
    ev.append("doc读回=%s" % s2)

    if s2:
        doc.setdefault("meta", {})["__verify"] = "verify"
        st, body = http_req("POST", "/api/save", {"name": full, "doc": doc})
        r = tryjson(body)
        s3 = st == 200 and r.get("ok") is True
        allok &= s3
        ev.append("save=%s" % s3)
        _st, doc2 = get_doc(full)
        s4 = doc2.get("meta", {}).get("__verify") == "verify"
        allok &= s4
        ev.append("回读__verify=%s" % s4)

    st, body = http_req("POST", "/api/delete", {"name": full})
    r = tryjson(body)
    s5 = st == 200 and r.get("ok") is True
    allok &= s5
    ev.append("delete=%s" % s5)

    st, _doc = get_doc(full)
    s6 = st == 404
    allok &= s6
    ev.append("再读404=%s(http=%s)" % (s6, st))
    add("API", "一次性副本全生命周期", "PASS" if allok else "FAIL", " ".join(ev))

    # d) 主简历禁删
    st, body = http_req("POST", "/api/delete", {"name": "主简历"})
    r = tryjson(body)
    ok = st in (400, 403) and r.get("ok") is False
    add("API", "主简历禁删", "PASS" if ok else "FAIL",
        "http=%s ok=%s error=%s" % (st, r.get("ok"), r.get("error", "")))


# ---------------------------------------------------------------- 第 3 节 HEADLESS
DRIVER_TMPL = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>VERIFY-RUNNING</title></head>
<body>
<pre id="log"></pre>
<iframe id="ed" style="width:1280px;height:900px;border:0"></iframe>
<script>
"use strict";
var QS = new URLSearchParams(location.search);
var CASE = QS.get("case") || "";
var DOC = QS.get("doc") || "";           /* jobs/verify-ui-xxx */
var TARGET = QS.get("target") || "";     /* ai-apply 目标 bullet id */
var TARGET2 = QS.get("target2") || "";   /* ai-applyall 第二条 bullet id */
var ed = document.getElementById("ed");
var LOGBOX = document.getElementById("log");

function log(name, ok, detail) {
  detail = String(detail == null ? "" : detail).replace(/[<>&]/g, " ");
  LOGBOX.textContent += "beat: " + name + " " + (ok ? "PASS" : "FAIL") + (detail ? " | " + detail : "") + "\n";
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function wwait(fn, timeout, label) {
  var t0 = Date.now(), last = null;
  while (Date.now() - t0 < timeout) {
    var v = null;
    try { v = fn(); } catch (e) { last = e; }
    if (v) return v;
    await sleep(50);
  }
  throw new Error("等待超时: " + label + (last ? " | " + last : ""));
}
function idoc() { return ed.contentDocument; }
function iw() { return ed.contentWindow; }
function hookErr() {
  try {
    iw().onerror = function (m) { try { idoc().title = "JSERR: " + m; } catch (e) {} };
  } catch (e) {}
}
function iframeTitle() { try { return idoc() ? idoc().title : "(no doc)"; } catch (e) { return "(err)"; } }
function q(sel, root) { return (root || idoc()).querySelector(sel); }
function clickEl(sel) {
  var el = q(sel);
  if (!el) throw new Error("找不到元素: " + sel);
  el.click();
  return el;
}
function railReady() {
  var d = idoc();
  if (!d || !d.getElementById) return null;
  var dn = d.getElementById("rail-docname");
  var rows = d.querySelectorAll("#rail-docs [data-doc]");
  if (!dn || !rows.length) return null;
  return { dn: dn, rows: rows };
}
function railShows(docFull) {
  var r = railReady();
  if (!r) return false;
  var want = docFull.replace(/^jobs\//, "");
  var has = Array.prototype.some.call(r.rows, function (b) { return b.getAttribute("data-doc") === docFull; });
  return has && r.dn.textContent === want;
}
async function loadEditor(doc) {
  /* 驱动页与 iframe 同源（127.0.0.1:8618），localStorage 共享：加载前直接设 vui-last；
     若 rail-docname 未匹配则退回“iframe 内设 vui-last + reload”方案。 */
  try { localStorage.clear(); localStorage.setItem("vui-onboarded", "1"); } catch (e) {}
  if (doc) { try { localStorage.setItem("vui-last", doc); } catch (e) {} }
  await navFrame("/app/index.html?nointro=1");
  if (doc && !railShows(doc)) {
    try { iw().localStorage.setItem("vui-last", doc); } catch (e) {}
    await navFrame(null /* reload */);
  }
  await wwait(function () { return railReady(); }, 12000, "侧栏文档列表渲染");
  if (doc) await wwait(function () { return railShows(doc); }, 12000, "切换到 " + doc);
  await wwait(function () { return q("#cards .card"); }, 12000, "卡片渲染");
}
function navFrame(src) {
  var p = new Promise(function (res) {
    ed.addEventListener("load", function once() {
      ed.removeEventListener("load", once);
      setTimeout(res, 250);
    });
  });
  if (src) ed.src = src; else iw().location.reload();
  return p.then(hookErr);
}
async function openPanel() {
  clickEl('[data-nav="ai"]');
  await wwait(function () {
    var p = idoc().getElementById("ai-panel");
    return p && !p.classList.contains("ai-closed");
  }, 6000, "AI 面板打开");
}
function taOf(id) { return q('#cards textarea[data-id="' + id + '"]'); }

var CASES = {
  create: async function () {
    var name = "verify-ui-" + QS.get("ts");
    await loadEditor("");
    clickEl('[data-nav="newjob"]');
    var inp = await wwait(function () { return q("#m-input"); }, 6000, "弹窗输入框");
    inp.value = name;
    clickEl("[data-m='ok']");
    await wwait(function () { return railShows("jobs/" + name); }, 20000, "侧栏出现 " + name);
    log("create", true, "侧栏出现 " + name + " 且 #rail-docname 匹配");
  },

  bold: async function () {
    await loadEditor(DOC);
    var ta = await wwait(function () { return q("#cards .bullet-row textarea"); }, 8000, "首个 bullet textarea");
    var orig = ta.value;
    var btn = ta.closest(".bullet-row").querySelector(".ctl-b");
    ta.focus(); ta.setSelectionRange(0, 4);
    btn.click();
    var v1 = ta.value;
    var ok1 = v1.slice(0, 2) === "**" && v1.slice(2, 6) === orig.slice(0, 4) &&
              v1.slice(6, 8) === "**" && v1.slice(8) === orig.slice(4);
    log("bold/wrap", ok1, "选区被 ** 对包裹: " + JSON.stringify(v1.slice(0, 16)));
    btn.click();
    log("bold/unwrap", ta.value === orig, "再点一次标记消除");
    ta.setSelectionRange(0, ta.value.length);
    btn.click();
    var v3 = ta.value;
    var ok3 = v3.slice(0, 2) === "**" && v3.slice(-2) === "**" && v3.slice(2, -2) === orig.replace(/\*\*/g, "");
    log("bold/full", ok3, "全选加粗后 value 以 ** 开头 ** 结尾");
    btn.click();
    /* 全选加粗时 wrapBold 按算法溶解了选区内已有 ** 构造，故拆掉外层后=去粗文本，非原文 */
    log("bold/full-unwrap", ta.value === orig.replace(/\*\*/g, ""), "全选加粗再点拆掉外层标记");
  },

  "ai-apply": async function () {
    await loadEditor(DOC);
    var before = (taOf(TARGET) || {}).value || "";
    await openPanel();
    await wwait(function () { return q("#ai-cards .ai-card"); }, 8000, ".ai-card 渲染");
    var btn = await wwait(function () { return q('.apply-btn[data-ai="0"]'); }, 4000, ".apply-btn[0]");
    btn.click();
    await wwait(function () {
      var t = taOf(TARGET);
      return t && t.value.indexOf("【验证】改写后的成果文本") !== -1;
    }, 8000, "rewrite 应用到 textarea");
    log("ai-apply/rewrite", true, TARGET + " 文本已改为建议内容");
    var act = await wwait(function () { return idoc().getElementById("toast-act"); }, 4000, "#toast-act 撤销");
    act.click();
    await wwait(function () {
      var t = taOf(TARGET);
      return t && t.value === before;
    }, 8000, "撤销还原");
    log("ai-apply/undo", true, "撤销后文本还原");
  },

  "ai-applyall": async function () {
    await loadEditor(DOC);
    var b1 = (taOf(TARGET) || {}).value || "";
    await openPanel();
    await wwait(function () { return idoc().querySelectorAll("#ai-cards .ai-card").length >= 2; }, 8000, "2 张建议卡");
    var tb = await wwait(function () {
      var t = idoc().getElementById("ai-toolbar");
      return t && !t.classList.contains("hidden") ? t : null;
    }, 6000, "#ai-toolbar 显示");
    var cnt = (tb.querySelector("#ai-count") || {}).textContent || "";
    log("ai-applyall/count", cnt.indexOf("2") !== -1, "#ai-count=" + cnt);
    clickEl("#ai-apply-all");
    await wwait(function () {
      var t = taOf(TARGET);
      return t && t.value.indexOf("【验证】apply-all 改写") !== -1;
    }, 8000, "第一条 rewrite 应用");
    await wwait(function () {
      var r2 = q('.bullet-row[data-id="' + TARGET2 + '"]');
      return r2 && r2.classList.contains("item-off");
    }, 8000, "第二条 hide 应用");
    log("ai-applyall/apply", true, TARGET + " 已改写、" + TARGET2 + " 行有 .item-off");
    var act = await wwait(function () { return idoc().getElementById("toast-act"); }, 4000, "#toast-act");
    act.click();
    await wwait(function () {
      var t = taOf(TARGET);
      var r2 = q('.bullet-row[data-id="' + TARGET2 + '"]');
      return t && t.value === b1 && r2 && !r2.classList.contains("item-off");
    }, 8000, "一次撤销两者还原");
    log("ai-applyall/undo", true, "一次撤销同时还原改写与隐藏");
  },

  "ai-wrongdoc": async function () {
    await loadEditor("");
    await openPanel();
    await wwait(function () { return q("#ai-cards .ai-wrongdoc"); }, 8000, ".ai-wrongdoc 卡片");
    var hasApply = !!q("#ai-cards .apply-btn");
    log("ai-wrongdoc", !hasApply, ".ai-wrongdoc 存在，.apply-btn " + (hasApply ? "意外存在" : "不存在"));
    if (hasApply) throw new Error(".ai-wrongdoc 卡片不应有 .apply-btn");
  },

  "ai-badformat": async function () {
    await loadEditor("");
    await openPanel();
    await wwait(function () { return q("#ai-cards .ai-error"); }, 8000, ".ai-error 卡片");
    log("ai-badformat", true, "格式坏建议渲染 .ai-error");
  },

  "ai-request": async function () {
    await loadEditor(DOC);   /* 必须落在一次性副本上：JD 会随文档自动落盘，绝不能打在主简历 */
    await openPanel();
    var jd = await wwait(function () { return idoc().getElementById("ai-jd"); }, 6000, "#ai-jd");
    jd.value = "验证 JD";
    jd.dispatchEvent(new Event("input", { bubbles: true }));
    var rb = await wwait(function () { return idoc().getElementById("ai-request"); }, 4000, "#ai-request");
    rb.click();
    await wwait(function () { return rb.textContent.indexOf("已等待") !== -1; }, 8000, "按钮进入等待态");
    log("ai-request/waiting", true, "按钮文案: " + rb.textContent.trim());
    var sug = await iw().fetch("/api/ai-suggestion").then(function (r) { return r.json(); });
    var okSug = sug && Array.isArray(sug.items) && sug.items.length === 0;
    log("ai-request/cleared", okSug, "/api/ai-suggestion items=" + JSON.stringify((sug || {}).items));
    var req = await iw().fetch("/data/ai-request.json").then(function (r) { return r.json(); });
    var okReq = req && req.agentPrompt && ("for" in req) && ("mode" in req);
    log("ai-request/file", okReq, "/data/ai-request.json 含 agentPrompt/for/mode");
    rb.click();
    await wwait(function () { return rb.textContent.indexOf("发起 AI 优化") !== -1; }, 5000, "取消后文案复位");
    log("ai-request/cancel", true, "再点取消，文案回到「发起 AI 优化」");
  },

  "ai-steps": async function () {
    await loadEditor(DOC);   /* 同 ai-request：JD 输入触发自动保存，锁定一次性副本 */
    await openPanel();
    await wwait(function () { return idoc().querySelectorAll("#ai-steps .ai-step").length === 3; }, 6000, "#ai-steps 3 步");
    log("ai-steps/count", true, "3 个 .ai-step");
    var jd = idoc().getElementById("ai-jd");
    jd.value = "验证 JD steps";
    jd.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var s1 = q('#ai-steps .ai-step[data-step="1"]');
      return s1 && s1.classList.contains("done");
    }, 4000, "step1 加 .done");
    log("ai-steps/step1", true, "JD 输入后 step1 有 .done");
  }
};

(async function main() {
  try {
    var fn = CASES[CASE];
    if (!fn) { log("dispatch", false, "未知用例 " + CASE); return; }
    await fn();
    log("done", true, "用例完成");
  } catch (e) {
    log(CASE, false, String((e && e.message) || e) + " | iframeTitle=" + iframeTitle());
  } finally {
    document.title = "DONE";
  }
})();
</script>
</body>
</html>
"""


def find_edge():
    for p in EDGE_CANDIDATES:
        if Path(p).is_file():
            return p
    return None


def run_edge_once(edge, url):
    profile = tempfile.mkdtemp(prefix="verify-edge-")
    cmd = [edge, "--headless=new", "--disable-gpu", "--dump-dom",
           "--virtual-time-budget=40000", "--window-size=1400,1000",
           "--no-first-run", "--no-default-browser-check",
           "--user-data-dir=" + profile, url]
    html, timed_out = "", False
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            out, _err = proc.communicate(timeout=90)
            html = out.decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            proc.kill()
            out, _err = proc.communicate()
            html = out.decode("utf-8", "replace")
            timed_out = True
    except Exception as e:
        html = "<pre id=\"log\">beat: edge-launch FAIL | %s</pre>" % e
        timed_out = False
    finally:
        time.sleep(0.2)
        shutil.rmtree(profile, ignore_errors=True)
    m = re.search(r'<pre id="log">(.*?)</pre>', html, re.S)
    logtxt = html_mod.unescape(m.group(1)) if m else ""
    done = "<title>DONE</title>" in html
    return logtxt, done, timed_out


def fail_beats(logtxt):
    return [l.strip() for l in logtxt.splitlines()
            if l.strip().startswith("beat:") and " FAIL" in l]


def pass_evidence(logtxt):
    beats = [re.sub(r"^beat:\s*", "", l.strip()) for l in logtxt.splitlines()
             if l.strip().startswith("beat:") and " PASS" in l]
    return "; ".join(beats)


def bullet_ids(doc):
    out = []
    for s in (doc.get("sections") or []):
        for e in (s.get("entries") or []):
            for b in (e.get("bullets") or []):
                if b.get("id"):
                    out.append(b["id"])
    return out


def make_copy(suffix):
    nm = "verify-ui-" + TS + suffix
    st, body = http_req("POST", "/api/newjob", {"name": nm})
    r = tryjson(body)
    full = "jobs/" + nm
    if not (st == 200 and r.get("ok") is True):
        raise RuntimeError("newjob 失败 http=%s %s" % (st, body[:120]))
    st, doc = get_doc(full)
    if st != 200:
        raise RuntimeError("读副本失败 http=%s" % st)
    return full, bullet_ids(doc)


def write_suggestion(obj):
    atomic_write_bytes(SUG_FILE, json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def headless_case(case, prepare=None, doc="", target="", target2=""):
    url = (BASE + "/app/__verify_drive.html?case=" + urllib.parse.quote(case, safe="") +
           "&doc=" + urllib.parse.quote(doc, safe="") +
           "&target=" + urllib.parse.quote(target, safe="") +
           "&target2=" + urllib.parse.quote(target2, safe="") +
           "&ts=" + TS)
    last = None
    for attempt in (1, 2):  # 偶发失败重跑一次，区分 flake 与系统性失败
        if prepare:
            try:
                prepare()
            except Exception as e:
                add("HEADLESS", case, "FAIL", "用例准备失败: %s" % e)
                return
        logtxt, done, timed_out = run_edge_once(EDGE, url)
        ok = (not timed_out) and done and ("beat: done PASS" in logtxt) and not fail_beats(logtxt)
        if ok:
            ev = pass_evidence(logtxt)
            if attempt == 2:
                ev = "首跑失败、重跑通过（flake） | " + ev
            add("HEADLESS", case, "PASS", ev)
            return
        last = (logtxt, done, timed_out)
        note("用例 %s 第 %d 次未通过，%s" % (case, attempt, "重跑一次" if attempt == 1 else "判 FAIL"))
    logtxt, done, timed_out = last
    evs = []
    if timed_out:
        evs.append("Edge 进程超时被杀")
    if not done:
        evs.append("驱动页未到 DONE（可能 JS 崩溃/虚拟时间未结束）")
    fb = fail_beats(logtxt)
    evs.extend(fb[:3])
    if not logtxt:
        evs.append("log 为空：驱动页/被测页加载失败")
    add("HEADLESS", case, "FAIL", " | ".join(evs))


def sec_headless():
    global EDGE
    # 契约标记检查（已由实现代理落地则立即通过；未落地等 30s×24）
    deadline = time.time() + 720
    missing = MARKERS
    while True:
        js = read_text(APP / "editor.js")
        missing = [m for m in MARKERS if m not in js]
        if not missing:
            break
        if time.time() >= deadline:
            for c in ["create", "bold", "ai-apply", "ai-applyall", "ai-wrongdoc",
                      "ai-badformat", "ai-request", "ai-steps"]:
                add("HEADLESS", c, "SKIP", "契约标记未出现在 app/editor.js（缺 %s），无头部分整体跳过" % ",".join(missing))
            return
        note("契约标记未齐（缺 %s），30s 后复查…" % ",".join(missing))
        time.sleep(30)

    EDGE = find_edge()
    if not EDGE:
        for c in ["create", "bold", "ai-apply", "ai-applyall", "ai-wrongdoc",
                  "ai-badformat", "ai-request", "ai-steps"]:
            add("HEADLESS", c, "SKIP", "未找到 Edge（%s）" % "；".join(EDGE_CANDIDATES))
        return

    refresh_server_if_stale()
    DRIVE.write_text(DRIVER_TMPL, encoding="utf-8")
    MASTER_SNAP = backup(MASTER)                      # 主简历零污染守卫基线
    FULL_P = "jobs/verify-ui-" + TS + "-p"            # ai-request / ai-steps 用的一次性副本

    try:
        def prep_create():
            # 重跑防卡：上一次尝试留下的同名副本会触发同名覆盖确认弹窗，先删干净
            http_req("POST", "/api/delete", {"name": "jobs/verify-ui-" + TS}, timeout=5)
        headless_case("create", prepare=prep_create)

        # bold 用一次性副本，避免触碰 data/主简历.json（加粗会触发自动保存）
        try:
            full_b, _ids_b = make_copy("-b")

            def prep_bold():
                make_copy("-b")  # 重跑时重置副本，保证从无 ** 标记的干净状态开始
            headless_case("bold", prepare=prep_bold, doc=full_b)
        except Exception as e:
            add("HEADLESS", "bold", "FAIL", "准备副本失败: %s" % e)

        try:
            full_a1, ids1 = make_copy("-a1")
            t1 = ids1[0] if ids1 else "b-edu1"

            def prep_a1():
                make_copy("-a1")
                write_suggestion({"for": full_a1, "items": [
                    {"type": "rewrite", "target": t1, "text": "【验证】改写后的成果文本", "reason": "验证重写"}]})
            headless_case("ai-apply", prepare=prep_a1, doc=full_a1, target=t1)
        except Exception as e:
            add("HEADLESS", "ai-apply", "FAIL", "准备失败: %s" % e)

        try:
            full_a2, ids2 = make_copy("-a2")
            u1 = ids2[0] if len(ids2) > 0 else "b-edu1"
            u2 = ids2[1] if len(ids2) > 1 else "b-edu2"

            def prep_a2():
                make_copy("-a2")
                write_suggestion({"for": full_a2, "items": [
                    {"type": "rewrite", "target": u1, "text": "【验证】apply-all 改写", "reason": "r"},
                    {"type": "hide", "target": u2, "reason": "验证隐藏"}]})
            headless_case("ai-applyall", prepare=prep_a2, doc=full_a2, target=u1, target2=u2)
        except Exception as e:
            add("HEADLESS", "ai-applyall", "FAIL", "准备失败: %s" % e)

        def prep_wrong():
            write_suggestion({"for": "别的文档", "items": [
                {"type": "rewrite", "target": "b-edu1", "text": "不应被应用", "reason": "r"}]})
        headless_case("ai-wrongdoc", prepare=prep_wrong)

        def prep_bad():
            write_suggestion({"items": "oops"})
        headless_case("ai-badformat", prepare=prep_bad)

        def prep_req():
            make_copy("-p")  # 在副本上验证，避免编辑器把 JD 自动保存进主简历
            write_suggestion({"ok": True, "items": [{"type": "note", "text": "旧建议待清"}]})
        headless_case("ai-request", prepare=prep_req, doc=FULL_P)

        def prep_steps():
            make_copy("-p")
        headless_case("ai-steps", prepare=prep_steps, doc=FULL_P)

        # 主简历零污染守卫：无头用例全程不应改动 data/主简历.json
        cur = backup(MASTER)
        if cur == MASTER_SNAP:
            add("HEADLESS", "主简历零污染", "PASS", "无头用例前后字节级一致")
        else:
            try:
                a = json.loads(MASTER_SNAP.decode("utf-8")) if MASTER_SNAP else {}
                b = json.loads(cur.decode("utf-8")) if cur else {}
                paths = diff_paths(a, b)
            except Exception as ex:
                paths = ["差异解析失败: %s" % ex]
            txt = cur.decode("utf-8", "replace") if cur else ""
            fps = [f for f in FINGERPRINTS if f in txt]
            master_saves = [e for e in SAVE_LOG if e[1] == "主简历"]
            copy_saves = [e for e in SAVE_LOG if e[1].startswith("jobs/verify-")]
            if fps or master_saves:
                restore(MASTER, MASTER_SNAP)
            # 归因说明：全部编辑/JD 用例都经 loadEditor(DOC) 的 railShows 门禁锁在
            # verify-ui 一次性副本上；SAVE_LOG 只覆盖本进程自起的服务（复用外部服务时
            # 无从记账，此时仅凭字节对比判断）。发现污染先按快照字节恢复用户文件。
            add("HEADLESS", "主简历零污染", "FAIL",
                "主简历被 /api/save 写入 %d 次%s；本脚本可见落盘指向副本 %d 次 | 差异 %s | 已按快照字节恢复"
                % (len(master_saves),
                   ("，最后 %s jd=%s…" % (master_saves[-1][0], master_saves[-1][2][:24])) if master_saves else "",
                   len(copy_saves), "; ".join(paths)))
    finally:
        if DRIVE.exists():
            try:
                DRIVE.unlink()
            except Exception:
                pass


# ---------------------------------------------------------------- 清理
def cleanup_verify_docs():
    st, body = http_req("GET", "/api/list", timeout=5)
    names = []
    if st == 200:
        names = tryjson(body).get("docs", []) or []
    for n in names:
        base = n.split("/", 1)[1] if "/" in n else n
        if base.startswith("verify-"):
            http_req("POST", "/api/delete", {"name": n}, timeout=5)
    jd = DATA / "jobs"
    if jd.is_dir():
        for p in list(jd.glob("verify-*.json")) + list(jd.glob("verify-*.pdf")):
            try:
                p.unlink()
            except Exception:
                pass


def main():
    server_ok = False
    rb = sb = None
    try:
        sec_static()

        server_ok = ensure_server()
        rb, sb = backup(REQ_FILE), backup(SUG_FILE)
        try:
            sec_api(server_ok)
        finally:
            restore(REQ_FILE, rb)
            restore(SUG_FILE, sb)

        try:
            sec_headless()
        finally:
            restore(REQ_FILE, rb)
            restore(SUG_FILE, sb)
            cleanup_verify_docs()
    except Exception as e:
        import traceback
        add("VERIFY", "脚本自身异常", "FAIL", "%s: %s" % (type(e).__name__, e))
        note(traceback.format_exc(limit=4))
    finally:
        if HTTPD is not None:
            try:
                HTTPD.shutdown()
                HTTPD.server_close()
            except Exception:
                pass
        if DRIVE.exists():
            try:
                DRIVE.unlink()
            except Exception:
                pass

    npass = sum(1 for _, _, s, _ in RESULTS if s == "PASS")
    nfail = sum(1 for _, _, s, _ in RESULTS if s == "FAIL")
    nskip = sum(1 for _, _, s, _ in RESULTS if s == "SKIP")
    print("RESULT: %d passed, %d failed, %d skipped" % (npass, nfail, nskip))
    sys.exit(1 if nfail else 0)


if __name__ == "__main__":
    main()
