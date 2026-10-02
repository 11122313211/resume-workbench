#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""命令行导出：python export.py 主简历 | python export.py jobs/某岗位
内部临时启动本地服务后调用无头浏览器打印（与编辑器"导出 PDF"同一引擎）。"""

import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import printer  # noqa: E402
import serve  # noqa: E402


def main():
    if not printer.check_project_location(serve.ROOT):
        print("项目被移动/改名：请更新 tools/printer.py 顶部路径常量。")
        sys.exit(1)
    name = serve.safe_name(sys.argv[1] if len(sys.argv) > 1 else "主简历")
    serve.DATA.mkdir(exist_ok=True)
    serve.JOBS.mkdir(exist_ok=True)

    httpd = serve.start_server()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    time.sleep(0.4)

    serve.write_export_target(name)
    ok, info = printer.print_current()
    if not ok:
        print("导出失败：%s" % info)
        sys.exit(1)
    stem = "主简历" if name == "主简历" else name.split("/", 1)[1]
    out = (serve.JOBS if name != "主简历" else serve.DATA) / (stem + ".pdf")
    shutil.copyfile(printer.EXPORT_PDF, out)
    print("已导出：%s" % out)


if __name__ == "__main__":
    main()
