#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简历可视化编辑工作台 - 本地服务（零第三方依赖）。

用法：python serve.py
→ 自动打开浏览器 http://127.0.0.1:8618/ 进入可视化编辑器。

API：
    GET  /api/list                  文档列表
    GET  /api/doc?name=主简历        读文档
    POST /api/save {name, doc}      保存文档
    POST /api/newjob {name}         复制主简历创建岗位副本
    POST /api/export {name}         渲染并打印 A4 PDF
    POST /api/ai-request {name, jd} 写入 AI 请求文件（由 ZCode 处理）
    GET  /api/ai-suggestion         读 AI 建议文件
    POST /api/upload-photo?ext=.jpg 上传照片到 data/（编辑器文件对话框配套，字节体）
"""

import json
import re
import shutil
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
JOBS = DATA / "jobs"
PORT = 8618

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


def write_doc(name, doc):
    p = doc_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def write_export_target(name):
    p = DATA / ".export-target.json"
    p.write_text(json.dumps({"name": safe_name(name)}, ensure_ascii=False), encoding="utf-8")


def start_server():
    return ThreadingHTTPServer(("127.0.0.1", PORT), Handler)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        pass  # 静默访问日志

    # ---------- 工具 ----------
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    # ---------- GET ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/list":
                docs = ["主简历"] + sorted(
                    "jobs/" + p.stem for p in JOBS.glob("*.json") if not p.name.startswith(".")
                ) if JOBS.is_dir() else ["主简历"]
                return self._json({"ok": True, "docs": docs})

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
                write_doc(body["name"], body["doc"])
                return self._json({"ok": True})

            if parsed.path == "/api/newjob":
                raw = str(body.get("name", "")).strip().strip("/")
                base = raw if raw.startswith("jobs/") else "jobs/" + raw
                safe = safe_name(base)
                master = read_doc("主简历")
                master["kind"] = "job"
                master["name"] = safe
                master["job"] = master.get("job") or {"jdText": "", "notes": ""}
                master.setdefault("meta", {})
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
                return self._json({"ok": True, "pdf": "/data/" + (name + ".pdf" if name != "主简历" else "主简历.pdf"),
                                   "pages_hint": doc.get("kind")})

            if parsed.path == "/api/ai-request":
                name = safe_name(body["name"])
                req = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "name": name,
                       "jd": body.get("jd", ""), "doc": read_doc(name)}
                p = DATA / "ai-request.json"
                p.write_text(json.dumps(req, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json({"ok": True, "file": "/data/ai-request.json"})
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
