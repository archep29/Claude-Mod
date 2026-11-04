"""최근 30일 Claude 세션목록을 JSON으로 출력한다 (세션목록 패널이 부른다).

출력: {"account": 1|2, "wt": wt.exe 경로, "launcher": 전용 실행 파일(없으면 ""), "sessions":[{id, cwd, title, started, updated, running}]}
- cwd·시작 시각: 대화 기록 앞부분의 첫 user 줄
- 제목: 패널에서 ✎로 바꾼 이름, 없으면 기록 끝부분의 마지막 custom-title(/rename), ai-title(AI가 지은 제목), 첫 질문 글자 순
- running: 이 PC에서 지금 켜져 있는 세션(sessions/*.json의 pid가 살아 있음)

`--rename 세션ID 이름`으로 부르면 ✎ 이름만 저장한다(빈 이름이면 지운다).
"""
import ctypes
import glob
import json
import os
import socket
import sys
import time

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
SESSION_DIRS = [os.path.join(HOME, d, "sessions")
                for d in (".claude", ".claude-account1", ".claude-account2")]
# ✎ 이름. 패널 저장소($.store)는 탭마다 들고 있던 옛 값으로 통째로 덮어써 이름이 날아가서 따로 둔다.
# 두 계정이 같이 쓰고, .claude 동기화로 다른 PC에도 간다.
NAMES = os.path.join(HOME, ".claude", "plugins", "mod-session-list-names.json")
DAYS = 30
# 이 파일이 있는 PC는 이것으로 세션을 열고(계정 선택·탭 기억), 없으면 claude --resume으로 연다.
LAUNCHER = r"D:\dev\claude-launcher.ps1"
TAIL_BYTES = 512 * 1024


def is_alive(pid):
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    kernel32.CloseHandle(handle)
    return bool(ok) and code.value == 259  # STILL_ACTIVE


def running_sessions():
    """이 PC에서 켜져 있는 세션 id들."""
    domain = "win32:" + socket.gethostname().lower()
    found = set()
    for folder in SESSION_DIRS:
        for path in glob.glob(os.path.join(folder, "*.json")):
            try:
                with open(path, encoding="utf-8") as f:
                    info = json.load(f)
            except (OSError, ValueError):
                continue
            if str(info.get("pidDomain", "")).lower() != domain:
                continue
            pid = info.get("pid")
            sid = info.get("sessionId")
            if isinstance(pid, int) and sid and is_alive(pid):
                found.add(sid)
    return found


def user_text(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        content = " ".join(c.get("text", "") for c in content
                           if isinstance(c, dict) and c.get("type") == "text")
    return content.strip() if isinstance(content, str) else ""


def read_head(path):
    """첫 user 줄의 cwd·시각과 첫 질문 글자."""
    cwd = started = first_prompt = ""
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i > 400:
                break
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get("type") != "user":
                continue
            if not cwd:
                cwd = entry.get("cwd") or ""
                started = entry.get("timestamp") or ""
            text = user_text(entry)
            if text and not text.startswith("<"):
                first_prompt = text.splitlines()[0][:60]
                break
    return cwd, started, first_prompt


def read_title(path):
    """기록 끝부분에서 마지막 custom-title, 없으면 마지막 ai-title."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        f.seek(max(0, size - TAIL_BYTES))
        tail = f.read().decode("utf-8", errors="replace")
    ai_title = ""
    for line in reversed(tail.splitlines()):
        if '"custom-title"' not in line and '"ai-title"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") == "custom-title" and entry.get("customTitle"):
            return entry["customTitle"]
        if not ai_title and entry.get("type") == "ai-title":
            ai_title = entry.get("aiTitle") or ""
    return ai_title


def load_names():
    try:
        with open(NAMES, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_name(sid, name):
    """그때그때 파일을 새로 읽어 이 세션 이름만 바꾼다(다른 탭이 바꾼 이름은 그대로)."""
    names = load_names()
    if name:
        names[sid] = name
    else:
        names.pop(sid, None)
    os.makedirs(os.path.dirname(NAMES), exist_ok=True)
    tmp = NAMES + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(names, f, ensure_ascii=False, indent=1)
    os.replace(tmp, NAMES)


def main():
    cutoff = time.time() - DAYS * 86400
    running = running_sessions()
    names = load_names()
    sessions = []
    for path in glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")):
        try:
            updated = os.path.getmtime(path)
            if updated < cutoff:
                continue
            cwd, started, first_prompt = read_head(path)
            if not cwd:
                continue  # 대화가 없는 빈 기록
            sid = os.path.splitext(os.path.basename(path))[0]
            title = names.get(sid) or read_title(path) or first_prompt or sid[:8]
        except OSError:
            continue
        sessions.append({
            "id": sid,
            "cwd": cwd,
            "title": title,
            "started": started,
            "updated": int(updated * 1000),
            "running": sid in running,
        })
    config = os.environ.get("CLAUDE_CONFIG_DIR", "")
    account = 2 if config.rstrip("\\/").endswith("account2") else 1
    wt = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WindowsApps", "wt.exe")
    launcher = LAUNCHER if os.path.isfile(LAUNCHER) else ""
    sys.stdout.write(json.dumps({"account": account, "wt": wt, "launcher": launcher, "sessions": sessions},
                                ensure_ascii=False))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) == 4 and sys.argv[1] == "--rename":
        save_name(sys.argv[2], sys.argv[3].strip())
    else:
        main()
