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

import hashlib
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
HIST_KEEP = set()      # verify 启动时已存在的建议归档文件名；结束时只清理本次新增的

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


def http_req(method, path, body=None, timeout=15, raw=None):
    url = BASE + path
    data = None
    headers = {}
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/octet-stream"
    elif body is not None:
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
        # 过期探测（R22 教训）：外部进程可能跑着旧版 serve.py，新端点会 404
        st, body = http_req("GET", "/api/ping", timeout=5)
        rev = hashlib.sha256((ROOT / "serve.py").read_bytes()).hexdigest()[:10]
        r = tryjson(body)
        if st != 200 or r.get("rev") != rev:
            SERVER_NOTE = "8618 外部服务为旧版本（/api/ping rev 不匹配，新端点用例可能失败）→ 请重启服务后重跑"
        else:
            SERVER_NOTE = "8618 已有服务，复用（版本指纹一致）"
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
    ok = "editor.js?v=35" in page and "editor.css?v=31" in page
    add("STATIC", "index.html 资源版本标记", "PASS" if ok else "FAIL",
        "%s | 实际: %s" % ("含 editor.js?v=35 与 editor.css?v=31" if ok else "缺契约版本号", ",".join(refs) or "无"))

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

    idbad = []
    for f in files:
        try:
            iddoc = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        vals = []

        def walk(o):
            if isinstance(o, dict):
                if "id" in o:
                    vals.append(o.get("id"))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(iddoc)
        if len(vals) != len(set(vals)) or any(not v for v in vals):
            idbad.append(f.name)
    add("STATIC", "数据 id 唯一且非空", "PASS" if not idbad else "FAIL",
        "全部文档 id 无缺失无重复" if not idbad else "异常文档: " + ",".join(idbad))

    anchors = ["triageStart", "aiApply", "updateJdMarks", "normalizeIds", "uploadPhotoBlob",
               "updateTimeFmt", "railFilter", "renameFlow", "startAIPoll", "setAIBadge",
               "refreshRailMeta", "openBackups", "lintDoc", "showLintModal", "showPhotoZoom",
               "showStats", "cycleDeliv", "exportByName", "openFind", "cycleDoc", "masterAt", "T 取舍模式（j/k 移动", "Alt+↑/↓ 切换文档"]
    missing = [a for a in anchors if a not in js]
    add("STATIC", "交互契约标记", "PASS" if not missing else "FAIL",
        "取舍/键盘应用/JD标记/id守卫/粘贴上传/时间助手/筛选/改名/建议就绪徽标/导出状态/备份恢复/交付体检 与引导文案全部在位" if not missing else "缺失: " + ",".join(missing))

    rd = read_text(ROOT / "README.md")
    marks = ["Alt+↑↓", "Ctrl+S", "Ctrl+E", "Ctrl+J", "交付体检", "历史备份", "导出状态点",
             "主简历漂移提示", "✎ 改名", "🤖", "T 取舍模式", "1-9", "投递一览", "投递状态", "一键导出", "Ctrl+F"]
    miss = [x for x in marks if x not in rd]
    add("STATIC", "README 手册契约", "PASS" if not miss else "FAIL",
        "键位表与功能入口描述全部在位（手册=实现）" if not miss else "缺: " + ",".join(miss))


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
        add("API", "副本重命名", "SKIP", "服务不可用")
        add("API", "投递状态", "SKIP", "服务不可用")
        add("API", "主简历禁删", "SKIP", "服务不可用")
        add("API", "导出 E2E（A4 PDF）", "SKIP", "服务不可用")
        add("API", "照片上传", "SKIP", "服务不可用")
        return
    add("API", "服务可用性", "PASS", SERVER_NOTE)

    # a) list
    st, body = http_req("GET", "/api/list")
    r = tryjson(body)
    docs = r.get("docs", []) if isinstance(r, dict) else []
    ok = st == 200 and r.get("ok") is True and "主简历" in docs
    add("API", "/api/list", "PASS" if ok else "FAIL",
        "http=%s ok=%s docs 含主简历=%s (%s…)" % (st, r.get("ok"), "主简历" in docs, ",".join(docs[:3])))

    # b) ai-request：备份 → 假建议文件 → 请求 → 断言（含历史归档）→ 恢复
    rb, sb = backup(REQ_FILE), backup(SUG_FILE)
    hist_dir = DATA / "ai-history"
    hist_before = {p.name for p in hist_dir.glob("*.json")} if hist_dir.is_dir() else set()
    try:
        write_suggestion({"ok": True, "items": [{"type": "note", "text": "假建议"}]})
        st, body = http_req("POST", "/api/ai-request", {"name": "主简历", "jd": "验证用 JD"})
        r = tryjson(body)
        agent_ok = isinstance(r.get("agentPrompt"), str) and "ai-suggestion.json" in r.get("agentPrompt", "")
        reqdoc = tryjson(REQ_FILE.read_text(encoding="utf-8")) if REQ_FILE.is_file() else {}
        fields_ok = all(k in reqdoc for k in ("for", "mode", "output"))
        sug_gone = not SUG_FILE.is_file()
        hist_after = {p.name for p in hist_dir.glob("*.json")} if hist_dir.is_dir() else set()
        new_arch = sorted(hist_after - hist_before)
        arch_ok = bool(new_arch) and bool(tryjson(read_text(hist_dir / new_arch[0])).get("items"))
        st3, body3 = http_req("GET", "/api/ai-history")
        r3 = tryjson(body3)
        list_ok = st3 == 200 and r3.get("ok") is True and len(r3.get("items") or []) >= 1
        allok = st == 200 and r.get("ok") is True and agent_ok and fields_ok and sug_gone and arch_ok and list_ok
        ev = "http=%s ok=%s agentPrompt=%s fields=%s 假建议已删=%s 旧建议已归档=%s /api/ai-history=%s" % (
            st, r.get("ok"), agent_ok, fields_ok, sug_gone, arch_ok, list_ok)
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
        bdir = DATA / ".backup" / ("jobs_" + name)   # R10：save 覆盖前旧版本自动留底
        bk = sorted(bdir.glob("*.json")) if bdir.is_dir() else []
        bdoc = tryjson(read_text(bk[-1])) if bk else {}
        s4b = bool(bk) and isinstance(bdoc, dict) and bdoc.get("meta", {}).get("__verify") != "verify"
        add("API", "保存自动留底", "PASS" if s4b else "FAIL",
            "备份目录=%s 份数=%d 最新份为保存前版本(无__verify)=%s" % (bdir.name if bk else "缺失", len(bk), s4b))

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

    # c2) 副本重命名：JSON 跟走（新可读/旧 404/主简历禁改）
    name_a = "verify-tmp-rename-" + TS
    full_a = "jobs/" + name_a
    http_req("POST", "/api/newjob", {"name": name_a})
    st, body = http_req("POST", "/api/rename", {"from": full_a, "to": "jobs/verify-tmp-renamed-" + TS})
    r = tryjson(body)
    rn1 = st == 200 and r.get("ok") is True
    st2, _ = get_doc("jobs/verify-tmp-renamed-" + TS)
    st3, _ = get_doc(full_a)
    st4, _b4 = http_req("POST", "/api/rename", {"from": "主简历", "to": "jobs/verify-tmp-nope"})
    rn_ok = rn1 and st2 == 200 and st3 == 404 and st4 == 400
    add("API", "副本重命名", "PASS" if rn_ok else "FAIL",
        "rename=%s 新可读=%s 旧404=%s 主简历禁改=%s(http=%s)" % (rn1, st2 == 200, st3 == 404, st4 == 400, st4))

    # c4) 投递状态（R33）：sidecar 设置/回读/非法值与未知文档拒绝/改名跟随/删除清理
    full_ds = "jobs/verify-tmp-ds-" + TS
    try:
        http_req("POST", "/api/newjob", {"name": "verify-tmp-ds-" + TS})
        st, body = http_req("POST", "/api/delivery", {"name": full_ds, "st": "已投"})
        w1 = st == 200 and tryjson(body).get("ok") is True
        _st, lb = http_req("GET", "/api/list")
        dv1 = (tryjson(lb).get("delivery") or {}).get(full_ds, {})
        r1 = dv1.get("st") == "已投" and bool(dv1.get("at"))
        st, _b = http_req("POST", "/api/delivery", {"name": full_ds, "st": "自定义状态"})
        bad = st == 400
        st, _b = http_req("POST", "/api/delivery", {"name": "jobs/verify-tmp-nope-" + TS, "st": "已投"})
        nope = st == 404
        st, _b = http_req("POST", "/api/rename", {"from": full_ds, "to": "jobs/verify-tmp-ds2-" + TS})
        _st, lb = http_req("GET", "/api/list")
        dv = tryjson(lb).get("delivery") or {}
        mig = "jobs/verify-tmp-ds2-" + TS in dv and full_ds not in dv
        st, _b = http_req("POST", "/api/delete", {"name": "jobs/verify-tmp-ds2-" + TS})
        _st, lb = http_req("GET", "/api/list")
        dv = tryjson(lb).get("delivery") or {}
        gone = "jobs/verify-tmp-ds2-" + TS not in dv
        ds_ok = w1 and r1 and bad and nope and mig and gone
        add("API", "投递状态", "PASS" if ds_ok else "FAIL",
            "写入=%s 回读=%s 非法状态400=%s 未知文档404=%s 改名跟随=%s 删除清理=%s"
            % (w1, r1, bad, nope, mig, gone))
    except Exception as e:
        add("API", "投递状态", "FAIL", "异常: %s" % e)

    # c3) 备份与恢复：两次保存留两份底 → 列表倒序 → 恢复旧版内容回得来 → 坏文件名拒绝
    full_bk = "jobs/verify-tmp-bk-" + TS
    try:
        http_req("POST", "/api/newjob", {"name": "verify-tmp-bk-" + TS})
        st, doc = get_doc(full_bk)
        b0 = doc["sections"][0]["entries"][0]["bullets"][0]["text"]
        http_req("POST", "/api/save", {"name": full_bk, "doc": doc})          # 留底 v0（原文）
        doc["sections"][0]["entries"][0]["bullets"][0]["text"] = "【verify】备份后修改A"
        http_req("POST", "/api/save", {"name": full_bk, "doc": doc})          # 留底 v0'，文件=v1
        st, bl = http_req("GET", "/api/backups?name=" + urllib.parse.quote(full_bk), timeout=10)
        items = tryjson(bl).get("items") or []
        lst_ok = st == 200 and len(items) >= 2 and items[0]["ts"] >= items[-1]["ts"]
        st, rl = http_req("POST", "/api/restore", {"name": full_bk, "file": items[-1]["file"]})
        rr1 = st == 200 and tryjson(rl).get("ok") is True
        st, doc2 = get_doc(full_bk)
        back = doc2["sections"][0]["entries"][0]["bullets"][0]["text"] == b0
        st, _rl2 = http_req("POST", "/api/restore", {"name": full_bk, "file": "../escape.json"})
        guard = st == 400
        bk_ok = lst_ok and rr1 and back and guard
        add("API", "备份恢复", "PASS" if bk_ok else "FAIL",
            "列表≥2倒序=%s 恢复=%s 内容还原=%s 目录穿越拒绝=%s(http=%s)" % (lst_ok, rr1, back, guard, st))
    except Exception as e:
        add("API", "备份恢复", "FAIL", "异常: %s" % e)

    # d) 主简历禁删
    st, body = http_req("POST", "/api/delete", {"name": "主简历"})
    r = tryjson(body)
    ok = st in (400, 403) and r.get("ok") is False
    add("API", "主简历禁删", "PASS" if ok else "FAIL",
        "http=%s ok=%s error=%s" % (st, r.get("ok"), r.get("error", "")))

    # d2) 加固边界（R29）：路径穿越拒绝 / 巨型请求体拒绝 / 仅大小写不同的改名诚实拒绝
    try:
        st, _b = http_req("POST", "/api/save", {"name": "../evil", "doc": {"kind": "master"}})
        t1 = st == 400
        st, _b = http_req("GET", "/api/doc?name=" + urllib.parse.quote("../evil"), timeout=10)
        t2 = st == 400
        st, _b = http_req("POST", "/api/newjob", {"name": "verify-tmp-cs-" + TS})
        nm_cs = "jobs/verify-tmp-cs-" + TS
        # 大写化同名（casefold 相等）→ 应 400 拒绝
        st, _b = http_req("POST", "/api/rename", {"from": nm_cs, "to": nm_cs.upper()})
        t3 = st == 400
        st, _b = get_doc(nm_cs)  # 原文档必须毫发无损
        t4 = st == 200
        big = {"name": "jobs/verify-tmp-big-" + TS, "doc": {"kind": "job", "pad": "x" * (21 * 1024 * 1024)}}
        st, _b = http_req("POST", "/api/save", big, timeout=30)
        t5 = st == 400
        allok = t1 and t2 and t3 and t4 and t5
        add("API", "加固边界", "PASS" if allok else "FAIL",
            "穿越拒绝=%s(读%s写%s) 大小写改名拒绝=%s 原档无损=%s 巨型体拒绝=%s(http=%s)"
            % (t1, t2, t1, t3, t4, t5, st))
    except Exception as e:
        add("API", "加固边界", "FAIL", "异常: %s" % e)

    # d3) 漂移锚点（R30）：新副本 meta 带 masterAt，且不晚于主简历当前 savedAt（新建副本无假漂移）
    try:
        http_req("POST", "/api/newjob", {"name": "verify-tmp-dr-" + TS})
        st, bl = http_req("GET", "/api/list", timeout=10)
        meta = tryjson(bl).get("meta") or {}
        mc = meta.get("jobs/verify-tmp-dr-" + TS) or {}
        mm2 = meta.get("主简历") or {}
        t1 = bool(mc.get("masterAt"))
        t2 = not (mm2.get("savedAt") and mm2["savedAt"] > mc["masterAt"])
        add("API", "漂移锚点", "PASS" if (t1 and t2) else "FAIL",
            "masterAt=%s 新建副本无假漂移=%s" % (t1, t2))
    except Exception as e:
        add("API", "漂移锚点", "FAIL", "异常: %s" % e)

    # e) 导出 E2E：核心交付物（A4 PDF）端到端——真实走 Edge 无头打印，约数秒
    exp_name = "verify-ui-" + TS + "-ex"
    exp_full = "jobs/" + exp_name
    pdf_path = DATA / "jobs" / (exp_name + ".pdf")
    tgt = DATA / ".export-target.json"
    tgt_snap = backup(tgt)
    try:
        st, body = http_req("POST", "/api/newjob", {"name": exp_name})
        made = st == 200 and tryjson(body).get("ok") is True
        # R24 fresh 检查必须在导出前：新副本不应带任何状态戳
        def list_meta(nm):
            stl, bl = http_req("GET", "/api/list", timeout=10)
            return (tryjson(bl).get("meta") or {}).get(nm) or {}
        m0 = list_meta(exp_full)
        fresh_ok = not m0.get("exportedAt") and not m0.get("savedAt")
        st2, body2 = http_req("POST", "/api/export", {"name": exp_full}, timeout=150)
        r2 = tryjson(body2)
        pdf_ok = pdf_path.is_file() and pdf_path.stat().st_size > 1024
        head_ok = pdf_ok and pdf_path.read_bytes()[:5] == b"%PDF-"
        a4_ok = False
        if pdf_ok:
            m = re.search(rb"MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)",
                          pdf_path.read_bytes())
            if m:
                w = float(m.group(3)) - float(m.group(1))
                h = float(m.group(4)) - float(m.group(2))
                a4_ok = 593 <= w <= 597 and 840 <= h <= 844  # A4=595×842pt（210×297mm）
        allok = made and st2 == 200 and r2.get("ok") is True and pdf_ok and head_ok and a4_ok
        # R24 导出状态可见性：导出后 exportedAt=绿 → 再保存 savedAt>exportedAt=琥珀（fresh 已在导出前检查）
        m1 = list_meta(exp_full)
        green_ok = bool(m1.get("exportedAt")) and (m1.get("savedAt") or "") <= m1["exportedAt"]
        time.sleep(1.1)  # 跨过导出那一秒，确保 savedAt 严格大于 exportedAt
        std, bd = get_doc(exp_full)
        st3, _b3 = http_req("POST", "/api/save", {"name": exp_full, "doc": bd})
        m2 = list_meta(exp_full)
        amber_ok = st3 == 200 and bool(m2.get("savedAt")) and m2["savedAt"] > (m2.get("exportedAt") or "")
        allok = allok and fresh_ok and green_ok and amber_ok
        add("API", "导出 E2E（A4 PDF）", "PASS" if allok else "FAIL",
            "建副本=%s http=%s ok=%s pdf存在>1KB=%s %%PDF头=%s MediaBox=A4(%s) 状态戳[无=%s 绿=%s 琥珀=%s] | %s"
            % (made, st2, r2.get("ok"), pdf_ok, head_ok, a4_ok, fresh_ok, green_ok, amber_ok,
               str(r2.get("error", ""))[:60]))
    finally:
        restore(tgt, tgt_snap)
        try:
            if pdf_path.is_file():
                pdf_path.unlink()
        except Exception:
            pass
        http_req("POST", "/api/delete", {"name": exp_full}, timeout=10)

    # f) 照片上传：合法 png 落盘 + 非法扩展名被拒
    png1x1 = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082")
    st, body = http_req("POST", "/api/upload-photo?ext=.png", raw=png1x1)
    r = tryjson(body)
    name = str(r.get("name", ""))
    saved = name.startswith("photo-") and name.endswith(".png") and (DATA / name).is_file()
    st2, body2 = http_req("POST", "/api/upload-photo?ext=.exe", raw=png1x1)
    rejected = st2 == 400 and tryjson(body2).get("ok") is False
    allok = st == 200 and r.get("ok") is True and saved and rejected
    try:
        if saved:
            (DATA / name).unlink()
    except Exception:
        pass
    add("API", "照片上传", "PASS" if allok else "FAIL",
        "http=%s ok=%s 落盘=%s(%s) 非法扩展名被拒=%s(http=%s)" % (st, r.get("ok"), saved, name[:24], rejected, st2))


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
    ta.value = "验证加粗文本ABCDEF";   /* 与真实数据解耦：固定无 ** 的内容（用户首条可能自带加粗标记） */
    ta.dispatchEvent(new Event("input", { bubbles: true }));
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
    var dold = q("#ai-cards .ai-diff .d-old"), dnew = q("#ai-cards .ai-diff .d-new");
    var diffOk = !!(dold && dnew && dold.textContent.length > 4 && dnew.textContent.indexOf("【验证】改写后的成果文本") !== -1);
    log("ai-apply/diff", diffOk, "改写卡渲染 原文/改写 对照（原行 " + (dold ? dold.textContent.length : 0) + " 字）");
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
    log("ai-request/history-ui", !!idoc().getElementById("ai-history"), "#ai-history 历史区容器存在");
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
  },

  "triage": async function () {   /* 键盘取舍模式：t 进入 → j 移动 → h 隐藏/恢复 → Esc 退出 */
    await loadEditor(DOC);
    function press(key) {
      idoc().dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
    }
    await wwait(function () {
      return idoc().querySelectorAll("#cards .bullet-row, #cards .card.entry, #cards .card.section").length >= 3;
    }, 8000, "卡片渲染");
    press("t");
    await wwait(function () { return idoc().getElementById("triage-hud"); }, 4000, "HUD 出现");
    var cur1 = await wwait(function () { return idoc().querySelector("#cards .triage-cur"); }, 4000, "当前行高亮");
    var id1 = cur1.getAttribute("data-id");
    log("triage/start", true, "进入取舍模式，当前行 " + id1);
    press("j");
    await wwait(function () {
      var el = idoc().querySelector("#cards .triage-cur");
      return el && el.getAttribute("data-id") !== id1;
    }, 4000, "j 移动到下一行");
    var id2 = idoc().querySelector("#cards .triage-cur").getAttribute("data-id");
    log("triage/move", true, "j: " + id1 + " → " + id2);
    press("h");
    await wwait(function () {
      var el = idoc().querySelector('#cards [data-id="' + id2 + '"]');
      return el && el.classList.contains("item-off");
    }, 8000, "h 隐藏生效（item-off）");
    log("triage/hide", true, id2 + " 已隐藏");
    press("h");
    await wwait(function () {
      var el = idoc().querySelector('#cards [data-id="' + id2 + '"]');
      return el && !el.classList.contains("item-off");
    }, 8000, "h 恢复显示");
    log("triage/restore", true, id2 + " 已恢复");
    press("Escape");
    await wwait(function () { return !idoc().getElementById("triage-hud"); }, 4000, "Esc 退出 HUD 消失");
    await wwait(function () { return !idoc().querySelector("#cards .triage-cur"); }, 4000, "高亮清除");
    log("triage/exit", true, "Esc 退出取舍模式");
  },

  "undobtn": async function () {   /* 手打 bullet 落模型（存量 bug 回归守卫）+ 侧栏 ↶↷ 按钮全链路 */
    await loadEditor(DOC);
    var ta = await wwait(function () { return q("#cards .bullet-row textarea"); }, 8000, "首个 bullet textarea");
    var orig = ta.value;
    await wwait(function () {
      var b = idoc().getElementById("rail-undo");
      return b && b.disabled;
    }, 4000, "初始 ↶ 禁用");
    log("undobtn/init", true, "无改动时 ↶ 禁用");
    ta.value = orig + "【增】";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    var bmodel = iw().findBullet(ta.getAttribute("data-id"));
    await wwait(function () { return bmodel.bullet.text === orig + "【增】"; }, 4000, "手打文本写入数据模型");
    log("undobtn/model", true, "手打文本已落模型");
    await wwait(function () {
      var b = idoc().getElementById("rail-undo");
      return b && !b.disabled;
    }, 4000, "改动后 ↶ 启用");
    log("undobtn/enable", true, "输入后 ↶ 启用");
    idoc().getElementById("rail-undo").click();
    await wwait(function () {
      var t2 = q("#cards .bullet-row textarea");
      return t2 && t2.value === orig;
    }, 6000, "点击 ↶ 还原内容");
    log("undobtn/undo", true, "↶ 撤销与 Ctrl+Z 等效");
    idoc().getElementById("rail-redo").click();
    await wwait(function () {
      var t3 = q("#cards .bullet-row textarea");
      return t3 && t3.value === orig + "【增】";
    }, 6000, "点击 ↷ 恢复改动");
    log("undobtn/redo", true, "↷ 重做恢复改动");
  },

  "jdm": async function () {   /* JD 相关性标记：贴 JD → 含关键词行出 ★徽标，无匹配行无痕 */
    await loadEditor(DOC);
    await openPanel();
    var jd = await wwait(function () { return idoc().getElementById("ai-jd"); }, 6000, "#ai-jd");
    jd.value = "岗位要求：精通 Python 与 Django，熟悉 MySQL 调优，有高性能后端经验";
    jd.dispatchEvent(new Event("input", { bubbles: true }));
    var ta = await wwait(function () { return q("#cards .bullet-row textarea"); }, 8000, "首个 bullet textarea");
    ta.value = "无匹配词占位内容";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var row = q("#cards .bullet-row");
      return row && !row.querySelector(".jd-hit");
    }, 6000, "无匹配行无徽标");
    log("jdm/nomatch", true, "无匹配内容无 ★徽标");
    ta.value = "精通 Python，做过 Django 项目";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var row = q("#cards .bullet-row");
      var el = row && row.querySelector(".jd-hit");
      return el && el.textContent.indexOf("★") === 0;
    }, 6000, "命中行出现 ★徽标");
    log("jdm/hit", true, "含 JD 关键词的行打了 ★徽标（Python/Django）");
  },

  "idfix": async function () {   /* 数据完整性守卫：重复 id 打开即修复并落盘 */
    await loadEditor(DOC);
    await wwait(function () {
      return idoc().querySelectorAll("#cards .card.section").length >= 2;
    }, 8000, "两个章节渲染");
    var okIds = await wwait(function () {
      return iw().fetch("/api/doc?name=" + encodeURIComponent(DOC)).then(function (r) { return r.json(); }).then(function (doc) {
        var ids = [];
        (doc.sections || []).forEach(function (s) {
          ids.push(s.id);
          (s.entries || []).forEach(function (e) {
            ids.push(e.id);
            (e.bullets || []).forEach(function (b) { ids.push(b.id); });
          });
        });
        return ids.length >= 4 && new Set(ids).size === ids.length && ids.indexOf(null) === -1;
      });
    }, 9000, "落盘的 id 已唯一");
    log("idfix/unique", true, "重复 id 打开即修复并落盘（章节内容未丢）");
  },

  "aikeys": async function () {   /* AI 面板 1-9 快速应用：按 1 应用第一条建议，卡片带序号 */
    await loadEditor(DOC);
    await openPanel();
    await wwait(function () { return q("#ai-cards .ai-card"); }, 8000, ".ai-card 渲染");
    await wwait(function () {
      var n = q("#ai-cards .ai-card .ai-num");
      return n && n.textContent === "1";
    }, 4000, "卡片带序号 1");
    log("aikeys/num", true, "建议卡片显示序号 1");
    idoc().dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await wwait(function () {
      var t = taOf(TARGET);
      return t && t.value.indexOf("【验证】键盘应用的建议文本") !== -1;
    }, 8000, "按 1 后建议已应用");
    log("aikeys/apply", true, "键盘 1 应用第一条建议成功");
  },

  "paste-img": async function () {   /* 剪贴板粘贴图片：合成 paste 事件 → 自动上传 → 照片字段落位 */
    await loadEditor(DOC);
    await wwait(function () { return q("#cards .card"); }, 8000, "编辑器渲染");
    var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var dt = new DataTransfer();
    dt.items.add(new File([arr], "clip.png", { type: "image/png" }));
    idoc().dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await wwait(function () {
      var inp = q("#cards input[data-f='照片']");
      return inp && inp.value.indexOf("photo-") === 0;
    }, 9000, "照片字段填充 photo-*");
    log("paste-img/done", true, "粘贴图片自动上传并落到照片字段");
  },

  "timefmt": async function () {   /* 时间列格式助手：非法格式 amber 提示，合法格式无痕 */
    await loadEditor(DOC);
    var inp = await wwait(function () { return q("input[data-f='right']"); }, 8000, "时间输入框");
    inp.value = "abc";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var i = q("input[data-f='right']");
      return i && i.classList.contains("time-warn");
    }, 4000, "非法格式标 amber");
    log("timefmt/warn", true, "非法格式出现提示样式");
    inp.value = "2024.06 ~ 至今";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var i = q("input[data-f='right']");
      return i && !i.classList.contains("time-warn");
    }, 4000, "合法格式无痕");
    log("timefmt/ok", true, "合法格式无提示无痕");
  },

  "railfilter": async function () {   /* rail 文档筛选：输入关键字只剩匹配行，清空恢复 */
    await loadEditor(DOC);
    await wwait(function () { return idoc().querySelectorAll("#rail-docs .rail-row").length >= 1; }, 8000, "文档列表渲染");
    var si = await wwait(function () { return idoc().getElementById("rail-search"); }, 4000, "筛选框存在");
    si.value = "verify-ui";
    si.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      var box = idoc().getElementById("rail-docs");
      return box.querySelectorAll(".rail-row").length >= 1 && box.textContent.indexOf("主简历") === -1;
    }, 4000, "筛选后只剩匹配行");
    log("railfilter/filter", true, "筛选 verify-ui 后不匹配的文档被隐藏");
    si.value = "";
    si.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () {
      return idoc().getElementById("rail-docs").textContent.indexOf("主简历") !== -1;
    }, 4000, "清空筛选全部恢复");
    log("railfilter/clear", true, "清空后列表恢复完整");
  },

  "stats": async function () {   /* 投递一览：📊 打开弹窗 → 副本行存在 → 点行关闭弹窗并定位对应副本 */
    await loadEditor(DOC);
    await wwait(function () { return idoc().querySelectorAll("#rail-docs .rail-row").length >= 1; }, 8000, "文档列表渲染");
    clickEl("[data-nav='stats']");
    await wwait(function () {
      var t = q("#modal .m-title");
      return t && t.textContent.indexOf("投递一览") !== -1;
    }, 4000, "投递一览弹窗");
    await wwait(function () { return q('#modal .stats-row[data-doc="' + DOC + '"]'); }, 4000, "本副本行存在");
    log("stats/table", true, "投递一览列出副本行（日期/公司/岗位/导出状态）");
    var prev = null, seenDash = false, sorted = true;
    [].forEach.call(idoc().querySelectorAll("#modal .stats-row td:first-child"), function (td) {
      var d = td.textContent;
      if (!/^\d{4}-/.test(d)) { seenDash = true; return; }  // 无日期副本应排最后
      if (seenDash) sorted = false;
      if (prev && prev < d) sorted = false;                  // 有日期行应为倒序
      prev = d;
    });
    log("stats/sort", sorted, "日期倒序在前、无日期副本靠后");
    var pill = q('#modal .stats-row[data-doc="' + DOC + '"] .deliv-pill');
    var before = pill.textContent;
    pill.click();
    await wwait(function () {
      var p = q('#modal .stats-row[data-doc="' + DOC + '"] .deliv-pill');
      return p && p.textContent !== before;
    }, 6000, "点胶囊状态推进");
    log("stats/cycle", true, "投递状态胶囊点击即推进（sidecar 记录，刷新回读一致）");
    q('#modal .stats-row[data-doc="' + DOC + '"]').click();
    await wwait(function () { return !q("#modal"); }, 4000, "点行后弹窗关闭");
    await wwait(function () { return railShows(DOC); }, 6000, "定位到对应副本");
    log("stats/jump", true, "点击行跳转到对应副本");
  },

  "statsexp": async function () {  /* 一键导出（R34）：未导出行 ⬇ → 跳到副本 → 标准导出链路触发（体检或直接导出均为合法） */
    await loadEditor("");
    await wwait(function () { return idoc().querySelectorAll("#rail-docs .rail-row").length >= 1; }, 8000, "列表渲染");
    clickEl("[data-nav='stats']");
    await wwait(function () {
      var t = q("#modal .m-title");
      return t && t.textContent.indexOf("投递一览") !== -1;
    }, 4000, "投递一览弹窗");
    var btn = await wwait(function () {
      return q('#modal .stats-row[data-doc="' + DOC + '"] .stats-export');
    }, 8000, "未导出行出现 ⬇ 按钮");
    btn.click();
    await wwait(function () { return railShows(DOC); }, 6000, "已跳到对应副本");
    var path = await wwait(function () {   // 体检拦截或导出完成：都是标准链路的合法分支
      if (q("#modal .lint-item")) return "lint";
      var t = idoc().getElementById("toast");
      if (t && t.textContent.indexOf("PDF 已导出") !== -1) return "done";
      return "";
    }, 30000, "导出管线触发");
    log("statsexp/fired", path !== "", "一键导出触发标准链路（" + (path === "lint" ? "体检拦截" : "直接导出完成") + "）");
    if (path === "lint") clickEl("#modal [data-m='no']");
  },

  "find": async function () {    /* 文档内查找（R35）：Ctrl+F 打开 → 唯一命中计数 → 定位高亮 → Esc 关闭 */
    await loadEditor(DOC);
    await wwait(function () { return q("#cards .bullet-row textarea"); }, 8000, "卡片渲染");
    var ta = q("#cards .bullet-row textarea");
    ta.value = "动词开头验证查找目标Zq7x量化结果";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    idoc().dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await wwait(function () { return q("#find-bar.on #find-in"); }, 4000, "查找条打开");
    var fi = q("#find-in");
    fi.value = "Zq7x";
    fi.dispatchEvent(new Event("input", { bubbles: true }));
    await wwait(function () { return q("#find-count").textContent.indexOf("1 处") !== -1; }, 4000, "唯一命中计数");
    log("find/count", true, "唯一关键词命中 1 处");
    q("#find-next").click();
    await wwait(function () {
      var c = q("#cards .bullet-row.find-cur");
      return c && c.querySelector("textarea").value.indexOf("Zq7x") !== -1 &&
             q("#find-count").textContent === "1/1";
    }, 4000, "定位到命中行");
    log("find/goto", true, "命中行高亮并计数 1/1");
    fi.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wwait(function () { return !q("#find-bar.on"); }, 4000, "Esc 关闭查找条");
    log("find/close", true, "Esc 关闭查找条");
  },

  "chipjump": async function () {   /* 「已隐藏 N」chip 点击：进取舍模式并定位第一个隐藏行 */
    await loadEditor(DOC);
    function press(key) {
      idoc().dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
    }
    await wwait(function () { return q("#cards .bullet-row, #cards .card.entry"); }, 8000, "卡片渲染");
    press("t");
    await wwait(function () { return idoc().querySelector("#cards .triage-cur"); }, 4000, "进入取舍模式");
    press("h");
    await wwait(function () {
      var c = idoc().getElementById("hidden-chip");
      return c && !c.classList.contains("hidden");
    }, 6000, "chip 出现");
    log("chipjump/chip", true, "隐藏后「已隐藏 N」chip 出现");
    press("Escape");
    await wwait(function () { return !idoc().getElementById("triage-hud"); }, 4000, "退出取舍");
    idoc().getElementById("hidden-chip").click();
    await wwait(function () {
      var cur = idoc().querySelector("#cards .triage-cur");
      return cur && cur.classList.contains("item-off");
    }, 6000, "定位到隐藏行");
    log("chipjump/done", true, "chip 点击进入取舍模式并定位到隐藏行");
  },

  "aibadge": async function () {  /* 建议就绪全局提醒：prepare 预先写好属于 DOC 的建议 → 面板关闭时侧栏 🤖 亮圆点 → 打开面板熄灭 */
    await loadEditor(DOC); /* 面板默认关闭；全局轮询 2.5s 内应感知已就绪的建议 */
    var dot = await wwait(function () { return q("[data-nav='ai'] .ai-ready"); }, 8000, "🤖 亮起 .ai-ready 徽标");
    log("aibadge/dot", !!dot, "面板关闭时建议就绪 → 侧栏 🤖 亮圆点（无需开面板才发现）");
    clickEl("[data-nav='ai']");
    await wwait(function () { return !q("[data-nav='ai'] .ai-ready"); }, 6000, "打开面板后徽标熄灭");
    log("aibadge/clear", true, "打开面板即视为查看，徽标熄灭");
  },

  "expmark": async function () {  /* 导出状态可见性（绿）：初始无状态点 → 真点导出按钮 → 绿点出现（客户端 refreshRailMeta 链路） */
    await loadEditor(DOC);
    function rowDotA(cls) {
      var b = q("#rail button[data-nav='doc'][data-doc='" + DOC + "']");
      var row = b && b.closest(".rail-row");
      return row ? row.querySelector(".rail-exp" + (cls ? "." + cls : "")) : null;
    }
    await wwait(function () { return q("#rail button[data-nav='doc'][data-doc='" + DOC + "']"); }, 8000, "侧栏渲染");
    if (rowDotA()) throw new Error("导出前不应有状态点");
    log("expmark/fresh", true, "新副本无导出状态点（其他文档的点不受干扰）");
    clickEl("[data-nav='export']");
    await wwait(function () {  /* 岗位超页会先弹确认：两条路都接受 */
      if (rowDotA("ok")) return rowDotA("ok");
      var m = idoc().getElementById("modal");
      if (m) { var ok = m.querySelector("[data-m='ok']"); if (ok) ok.click(); }
      return null;
    }, 40000, "导出后绿点出现");
    log("expmark/green", true, "导出成功 → 侧栏绿点（已导出最新）");
  },

  "expmark2": async function () {  /* 导出状态可见性（琥珀）：prepare 已真实导出 → 初始绿点 → 改动保存 → 琥珀点 */
    await loadEditor(DOC);
    function rowDotB(cls) {
      var b = q("#rail button[data-nav='doc'][data-doc='" + DOC + "']");
      var row = b && b.closest(".rail-row");
      return row ? row.querySelector(".rail-exp" + (cls ? "." + cls : "")) : null;
    }
    await wwait(function () { return rowDotB("ok"); }, 15000, "初始绿点存在");
    log("expmark2/green", true, "prepare 已导出 → 初始绿点");
    var ta = await wwait(function () { return q("#cards textarea[data-id]"); }, 8000, "首个文本框");
    ta.value = "【验证】导出后改动文本XYZ";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    clickEl("[data-nav='save']"); // 立即落盘（跳过 900ms 防抖，降低虚拟时间消耗）
    await wwait(function () { return rowDotB("stale"); }, 30000, "保存后琥珀点出现");
    log("expmark2/amber", true, "改动保存后 → 琥珀点（导出后有改动）");
  },

  "altswitch": async function () {  /* Alt+↓/↑ 循环切换文档：侧栏当前项与头部文档名联动 */
    await loadEditor(DOC);
    await wwait(function () { return q("#rail-docname") && q("#rail-docname").textContent.length > 0; }, 8000, "头部文档名渲染");
    var before = q("#rail-docname").textContent;
    idoc().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    await wwait(function () { return q("#rail-docname").textContent !== before; }, 8000, "Alt+↓ 切到下一个文档");
    log("altswitch/down", true, before + " → " + q("#rail-docname").textContent);
    idoc().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true }));
    await wwait(function () { return q("#rail-docname").textContent === before; }, 8000, "Alt+↑ 切回原文档");
    log("altswitch/up", true, "Alt+↑ 回到 " + before);
  },

  "photozoom": async function () {  /* 预览照片点击 → 放大弹层 → 点击关闭（查看类，无按钮） */
    await loadEditor(DOC);
    var ph = await wwait(function () {
      return idoc().getElementById("preview").contentDocument.querySelector("img.photo");
    }, 12000, "预览中出现照片");
    ph.click();
    var big = await wwait(function () { return q(".photo-zoom-img"); }, 6000, "放大弹层出现");
    log("photozoom/open", !!big, "点预览照片出现放大层");
    big.click();
    await wwait(function () { return !q(".photo-zoom-img"); }, 6000, "点击关闭放大层");
    log("photozoom/close", true, "再点任意处关闭");
  },

  "lint": async function () {  /* 交付体检：占位内容副本 → 导出弹出体检清单 → 取消导出不落地 */
    await loadEditor(DOC);
    clickEl("[data-nav='export']");
    await wwait(function () { return q("#modal .lint-item"); }, 10000, "体检清单出现");
    var title = q("#modal .m-title").textContent;
    log("lint/list", title.indexOf("交付体检") !== -1, title);
    clickEl("#modal [data-m='no']");
    await wwait(function () { return !q("#modal"); }, 6000, "取消后弹窗关闭");
    log("lint/cancel", true, "取消导出：未触发打印、清单可关");
  },

  "backup": async function () {  /* 备份恢复 UI：🕘 打开列表 → 行存在 → 恢复需确认（破坏类契约）→ 确认后执行 */
    await loadEditor(DOC);
    var bk = await wwait(function () {
      return q("#rail button[data-nav='bkdoc'][data-doc='" + DOC + "']");
    }, 8000, "🕘 备份按钮存在");
    bk.click();
    await wwait(function () { return q("#modal .bk-row"); }, 6000, "备份列表有行");
    var rows = idoc().querySelectorAll("#modal .bk-row").length;
    log("backup/list", rows >= 1, "备份行数=" + rows);
    q("#modal [data-bk]").click();
    await wwait(function () {
      var t = q("#modal .m-title");
      return t && t.textContent.indexOf("恢复") !== -1;
    }, 6000, "确认弹窗出现");
    log("backup/confirm", true, "恢复需二次确认（破坏类=confirm+可撤销）");
    clickEl("#modal [data-m='ok']");
    await wwait(function () { return idoc().body.textContent.indexOf("已恢复到") !== -1; }, 8000, "恢复完成 toast");
    log("backup/done", true, "恢复执行完成，toast 提示可撤销");
  },

  "rename": async function () {   /* 副本重命名：✎ → 弹窗输入新名 → 侧栏出现新名 */
    await loadEditor(DOC);
    await wwait(function () {
      return idoc().querySelector('#rail button[data-nav="rendoc"][data-doc="' + DOC + '"]');
    }, 8000, "✎ 改名按钮存在");
    idoc().querySelector('#rail button[data-nav="rendoc"][data-doc="' + DOC + '"]').click();
    var inp = await wwait(function () { return idoc().getElementById("m-input"); }, 4000, "改名弹窗");
    inp.value = "verify-ui-" + QS.get("ts") + "-rn2";
    var ok = idoc().querySelector("#modal [data-m='ok']") || idoc().querySelector("#modal button");
    ok.click();
    await wwait(function () { return railShows("jobs/verify-ui-" + QS.get("ts") + "-rn2"); }, 8000, "侧栏出现新名");
    log("rename/done", true, "重命名后侧栏出现新名");
  },

  menu: async function () {   /* ⋯ 集合菜单：4 项齐全（首项=状态感知 隐藏/恢复）→ 菜单隐藏生效（琥珀眼睛出现）→ 眼睛恢复 → 上移收起 → 删除确认可取消 → Esc */
    await loadEditor(DOC);
    function visSec() {
      var all = idoc().querySelectorAll("#cards .card.section");
      for (var i = 0; i < all.length; i++) if (!all[i].classList.contains("item-off")) return all[i];
      return null;
    }
    function openOnVisible() {
      var s = visSec();
      if (!s) throw new Error("无可见章节");
      s.querySelector(".ctl-menu").click();
      return wwait(function () { return q(".vui-menu"); }, 6000, "菜单弹出");
    }
    var sec = await wwait(visSec, 8000, "可见章节");
    sec.querySelector(".ctl-menu").click();
    var m = await wwait(function () { return q(".vui-menu"); }, 6000, "菜单弹出");
    var n = m.querySelectorAll("button").length;
    log("menu/open", n === 4, "菜单项 " + n + "/4（含 隐藏/恢复）");
    var tid = m.querySelector("[data-act='show']").getAttribute("data-id");
    m.querySelector("[data-act='show']").click();
    await wwait(function () {
      var el = q("#cards .card.section[data-id='" + tid + "']");
      return el && el.classList.contains("item-off") && el.querySelector(".show-toggle.off");
    }, 6000, "菜单隐藏生效");
    log("menu/hide", true, "菜单「隐藏」生效：行变暗 + 琥珀眼睛");
    var comp = q("#cards .card.section[data-id='" + tid + "'] > .card.entry");
    var disp = comp ? idoc().defaultView.getComputedStyle(comp).display : "(无条目)";
    log("menu/compress", disp === "none", "隐藏章节自动压缩：条目 display=" + disp);
    var hc = idoc().getElementById("hidden-chip");
    log("menu/hidden-chip", !!hc && !hc.classList.contains("hidden") && /已隐藏\s*1/.test(hc.textContent),
        "进度 chip=" + (hc ? hc.textContent : "无"));
    q("#cards .card.section[data-id='" + tid + "']").querySelector(".show-toggle.off").click();
    await wwait(function () {
      var el = q("#cards .card.section[data-id='" + tid + "']");
      return el && !el.classList.contains("item-off");
    }, 6000, "琥珀眼睛恢复");
    var hc2 = idoc().getElementById("hidden-chip");
    log("menu/eye-restore", hc2 && hc2.classList.contains("hidden"), "琥珀眼睛一键恢复显示；chip 归零无痕");
    m = await openOnVisible();
    var sid = m.querySelector("[data-act='up']").getAttribute("data-id");
    m.querySelector("[data-act='up']").click();
    await wwait(function () { return !q(".vui-menu"); }, 6000, "动作后自动收起");
    log("menu/act-close", q("#cards .card.section[data-id='" + sid + "']") !== null, "上移项可执行且菜单收起、DOM 完整");
    m = await openOnVisible();
    var did = m.querySelector("[data-act='del']").getAttribute("data-id");
    m.querySelector("[data-act='del']").click();
    var modal = await wwait(function () { return idoc().getElementById("modal"); }, 6000, "删除确认弹窗");
    log("menu/del-confirm", !!modal.querySelector("[data-m='ok']"), "破坏类确认弹窗出现");
    modal.querySelector("[data-m='no']").click();
    await wwait(function () { return !idoc().getElementById("modal"); }, 4000, "取消关闭弹窗");
    await wwait(function () { return !q(".vui-menu"); }, 4000, "菜单同步收起");
    log("menu/cancel", q("#cards .card.section[data-id='" + did + "']") !== null, "取消删除：内容未变");
    (visSec() || q("#cards .card.section")).querySelector(".ctl-menu").click();
    await wwait(function () { return q(".vui-menu"); }, 6000, "菜单最后一次弹出");
    idoc().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wwait(function () { return !q(".vui-menu"); }, 4000, "Esc 收起菜单");
    log("menu/esc", true, "Esc 关闭菜单");
  },

  "master-no-eye": async function () {  /* 主简历可见行不渲染眼睛（低频操作收进 ⋯ 菜单）；只读断言，不触发保存 */
    await loadEditor("");
    await wwait(function () { return q("#cards .card.section"); }, 8000, "卡片渲染");
    var isMaster = q("#rail-docname").textContent === "主简历";
    var n = idoc().querySelectorAll("#cards .show-toggle:not(.off)").length;
    log("master-no-eye", isMaster && n === 0, "当前文档=" + q("#rail-docname").textContent + " 可见行眼睛 " + n + "（应为 0）");
  },

  "save-feedback": async function () {  /* 保存反馈就地化：状态行 ✓已保存 → 2s 衰减回就绪，全程不弹 toast */
    await loadEditor(DOC);
    var st = await wwait(function () { return idoc().getElementById("save-state"); }, 6000, "状态行");
    st.click();
    await wwait(function () { return st.textContent === "✓ 已保存"; }, 8000, "状态行确认已保存");
    var t1 = idoc().getElementById("toast").style.display;
    log("save/inline", t1 !== "block", "不弹 toast（toast display=" + t1 + "）");
    await wwait(function () { return st.textContent === "就绪"; }, 6000, "归于就绪");
    log("save/decay", true, "状态行 2s 后衰减回中性「就绪」");
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
           "--virtual-time-budget=90000", "--window-size=1400,1000",
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
    return "; ".join(pass_beats(logtxt))


def pass_beats(logtxt):
    return [re.sub(r"^beat:\s*", "", l.strip()) for l in logtxt.splitlines()
            if l.strip().startswith("beat:") and " PASS" in l]


def bullet_ids(doc):
    out = []
    for s in (doc.get("sections") or []):
        for e in (s.get("entries") or []):
            for b in (e.get("bullets") or []):
                if b.get("id"):
                    out.append(b["id"])
    return out


def scrub_hidden(o):
    """递归清零 hidden：用户主简历可能自带任意隐藏条目，测试副本必须与真实数据解耦。"""
    if isinstance(o, dict):
        if "hidden" in o:
            o["hidden"] = False
        for v in o.values():
            scrub_hidden(v)
    elif isinstance(o, list):
        for v in o:
            scrub_hidden(v)


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
    scrub_hidden(doc)
    st2, _ = http_req("POST", "/api/save", {"name": full, "doc": doc})
    if st2 != 200:
        raise RuntimeError("副本 hidden 清零失败 http=%s" % st2)
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
    evs.extend(pass_beats(logtxt)[-4:])  # 失败也要带上已走过的步子：定位卡在哪一步
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
                      "ai-badformat", "ai-request", "ai-steps", "menu", "master-no-eye", "save-feedback", "triage", "undobtn", "jdm", "idfix", "aikeys", "paste-img", "timefmt", "railfilter", "chipjump", "aibadge", "expmark", "expmark2", "lint", "photozoom", "altswitch", "backup", "rename", "stats", "statsexp", "find"]:
                add("HEADLESS", c, "SKIP", "契约标记未出现在 app/editor.js（缺 %s），无头部分整体跳过" % ",".join(missing))
            return
        note("契约标记未齐（缺 %s），30s 后复查…" % ",".join(missing))
        time.sleep(30)

    EDGE = find_edge()
    if not EDGE:
        for c in ["create", "bold", "ai-apply", "ai-applyall", "ai-wrongdoc",
                  "ai-badformat", "ai-request", "ai-steps", "triage", "undobtn", "jdm", "idfix", "aikeys", "paste-img", "timefmt", "railfilter", "chipjump", "aibadge", "expmark", "expmark2", "lint", "photozoom", "altswitch", "backup", "rename", "stats", "statsexp", "find"]:
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

        try:
            full_m, _ids_m = make_copy("-m")
            headless_case("menu", doc=full_m)
        except Exception as e:
            add("HEADLESS", "menu", "FAIL", "准备副本失败: %s" % e)

        def prep_wrong():
            write_suggestion({"for": "别的文档", "items": [
                {"type": "rewrite", "target": "b-edu1", "text": "不应被应用", "reason": "r"}]})
        headless_case("ai-wrongdoc", prepare=prep_wrong)

        headless_case("master-no-eye")  # 主简历可见行无眼睛：只读用例，无需副本

        try:
            full_s, _ids_s = make_copy("-s")
            headless_case("save-feedback", doc=full_s)
        except Exception as e:
            add("HEADLESS", "save-feedback", "FAIL", "准备副本失败: %s" % e)

        try:
            full_t, _ids_t = make_copy("-t")
            headless_case("triage", doc=full_t)
        except Exception as e:
            add("HEADLESS", "triage", "FAIL", "准备副本失败: %s" % e)

        try:
            full_u, _ids_u = make_copy("-u")
            headless_case("undobtn", doc=full_u)
        except Exception as e:
            add("HEADLESS", "undobtn", "FAIL", "准备副本失败: %s" % e)

        try:
            full_j, _ids_j = make_copy("-j")
            headless_case("jdm", doc=full_j)
        except Exception as e:
            add("HEADLESS", "jdm", "FAIL", "准备副本失败: %s" % e)

        try:
            full_d, _ids_d = make_copy("-d")

            def prep_idfix():
                make_copy("-d")  # 重置副本
                st, doc = get_doc(full_d)
                if doc.get("sections") and len(doc["sections"]) > 1:
                    try:  # 制造重复 id：第二章节首个 bullet 与第一章节首个 bullet 同 id
                        doc["sections"][1]["entries"][0]["bullets"][0]["id"] = \
                            doc["sections"][0]["entries"][0]["bullets"][0]["id"]
                    except Exception:
                        pass
                    http_req("POST", "/api/save", {"name": full_d, "doc": doc}, timeout=10)

            headless_case("idfix", prepare=prep_idfix, doc=full_d)
        except Exception as e:
            add("HEADLESS", "idfix", "FAIL", "准备副本失败: %s" % e)

        try:
            full_k, ids_k = make_copy("-k")
            k1 = ids_k[0] if ids_k else "b-edu1"

            def prep_keys():
                make_copy("-k")
                write_suggestion({"for": full_k, "items": [
                    {"type": "rewrite", "target": k1, "text": "【验证】键盘应用的建议文本", "reason": "验证 1-9"}]})
            headless_case("aikeys", prepare=prep_keys, doc=full_k, target=k1)
        except Exception as e:
            add("HEADLESS", "aikeys", "FAIL", "准备副本失败: %s" % e)

        try:
            full_pi, _ids_pi = make_copy("-pi")
            headless_case("paste-img", doc=full_pi)
        except Exception as e:
            add("HEADLESS", "paste-img", "FAIL", "准备副本失败: %s" % e)

        try:
            full_tf, _ids_tf = make_copy("-tf")
            headless_case("timefmt", doc=full_tf)
        except Exception as e:
            add("HEADLESS", "timefmt", "FAIL", "准备副本失败: %s" % e)

        try:
            full_rf, _ids_rf = make_copy("-rf")
            headless_case("railfilter", doc=full_rf)
        except Exception as e:
            add("HEADLESS", "railfilter", "FAIL", "准备副本失败: %s" % e)

        try:
            full_st, _ids_st = make_copy("-st")
            headless_case("stats", doc=full_st)
        except Exception as e:
            add("HEADLESS", "stats", "FAIL", "准备副本失败: %s" % e)

        try:
            full_se, _ids_se = make_copy("-se")   # 未导出副本：一览行内应有 ⬇ 按钮
            headless_case("statsexp", doc=full_se)
        except Exception as e:
            add("HEADLESS", "statsexp", "FAIL", "准备副本失败: %s" % e)

        try:
            full_fd, _ids_fd = make_copy("-fd")
            headless_case("find", doc=full_fd)
        except Exception as e:
            add("HEADLESS", "find", "FAIL", "准备副本失败: %s" % e)

        try:
            full_cj, _ids_cj = make_copy("-cj")
            headless_case("chipjump", doc=full_cj)
        except Exception as e:
            add("HEADLESS", "chipjump", "FAIL", "准备副本失败: %s" % e)

        try:
            full_rn, _ids_rn = make_copy("-rn")
            headless_case("rename", doc=full_rn)
        except Exception as e:
            add("HEADLESS", "rename", "FAIL", "准备副本失败: %s" % e)

        try:
            full_xp, _ids_xp = make_copy("-xp")

            def prep_xp():
                make_copy("-xp")  # 重跑防脏：第 1 次尝试导出会盖 exportedAt，重建副本让 fresh 前置在重试时仍成立
            headless_case("expmark", prepare=prep_xp, doc=full_xp)
        except Exception as e:
            add("HEADLESS", "expmark", "FAIL", "准备副本失败: %s" % e)

        try:
            full_x2, _ids_x2 = make_copy("-x2")

            def prep_x2():
                make_copy("-x2")  # 每次尝试重建副本并真实导出一次：服务端盖 exportedAt，初始即绿点
                stx, _bx = http_req("POST", "/api/export", {"name": "jobs/verify-ui-" + TS + "-x2"}, timeout=150)
                if stx != 200:
                    raise RuntimeError("prepare 导出失败 http=%s" % stx)
            headless_case("expmark2", prepare=prep_x2, doc=full_x2)
        except Exception as e:
            add("HEADLESS", "expmark2", "FAIL", "准备副本失败: %s" % e)

        try:
            full_as, _ids_as = make_copy("-as")
            headless_case("altswitch", doc=full_as)
        except Exception as e:
            add("HEADLESS", "altswitch", "FAIL", "准备副本失败: %s" % e)

        try:
            full_ph, _ids_ph = make_copy("-ph")
            headless_case("photozoom", doc=full_ph)
        except Exception as e:
            add("HEADLESS", "photozoom", "FAIL", "准备副本失败: %s" % e)

        try:
            full_li, _ids_li = make_copy("-li")

            def prep_li():
                make_copy("-li")  # 每次尝试重建：往首个可见 bullet 注入占位文本，保证体检必命中
                nm = "jobs/verify-ui-" + TS + "-li"
                stl, dl = get_doc(nm)
                dl["sections"][0]["entries"][0]["bullets"][0]["text"] = "XX公司占位待补充"
                http_req("POST", "/api/save", {"name": nm, "doc": dl})
            headless_case("lint", prepare=prep_li, doc=full_li)
        except Exception as e:
            add("HEADLESS", "lint", "FAIL", "准备副本失败: %s" % e)

        try:
            full_bkui, _ids_bkui = make_copy("-bkui")  # make_copy 已存一次盘留底一份；再改一次凑出可见备份列表
            headless_case("backup", doc=full_bkui)
        except Exception as e:
            add("HEADLESS", "backup", "FAIL", "准备副本失败: %s" % e)

        try:
            full_bg, _ids_bg = make_copy("-bg")

            def prep_bg():
                make_copy("-bg")
                # 建议在编辑器启动前就位：轮询首个周期就应点亮徽标（面板保持关闭）
                write_suggestion({"for": full_bg, "items": [
                    {"type": "note", "text": "【验证】建议就绪徽标"}]})
            headless_case("aibadge", prepare=prep_bg, doc=full_bg)
        except Exception as e:
            add("HEADLESS", "aibadge", "FAIL", "准备失败: %s" % e)

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
    hist = DATA / "ai-history"   # 本次运行新产生的建议归档不残留；用户自己的归档不动
    if hist.is_dir():
        for p in hist.glob("*.json"):
            if p.name not in HIST_KEEP:
                try:
                    p.unlink()
                except Exception:
                    pass
    bdir = DATA / ".backup"      # verify 文档的自动备份一并清掉（目录名含 verify-）
    if bdir.is_dir():
        for d in bdir.glob("*verify*"):
            shutil.rmtree(d, ignore_errors=True)
    dp = DATA / "delivery.json"  # 投递状态 sidecar：只摘除 verify 键；文件非用户原有且已空则删除
    if dp.is_file():
        try:
            d = json.loads(dp.read_text(encoding="utf-8"))
            if isinstance(d, dict) and any("verify-" in k for k in d):
                d2 = {k: v for k, v in d.items() if "verify-" not in k}
                if d2:
                    dp.write_text(json.dumps(d2, ensure_ascii=False, indent=1), encoding="utf-8")
                else:
                    dp.unlink()
        except Exception:
            pass


def report():
    npass = sum(1 for _, _, s, _ in RESULTS if s == "PASS")
    nfail = sum(1 for _, _, s, _ in RESULTS if s == "FAIL")
    nskip = sum(1 for _, _, s, _ in RESULTS if s == "SKIP")
    print("RESULT: %d passed, %d failed, %d skipped" % (npass, nfail, nskip))
    return 1 if nfail else 0


def main():
    if "--static" in sys.argv[1:]:  # 快速静态门禁（git pre-commit 钩子用）：只跑 STATIC 层，秒级返回
        try:
            sec_static()
        except Exception as e:
            add("VERIFY", "脚本自身异常", "FAIL", "%s: %s" % (type(e).__name__, e))
        sys.exit(report())

    server_ok = False
    rb = sb = None
    try:
        sec_static()

        server_ok = ensure_server()
        hd = DATA / "ai-history"
        if hd.is_dir():
            HIST_KEEP.update(p.name for p in hd.glob("*.json"))
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

    sys.exit(report())


if __name__ == "__main__":
    main()
