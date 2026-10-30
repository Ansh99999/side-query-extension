#!/usr/bin/env python3
"""End-to-end terminal smoke check against a real Pi-Bolt binary, no external services."""
import argparse
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import threading
import time

ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>78]|\x1b[()][A-Z0-9]")
REPO = Path(__file__).resolve().parents[1]

class Terminal:
    def __init__(self, argv, env, cwd):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 92, 0, 0))
        self.buf = b""
        self.done = False

    def pump(self, timeout=.03):
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return False
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            return False
        self.buf += data
        if b"\x1b[c" in data:
            os.write(self.fd, b"\x1b[?62;22c")
        if b"\x1b]11;?" in data:
            os.write(self.fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        return True

    def send(self, data):
        os.write(self.fd, data)

    def text(self, since=0):
        return ANSI.sub(b"", self.buf[since:]).decode("utf-8", "replace")

    def wait(self, needle, since=0, seconds=12):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            if needle in self.text(since):
                return
        raise AssertionError(f"Terminal did not show {needle!r}: {self.text(since)[-4500:]}")

    def settle(self, seconds=.2):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.pump(.02)

    def step(self, name, keys, expected):
        mark = len(self.buf)
        self.send(keys)
        self.wait(expected, mark)
        self.settle()
        print(f"PASS {name}", flush=True)

    def finish(self):
        self.send(b"\x15/quit\r")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            self.pump()
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.done = True
                assert os.waitstatus_to_exitcode(status) == 0
                return
        raise AssertionError("Pi-Bolt did not quit")

    def close(self):
        if not self.done:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except ProcessLookupError:
                pass
        os.close(self.fd)

class Provider(http.server.BaseHTTPRequestHandler):
    requests = []
    def log_message(self, *args):
        pass
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        type(self).requests.append(request)
        system = "\n".join(str(m.get("content", "")) for m in request["messages"] if m["role"] == "system")
        user = next((m.get("content", "") for m in reversed(request["messages"]) if m["role"] == "user"), "")
        if isinstance(user, list):
            user = "".join(p.get("text", "") for p in user)
        title = "short plain title" in system or "at most six words" in system
        side = "private side conversation" in system
        last = request["messages"][-1]
        call = None
        if side and user in ("WRITE-DECLINE", "WRITE-APPROVE", "WRITE-CANCEL") and last["role"] == "user":
            call = ("request_main_action", {"toolName":"write", "args":{"path":"approved-marker.txt", "content":"approved from side\n"}, "summary":"Write the approved marker"})
        elif not side and str(user).startswith("The user approved one action") and last["role"] == "user":
            approval = re.search(r'approvalId "([\da-f-]+)"', user)
            assert approval, "Main bridge prompt has no approval ID"
            assert any(t.get("function", {}).get("name") == "btw_execute_approved" for t in request.get("tools", [])), "Main bridge is not declared"
            call = ("btw_execute_approved", {"approvalId":approval[1]})
        answer = "Startup investigation" if title else ("Main context marker saved." if user == "MAIN-CONTEXT" else "Main marker written." if not side and last["role"] == "tool" else "Main action request handled." if side and last["role"] == "tool" else "Side answer: " + str(user))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        try:
            if call:
                item = {"id":"fake", "object":"chat.completion.chunk", "created":0, "model":"offline-model", "choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"test-call", "type":"function", "function":{"name":call[0], "arguments":json.dumps(call[1])}}]},"finish_reason":None}]}
                self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
                self.wfile.write(("data: " + json.dumps({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}) + "\n\ndata: [DONE]\n\n").encode())
                self.wfile.flush()
                return
            if side and user == "STREAM-CANCEL":
                answer = "Partial answer kept."
            for chunk in [answer[:8], answer[8:]]:
                item = {"id":"fake", "object":"chat.completion.chunk", "created":0, "model":"offline-model", "choices":[{"index":0,"delta":{"content":chunk},"finish_reason":None}]}
                self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(.015)
            if side and user == "STREAM-CANCEL":
                time.sleep(2)
            self.wfile.write(("data: " + json.dumps({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

def run(binary, package):
    Provider.requests = []
    with tempfile.TemporaryDirectory(prefix="side-query-terminal-") as temporary:
        root = Path(temporary)
        agent, cwd, clean = root/"agent", root/"cwd", root/"extension"
        agent.mkdir(); cwd.mkdir()
        shutil.copytree(package, clean, ignore=shutil.ignore_patterns("node_modules", ".git", "artifacts", ".cache"))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        (agent/"settings.json").write_text(json.dumps({"packages":[str(clean)],"defaultProvider":"benchmark","defaultModel":"offline-model","lastChangelogVersion":"9999.0.0","quietStartup":True}))
        (agent/"auth.json").write_text("{}")
        (agent/"models.json").write_text(json.dumps({"providers":{"benchmark":{"baseUrl":origin+"/v1","api":"openai-completions","apiKey":"dummy-local-key","models":[{"id":"offline-model","name":"Offline model","input":["text"],"reasoning":False,"contextWindow":32000,"maxTokens":1024,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}))
        names = ["PATH","HOME","SHELL","TERM","LANG","LC_ALL","TZ","PREFIX","LD_LIBRARY_PATH","LD_PRELOAD","HTTP_PROXY","HTTPS_PROXY","NO_PROXY","http_proxy","https_proxy","no_proxy","SSL_CERT_FILE","NODE_EXTRA_CA_CERTS"]
        env = {key:os.environ[key] for key in names if key in os.environ}
        env.update({"PI_CODING_AGENT_DIR":str(agent),"PI_OFFLINE":"1","PI_TELEMETRY":"0","TERM":"xterm-256color","TMPDIR":str(root),"JITI_FS_CACHE":str(root/"jiti"),"NO_COLOR":"1"})
        argv = [binary,"--offline","--no-mcp","--no-skills","--no-prompt-templates","--no-context-files","--no-approve"]
        tty = Terminal([*argv,"--name","Pi-Bolt side query smoke"], env, str(cwd))
        try:
            tty.wait("offline-model")
            tty.settle(.4)
            assert len(Provider.requests) == 0, "Startup made provider requests"
            tty.step("main prompt", b"MAIN-CONTEXT\r", "Main context marker saved.")
            tty.step("/btw opens an empty tools-off side screen", b"/btw\r", "Tools off")
            tty.step("explicit side query streams a reply", b"Why is startup slow?\r", "Side answer: Why is startup slow?")
            tty.wait("Startup investigation")
            tty.settle(.3)
            side_requests = [r for r in Provider.requests if any("private side conversation" in str(m.get("content","")) for m in r["messages"])]
            assert len(side_requests) == 1
            assert not side_requests[0].get("tools"), "Tools-off side declares executable tools"
            assert "MAIN-CONTEXT" in str(side_requests[0]["messages"]), "Side lacks parent context"
            count = len(Provider.requests)
            tty.step("Escape once opens the boxed search list", b"\x1b", "Search titles")
            tty.step("Escape again returns to the main conversation", b"\x1b", "offline-model")
            tty.step("legacy Ctrl+/ resumes current side thread", b"\x1f", "Startup investigation")
            assert len(Provider.requests) == count, "Passive reopen started an AI request"
            tty.step("Alt+T enables tools for this thread", b"\x1bt", "Tools on")
            tty.send(b"unsent draft")
            tty.settle()
            tty.step("Ctrl+N creates another tools-off thread", b"\x0e", "New side conversation")
            assert len(Provider.requests) == count, "New blank thread started an AI request"
            tty.step("Ctrl+D requires deletion confirmation", b"\x04", "Delete side conversation?")
            tty.send(b"\r")
            tty.settle()
            assert "Tools off" in tty.text(), "Default Cancel deleted a thread"
            tty.step("deletion can be opened again", b"\x04", "Delete side conversation?")
            tty.step("confirmed deletion returns to list", b"\t\r", "Search titles")
            tty.send(b"Startup")
            tty.settle()
            tty.step("search and Enter reopen the retained thread", b"\r", "Tools on")
            tty.wait("unsent draft")
            tty.step("return to list after draft restoration", b"\x1b", "Tab search/list")
            tty.step("return to main after draft restoration", b"\x1b", "offline-model")
            tty.finish()
            saved = list((agent/"side-query").glob("*/*.json"))
            index = next(p for p in saved if p.name == "threads.json")
            summaries = json.loads(index.read_text())["threads"]
            assert len(summaries) == 1
            thread = json.loads((index.parent/(summaries[0]["id"]+".json")).read_text())
            assert thread["draft"] == "unsent draft"
            assert thread["toolsEnabled"] is True
            assert thread["titleGenerated"] is True
            session_text = "\n".join(p.read_text() for p in (agent/"sessions").rglob("*.jsonl"))
            assert "MAIN-CONTEXT" in session_text
            assert "Why is startup slow?" not in session_text, "Side messages polluted the main transcript"
            print("PASS saved drafts/title/tools, linked persistence, and main transcript isolation", flush=True)
            tty.close()
            count = len(Provider.requests)
            session = next((agent/"sessions").rglob("*.jsonl"))
            tty = Terminal([*argv,"--session",str(session)], env, str(cwd))
            tty.wait("offline-model")
            tty.settle(.4)
            tty.step("modern Ctrl+/ resumes a thread across process restart", b"\x1b[47;5u", "unsent draft")
            assert len(Provider.requests) == count, "Resume started a provider request"
            tty.step("/btw question from side chat creates another thread", b"\x15/btw Inline side question\r", "Side answer: Inline side question")
            tty.wait("Startup investigation")
            tty.settle(.3)
            tty.step("enable main-action requests", b"\x1bt", "Tools on")
            marker = cwd/"approved-marker.txt"
            tty.step("main change requires an exact confirmation", b"WRITE-DECLINE\r", "Allow main action?")
            tty.step("default Cancel declines a main action", b"\r", "Main action request handled.")
            assert not marker.exists(), "Declined action wrote a file"
            tty.settle(.2)
            tty.step("pending main confirmation can be cancelled locally", b"WRITE-CANCEL\r", "Allow main action?")
            tty.send(b"\x03")
            tty.settle(.3)
            assert not marker.exists(), "Cancelled approval wrote a file"
            tty.step("another exact main action can be requested", b"WRITE-APPROVE\r", "Allow main action?")
            tty.step("Allow once executes through the real main host", b"\t\r", "Completed: Write the approved marker")
            assert marker.read_text() == "approved from side\n"
            tty.settle(.3)
            tty.step("stream starts before cancellation", b"STREAM-CANCEL\r", "Partial answer kept.")
            tty.send(b"\x03")
            tty.settle(.4)
            tty.step("Escape once after cancellation shows list", b"\x1b", "Search titles")
            tty.step("Escape twice after cancellation shows main", b"\x1b", "offline-model")
            tty.step("main /btw question opens a fresh tools-off thread", b"/btw Main inline question\r", "Side answer: Main inline question")
            tty.settle(.3)
            tty.step("another streaming query can start", b"STREAM-CANCEL\r", "Partial answer kept.")
            tty.step("exit final thread to list", b"\x1b", "Search titles")
            tty.step("exit final list to main", b"\x1b", "offline-model")
            tty.settle(.4)
            tty.finish()
            summaries = json.loads(index.read_text())["threads"]
            assert len(summaries) == 3, "/btw did not always create a new thread"
            transcripts = [json.loads((index.parent/(s["id"]+".json")).read_text()) for s in summaries]
            action_thread = next(t for t in transcripts if any(m["role"] == "user" and "WRITE-APPROVE" in str(m.get("content")) for m in t["messages"]))
            assert any(m.get("customType") == "side-query-main-action" and "Completed:" in m.get("content", "") for m in action_thread["messages"]), "Actual result missing from side transcript"
            assert any(m["role"] == "assistant" and m.get("stopReason") == "aborted" and "Partial answer kept." in str(m.get("content")) for m in action_thread["messages"]), "Cancellation lost streamed text"
            session_text = session.read_text()
            assert "side-query-main-action" in session_text and "btw_execute_approved" in session_text
            assert "WRITE-DECLINE" not in session_text and "Inline side question" not in session_text
            assert any("Successfully wrote" in str(m.get("content", "")) for r in Provider.requests for m in r["messages"] if m["role"] == "tool"), "Main host never returned the native bridge result"
            main_results = [r for r in Provider.requests if any(m["role"] == "tool" and "Successfully wrote" in str(m.get("content", "")) for m in r["messages"])]
            assert main_results and all(not any(t.get("function", {}).get("name") == "btw_execute_approved" for t in r.get("tools", [])) for r in main_results), "Bridge stayed in the main loadout after completion"
            print("PASS main action approval/cancel/execution, partial cancellation, /btw new threads, and restart", flush=True)
            tty.close()
            count = len(Provider.requests)
            tty = Terminal([*argv,"--session-id","00000000-0000-4000-8000-000000000001"], env, str(cwd))
            tty.wait("offline-model")
            tty.settle(.3)
            tty.send(b"main unsent draft")
            tty.settle()
            tty.step("a different main session has an empty side list", b"\x1f", "No side threads yet.")
            assert len(Provider.requests) == count, "Empty list made a provider request"
            tty.step("Escape returns to main with its editor draft intact", b"\x1b", "main unsent draft")
            tty.finish()
        except Exception:
            print(tty.text()[-12000:])
            raise
        finally:
            tty.close(); server.shutdown(); server.server_close()

if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary",default="pi-bolt")
    parser.add_argument("--package",type=Path,default=REPO)
    args=parser.parse_args()
    run(args.binary,args.package.resolve())
