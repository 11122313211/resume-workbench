#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简历可视化编辑工作台 - 本地服务（零第三方依赖）。

用法：python serve.py
→ 自动打开浏览器 http://127.0.0.1:8618/ 进入可视化编辑器。

API：
    GET  /api/ping                  存活探测 + serve.py 版本指纹（verify 识别过期进程用）
    GET  /api/list                  文档列表
    GET  /api/doc?name=主简历        读文档
    POST /api/save {name, doc}      保存文档（覆盖前旧版本自动留底 data/.backup/，每文档保留 10 份）
    POST /api/delete {name}         删除岗位副本（主简历不可删，连带清理同名 PDF）
    POST /api/rename {from,to}      岗位副本改名（主简历不可改，目标重名拒绝；PDF 跟随改名）
    POST /api/newjob {name}         复制主简历创建岗位副本
    POST /api/export {name}         渲染并打印 A4 PDF
    POST /api/ai-request {name, jd} 写入 AI 请求文件（含给 agent 的完整指令 agentPrompt 与输出协议）
    GET  /api/ai-suggestion         读 AI 建议文件
    GET  /api/ai-history            历史建议归档列表（data/ai-history/，最近 20 份）
    GET  /api/backups?name=文档      该文档的自动备份列表（倒序，恢复选择用）
    POST /api/restore {name, file}  用备份覆盖文档（当前内容先自动留底，可再恢复回来）
    POST /api/upload-photo?ext=.jpg 上传照片到 data/（编辑器文件对话框配套，字节体）
"""

import hashlib
import json
import re
import shutil
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
JOBS = DATA / "jobs"
PORT = 8618
APIV = 2  # API 协议版本：行为有变必须 +1 并同步 tools/verify.py 的 EXPECTED_APIV（旧进程靠它现形）

sys.path.insert(0, str(ROOT / "tools"))
import printer  # noqa: E402


def log(msg):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    print(msg, flush=True)


def safe_name(n):
    """允许：主简历 / jobs/xxx（中文、字母数字下划线连字符）。"""
    n = (n or "").strip().strip("/")
    if n == "主简历":
        return n
    if re.fullmatch(r"jobs/[\w\-]{1,80}", n) and re.search(r"[\w]", n):
        return n
    raise ValueError("非法文档名：%r" % n)


def doc_path(name):
    return DATA / (safe_name(name) + ".json")


def read_doc(name):
    return json.loads(doc_path(name).read_text(encoding="utf-8"))


BACKUP_KEEP = 10  # 每份文档保留的自动备份份数


def backup_doc(name, old_text):
    """覆盖保存前把旧版本留底到 data/.backup/<文档名>/<时间戳>.json，超出 BACKUP_KEEP 自动淘汰。"""
    bdir = DATA / ".backup" / safe_name(name).replace("/", "_")
    bdir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int((time.time() % 1) * 1000)
    (bdir / (stamp + ".json")).write_text(old_text, encoding="utf-8")
    for old in sorted(bdir.glob("*.json"))[:-BACKUP_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass


def write_doc(name, doc):
    p = doc_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.is_file():  # 只在覆盖已有内容时留底；首次创建没有旧版本可言
        backup_doc(name, p.read_text(encoding="utf-8"))
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def write_export_target(name):
    p = DATA / ".export-target.json"
    p.write_text(json.dumps({"name": safe_name(name)}, ensure_ascii=False), encoding="utf-8")


DELIV_ST = ("未投", "已投", "面试", "通过", "挂")   # 投递状态胶囊循环顺序（R33）


def read_delivery():
    # 投递状态 sidecar：独立于简历文档 JSON——状态切换不碰内容、不触发留底、不污染导出戳
    p = DATA / "delivery.json"
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def write_delivery(d):
    (DATA / "delivery.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")


def start_server():
    return ThreadingHTTPServer(("127.0.0.1", PORT), Handler)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    # ---------- 工具 ----------
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 本地工具：杜绝旧缓存与新页面混跑
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 20 * 1024 * 1024:  # 文档 JSON 体积的上限防护：异常客户端不允许吃满内存
            while n > 0:  # 丢弃已声明的请求体，保证 400 响应能被客户端完整收到
                chunk = self.rfile.read(min(n, 65536))
                if not chunk:
                    break
                n -= len(chunk)
            raise ValueError("请求体过大（>20MB）")
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    # ---------- GET ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/ping":
                # 版本指纹：apiv 为协议版本（verify 据此识别陈旧进程并自动替换）；
                # rev 为代码指纹（每次请求现读磁盘，仅供参考，不用于陈旧判断——旧进程会谎报）
                return self._json({"ok": True, "apiv": APIV,
                                   "rev": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:10]})

            if parsed.path == "/api/list":
                docs = ["主简历"] + sorted(
                    "jobs/" + p.stem for p in JOBS.glob("*.json") if not p.name.startswith(".")
                ) if JOBS.is_dir() else ["主简历"]
                # 导出状态可见性（R24）：savedAt/exportedAt 均为服务端时钟，客户端只做字符串比较
                meta = {}
                for n in docs:
                    try:
                        m = read_doc(n).get("meta") or {}
                    except Exception:
                        continue
                    if m.get("exportedAt") or m.get("savedAt") or m.get("masterAt"):
                        meta[n] = {"exportedAt": m.get("exportedAt"), "savedAt": m.get("savedAt"),
                                   "masterAt": m.get("masterAt")}
                return self._json({"ok": True, "docs": docs, "meta": meta, "delivery": read_delivery()})

            if parsed.path == "/api/doc":
                name = parse_qs(parsed.query).get("name", [""])[0]
                return self._json(read_doc(name))

            if parsed.path == "/api/export-target":
                p = DATA / ".export-target.json"
                return self._json(json.loads(p.read_text(encoding="utf-8")))

            if parsed.path == "/api/ai-suggestion":
                p = DATA / "ai-suggestion.json"
                if not p.is_file():
                    return self._json({"ok": True, "items": []})
                return self._json(json.loads(p.read_text(encoding="utf-8")))

            if parsed.path == "/api/ai-history":
                hist_dir = DATA / "ai-history"
                items = []
                if hist_dir.is_dir():
                    for p in sorted(hist_dir.glob("*.json"), reverse=True)[:20]:
                        try:
                            d = json.loads(p.read_text(encoding="utf-8"))
                            items.append({"file": p.name, "for": d.get("for", ""),
                                          "count": len(d.get("items") or [])})
                        except Exception:
                            pass
                return self._json({"ok": True, "items": items})

            if parsed.path == "/api/backups":
                # 历史备份列表（R25）：write_doc 每次覆盖保存前留底，这里倒序供恢复选择
                name = safe_name(parse_qs(parsed.query).get("name", [""])[0])
                bdir = DATA / ".backup" / name.replace("/", "_")
                items = []
                if bdir.is_dir():
                    for p in sorted(bdir.glob("*.json"), reverse=True):
                        m = re.match(r"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})", p.stem)
                        ts = "%s-%s-%s %s:%s:%s" % m.groups() if m else p.stem
                        items.append({"file": p.name, "ts": ts})
                return self._json({"ok": True, "items": items})

            if parsed.path == "/":
                self.send_response(302)
                self.send_header("Location", "/app/index.html")
                self.end_headers()
                return
        except ValueError as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        except FileNotFoundError:
            return self._json({"ok": False, "error": "文档不存在"}, 404)
        return super().do_GET()

    # ---------- POST ----------
    def _upload_photo(self, parsed):
        """编辑器「选择照片」上传：原始字节体，文件名由服务端生成，落盘 data/。"""
        ext = (parse_qs(parsed.query).get("ext", [""])[0] or "").lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            return self._json({"ok": False, "error": "仅支持 jpg/png/webp/gif"}, 400)
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 5 * 1024 * 1024:
            return self._json({"ok": False, "error": "图片为空或超过 5MB"}, 400)
        blob = self.rfile.read(n)
        name = "photo-%s%s" % (time.strftime("%Y%m%d-%H%M%S"), ext)
        (DATA / name).write_bytes(blob)
        return self._json({"ok": True, "name": name})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/upload-photo":
                return self._upload_photo(parsed)
            body = self._body()
            if parsed.path == "/api/save":
                if isinstance(body.get("doc"), dict):
                    d = body["doc"]
                    try:
                        prev_meta = read_doc(body["name"]).get("meta") or {}
                    except Exception:
                        prev_meta = {}
                    m = d.setdefault("meta", {})
                    # exportedAt 由服务端独占保管：客户端内存里的 doc 可能不含它，保存不能抹掉导出记录
                    if not m.get("exportedAt") and prev_meta.get("exportedAt"):
                        m["exportedAt"] = prev_meta["exportedAt"]
                    m["savedAt"] = datetime.now().isoformat(timespec="seconds")
                write_doc(body["name"], body["doc"])
                return self._json({"ok": True})

            if parsed.path == "/api/delete":
                # 仅允许删除岗位副本；主简历明确禁删。连带清理已导出的同名 PDF。
                name = safe_name(str(body.get("name", "")))
                if name == "主简历":
                    return self._json({"ok": False, "error": "主简历不可删除"}, 400)
                p = doc_path(name)
                if not p.is_file():
                    return self._json({"ok": False, "error": "文档不存在"}, 404)
                p.unlink()
                pdf = JOBS / (name.split("/", 1)[1] + ".pdf")
                if pdf.is_file():
                    pdf.unlink()
                d = read_delivery()
                if d.pop(name, None) is not None:
                    write_delivery(d)
                return self._json({"ok": True})

            if parsed.path == "/api/rename":
                # 岗位副本改名：JSON 与同名 PDF 一起跟走；主简历不可改名，目标名已存在则拒绝。
                frm = safe_name(str(body.get("from", "")))
                raw = str(body.get("to", "")).strip().strip("/")
                to = safe_name(raw if raw.startswith("jobs/") else "jobs/" + raw)
                if frm == "主简历" or to == "主简历" or not frm.startswith("jobs/") or not to.startswith("jobs/"):
                    return self._json({"ok": False, "error": "仅岗位副本可以改名"}, 400)
                if frm == to:
                    return self._json({"ok": True, "name": to})
                if frm.casefold() == to.casefold():
                    # Windows 文件系统不区分大小写：写新读旧会静默丢数据，宁可诚实拒绝
                    return self._json({"ok": False, "error": "仅大小写不同的名称在本系统不可用"}, 400)
                src, dst = doc_path(frm), doc_path(to)
                if not src.is_file():
                    return self._json({"ok": False, "error": "文档不存在"}, 404)
                if dst.is_file():
                    return self._json({"ok": False, "error": "同名副本已存在"}, 400)
                doc = read_doc(frm)
                doc["name"] = to
                write_doc(to, doc)
                src.unlink()
                old_pdf = JOBS / (frm.split("/", 1)[1] + ".pdf")
                if old_pdf.is_file():
                    old_pdf.replace(JOBS / (to.split("/", 1)[1] + ".pdf"))
                d = read_delivery()          # 投递状态跟随改名，投递记录不因改名丢失
                if frm in d:
                    d[to] = d.pop(frm)
                    write_delivery(d)
                # 备份历史跟随改名（R41）：留底目录以文档名为键，不迁移的话改名即与历史断联，
                # 「历史备份」弹窗在新名下变空；目标目录已存在（同名旧档残留）则合入不冲突的文件
                bsrc = DATA / ".backup" / frm.replace("/", "_")
                bdst = DATA / ".backup" / to.replace("/", "_")
                if bsrc.is_dir():
                    bdst.mkdir(parents=True, exist_ok=True)
                    for f in bsrc.iterdir():
                        if f.is_file() and not (bdst / f.name).exists():
                            shutil.move(str(f), str(bdst / f.name))
                return self._json({"ok": True, "name": to})

            if parsed.path == "/api/delivery":
                # 投递状态跟踪（R33）：点击胶囊循环推进，sidecar 记录；未投=默认态不占存储
                name = safe_name(str(body.get("name", "")))
                st = str(body.get("st", ""))
                if st not in DELIV_ST:
                    return self._json({"ok": False, "error": "状态不合法"}, 400)
                if not doc_path(name).is_file():
                    return self._json({"ok": False, "error": "文档不存在"}, 404)
                d = read_delivery()
                if st == "未投":
                    d.pop(name, None)
                else:
                    d[name] = {"st": st, "at": datetime.now().isoformat(timespec="seconds")}
                write_delivery(d)
                return self._json({"ok": True, "delivery": d})

            if parsed.path == "/api/restore":
                # 用自动备份覆盖文档（R25）：文件名白名单校验防目录穿越；当前内容经 write_doc 先自动留底
                name = safe_name(str(body.get("name", "")))
                fn = str(body.get("file", ""))
                if not re.match(r"^\d{8}-\d{6}-\d{3}\.json$", fn):
                    return self._json({"ok": False, "error": "备份文件名不合法"}, 400)
                bdir = DATA / ".backup" / name.replace("/", "_")
                bp = bdir / fn
                if not bp.is_file():
                    return self._json({"ok": False, "error": "备份不存在"}, 404)
                try:
                    doc = json.loads(bp.read_text(encoding="utf-8"))
                except Exception:
                    return self._json({"ok": False, "error": "备份内容不是有效 JSON"}, 400)
                if not isinstance(doc, dict):
                    return self._json({"ok": False, "error": "备份内容格式异常"}, 400)
                doc["name"] = name
                write_doc(name, doc)
                return self._json({"ok": True})

            if parsed.path == "/api/newjob":
                raw = str(body.get("name", "")).strip().strip("/")
                base = raw if raw.startswith("jobs/") else "jobs/" + raw
                safe = safe_name(base)
                master = read_doc("主简历")
                master["kind"] = "job"
                master["name"] = safe
                master["job"] = master.get("job") or {"jdText": "", "notes": ""}
                m = master.get("meta")
                if isinstance(m, dict):  # 新副本从未保存/导出：清掉从主简历继承的状态戳
                    m.pop("savedAt", None)
                    m.pop("exportedAt", None)
                master.setdefault("meta", {})
                master["meta"]["masterAt"] = datetime.now().isoformat(timespec="seconds")  # 漂移检测锚点：主简历此后再保存 → 该副本显示 ↑ 提示
                write_doc(safe, master)
                return self._json({"ok": True, "name": safe})

            if parsed.path == "/api/export":
                name = safe_name(body["name"])
                doc = read_doc(name)
                write_export_target(name)
                ok, info = printer.print_current()
                if not ok:
                    return self._json({"ok": False, "error": info})
                stem = "主简历" if name == "主简历" else name.split("/", 1)[1]
                out = (JOBS if name != "主简历" else DATA) / (stem + ".pdf")
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(printer.EXPORT_PDF, out)
                # 导出状态戳：exportedAt=本次导出时间，savedAt 对齐同一秒，避免跨秒误报「有改动」
                now = datetime.now().isoformat(timespec="seconds")
                doc = read_doc(name)
                doc.setdefault("meta", {})["exportedAt"] = now
                doc["meta"]["savedAt"] = now
                write_doc(name, doc)
                return self._json({"ok": True, "pdf": "/data/" + (name + ".pdf" if name != "主简历" else "主简历.pdf"),
                                   "pages_hint": doc.get("kind")})

            if parsed.path == "/api/ai-request":
                name = safe_name(body["name"])
                doc = read_doc(name)
                mode = "job" if doc.get("kind") == "job" else "master"
                # 新请求作废旧建议，但先归档到 data/ai-history/（保留最近 20 份，上一轮建议不丢）
                stale = DATA / "ai-suggestion.json"
                if stale.is_file():
                    hist_dir = DATA / "ai-history"
                    hist_dir.mkdir(exist_ok=True)
                    tag = re.sub(r"[^\w\-]", "_", name)
                    shutil.copyfile(stale, hist_dir / (time.strftime("%Y%m%d-%H%M%S") + "-" + tag + ".json"))
                    stale.unlink()
                    olds = sorted(hist_dir.glob("*.json"))
                    for old in olds[:-20]:
                        old.unlink()
                # 输出协议：写进请求文件，任何全新 agent 会话照此即可干对活
                output = {
                    "file": "data/ai-suggestion.json",
                    "format": {
                        "for": name,
                        "items": [
                            {"type": "rewrite|hide|show|note",
                             "target": "简历条目的 id（见 doc）",
                             "text": "type=rewrite 时的完整改写文本",
                             "reason": "一句话理由"},
                        ],
                    },
                }
                mode_tip = ("岗位版目标是 A4 一页，优先用 hide 隐藏与岗位弱相关的条目。"
                            if mode == "job" else
                            "主简历求全，重点是结构完善与表达提升。")
                agent_prompt = (
                    "你是资深简历优化顾问。项目根目录（绝对路径）：" + str(ROOT) + "\n"
                    "请严格按以下三步操作：\n"
                    "1. 读取 data/ai-request.json：jd 是岗位 JD 原文，doc 是简历全文，"
                    "每个章节/条目/成果都带 id（建议的 target 必须使用这些 id）。\n"
                    "2. 只产出优化建议，禁止修改任何简历文件：data/主简历.json 与 data/jobs/*.json 一律不要写。\n"
                    "3. 把建议写入 data/ai-suggestion.json（UTF-8 编码的 JSON），格式如下"
                    "（for 必须是本文档名 \"" + name + "\"）：\n"
                    + json.dumps(output["format"], ensure_ascii=False, indent=2) + "\n"
                    "质量要求：\n"
                    "- type 取值：rewrite=改写（text 填完整改写文本）、hide=建议隐藏、show=建议恢复显示、note=说明。\n"
                    "- rewrite 的 text 以动词开头并包含量化结果；每条 reason 用一句话说明理由。\n"
                    "- " + mode_tip + "\n"
                    "- 共 5~10 条，宁缺毋滥。\n"
                    "写完 data/ai-suggestion.json 即结束，工作台会自动检测并展示建议。"
                )
                req = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "name": name, "mode": mode,
                       "jd": body.get("jd", ""), "doc": doc, "for": name,
                       "output": output, "agentPrompt": agent_prompt}
                p = DATA / "ai-request.json"
                tmp = p.with_suffix(".tmp")  # 原子写：tmp + replace，agent 不会读到半截文件
                tmp.write_text(json.dumps(req, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(p)
                return self._json({"ok": True, "file": "/data/ai-request.json", "agentPrompt": agent_prompt})
        except ValueError as e:
            return self._json({"ok": False, "error": str(e)}, 400)
        except FileNotFoundError:
            return self._json({"ok": False, "error": "文档不存在"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 500)
        return self._json({"ok": False, "error": "未知接口"}, 404)


def already_running():
    """Windows 下 SO_REUSEADDR 允许双绑，绑定前的连接探测才是可靠的单实例判断。"""
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    if not printer.check_project_location(ROOT):
        log("项目被移动/改名：请更新 tools/printer.py 顶部的路径常量。")
        sys.exit(1)
    DATA.mkdir(exist_ok=True)
    JOBS.mkdir(exist_ok=True)
    if already_running():
        log("工作台已在运行，直接打开页面。")
        webbrowser.open("http://127.0.0.1:%d/app/index.html" % PORT)
        return
    httpd = start_server()
    log("编辑器已启动：http://127.0.0.1:%d/app/index.html  （Ctrl+C 退出）" % PORT)
    threading.Timer(0.6, lambda: webbrowser.open("http://127.0.0.1:%d/app/index.html" % PORT)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已退出")


if __name__ == "__main__":
    main()
