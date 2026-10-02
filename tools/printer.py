#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PDF 打印引擎：通过系统 Edge/Chrome 无头模式打印编辑器预览页。

安全说明（Mimosa 适配）：subprocess 参数列表 + shell=False，argv 全部为字面量
常量——浏览器路径按探测结果走 if/elif 分支内联，URL 与输出路径直接写进开关，
不含任何变量或拼接。项目移动/改名后需同步更新下方常量（有启动校验）。
"""

import subprocess
from pathlib import Path

PORT = 8618
EXPORT_URL = "http://127.0.0.1:8618/app/preview.html?print=1"
EXPORT_PDF = r"C:\Users\30127\Desktop\简历快速调整编辑\tools\.build-work\简历.pdf"
PROFILE_DIR = r"C:\Users\30127\Desktop\简历快速调整编辑\tools\.build-work\pprofile"

BROWSER_LABEL = {"edge86": "Edge", "edge64": "Edge", "chrome64": "Chrome", "chrome86": "Chrome"}


def browser_kind():
    for kind, path in (
        ("edge86", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        ("edge64", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ("chrome64", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        ("chrome86", r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    ):
        if Path(path).is_file():
            return kind
    return None


def check_project_location(root):
    """argv 中的输出路径是硬编码字面量，项目移动后必须同步修改。"""
    if Path(root).resolve() != Path(EXPORT_PDF).parents[2]:
        return False
    return True


def print_current():
    """打印 preview.html?print=1（它自己读取导出目标），产出固定路径 PDF。"""
    pdf = Path(EXPORT_PDF)
    pdf.parent.mkdir(parents=True, exist_ok=True)
    if pdf.exists():
        pdf.unlink()
    kind = browser_kind()
    if not kind:
        return False, "标准安装位没有找到 Edge / Chrome"
    if kind == "edge86":
        subprocess.run(
            [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
             "--headless", "--disable-gpu", "--no-sandbox",
             "--user-data-dir=" + PROFILE_DIR,
             "--virtual-time-budget=8000", "--no-pdf-header-footer", "--print-to-pdf-no-header",
             "--print-to-pdf=C:\\Users\\30127\\Desktop\\简历快速调整编辑\\tools\\.build-work\\简历.pdf",
             "http://127.0.0.1:8618/app/preview.html?print=1"],
            capture_output=True, timeout=120, shell=False)
    elif kind == "edge64":
        subprocess.run(
            [r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
             "--headless", "--disable-gpu", "--no-sandbox",
             "--user-data-dir=" + PROFILE_DIR,
             "--virtual-time-budget=8000", "--no-pdf-header-footer", "--print-to-pdf-no-header",
             "--print-to-pdf=C:\\Users\\30127\\Desktop\\简历快速调整编辑\\tools\\.build-work\\简历.pdf",
             "http://127.0.0.1:8618/app/preview.html?print=1"],
            capture_output=True, timeout=120, shell=False)
    elif kind == "chrome64":
        subprocess.run(
            [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
             "--headless", "--disable-gpu", "--no-sandbox",
             "--user-data-dir=" + PROFILE_DIR,
             "--virtual-time-budget=8000", "--no-pdf-header-footer", "--print-to-pdf-no-header",
             "--print-to-pdf=C:\\Users\\30127\\Desktop\\简历快速调整编辑\\tools\\.build-work\\简历.pdf",
             "http://127.0.0.1:8618/app/preview.html?print=1"],
            capture_output=True, timeout=120, shell=False)
    else:
        subprocess.run(
            [r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
             "--headless", "--disable-gpu", "--no-sandbox",
             "--user-data-dir=" + PROFILE_DIR,
             "--virtual-time-budget=8000", "--no-pdf-header-footer", "--print-to-pdf-no-header",
             "--print-to-pdf=C:\\Users\\30127\\Desktop\\简历快速调整编辑\\tools\\.build-work\\简历.pdf",
             "http://127.0.0.1:8618/app/preview.html?print=1"],
            capture_output=True, timeout=120, shell=False)
    if pdf.exists() and pdf.stat().st_size > 500:
        return True, str(pdf)
    return False, "PDF 未生成（预览页加载失败或浏览器异常）"
