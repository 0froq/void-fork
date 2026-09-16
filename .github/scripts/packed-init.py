"""Drive the real interactive initializer in a disposable packed-package fixture."""
import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

directory, framework, manager, version = sys.argv[1:]
frameworks = ["react", "vue", "svelte", "solid"]
assert framework in frameworks
assert manager in ["npm", "pnpm"]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 180, 0, 0))
environment = dict(os.environ)
environment.pop("CI", None)
environment["TERM"] = "xterm-256color"
name = os.path.basename(directory)
command = (["npm", "exec", "--yes", f"--package=create-void@{version}", "--", "create-void", name]
           if manager == "npm" else ["pnpm", "dlx", f"create-void@{version}", name])
process = subprocess.Popen(
    command, cwd=os.path.dirname(directory), env=environment,
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
responses = [
    (b"Choose a Pages scaffold toolchain:", b"\x1b[B\r"),
    (b"Choose a Pages framework to scaffold:", b"\x1b[B" * frameworks.index(framework) + b"\r"),
    (b"Choose a Pages starter:", b"\r"),
    (b"Could not detect your coding agent. Which one are you using?", b"\x1b[B" * 4 + b"\r"),
    (b"Where should this project deploy?", b"\x1b[B\x1b[B\r"),
]
seen = set()
buffer = b""
deadline = time.monotonic() + 240

def interrupted(_signum, _frame):
    raise RuntimeError("Packed initializer interrupted")

signal.signal(signal.SIGTERM, interrupted)
try:
    while process.poll() is None:
        if time.monotonic() > deadline:
            raise TimeoutError("The initializer stalled or introduced an unhandled prompt")
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        buffer = (buffer + data)[-131072:]
        plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", buffer)
        for prompt, response in responses:
            if prompt not in seen and prompt in plain:
                seen.add(prompt)
                os.write(master, response)
    code = process.wait(timeout=10)
    if code:
        raise RuntimeError(f"Initializer exited with {code}")
    for prompt, _ in responses:
        if prompt.startswith(b"Could not detect"):
            continue
        assert prompt in seen, f"The initializer skipped {prompt!r}"
finally:
    os.close(master)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
