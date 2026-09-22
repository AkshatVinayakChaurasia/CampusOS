# Intelligent Digital Campus Ecosystem

A terminal program for an Operating Systems course. It reads **live data from
the machine it runs on** — the kernel's own process table, its CPU tick
counters, its memory accounting, its inodes — and presents it the way the OS
syllabus talks about it.

The campus is the computer: its processes are the campus services, its memory
is the campus memory, its files are the campus records.

There is no web server and no browser. It runs in a terminal, which is also
where an operating system is normally observed from.

---

## Status — Phase 1 of 4 (about 25% complete)

Three of the nine planned modules are built. This is deliberate: the modules
below are the ones everything else reads from, so they were built first.

| # | Module | State |
|---|---|---|
| 1 | System Information | **built** |
| 2 | Process Table | **built** — read-only |
| 3 | File Management | **built** |
| 4 | Process Control (suspend / resume / terminate) | planned — Phase 2 |
| 5 | CPU Scheduling (FCFS, SJF, SRTF, Round Robin, Priority) | planned — Phase 2 |
| 6 | Memory Management (first / best / worst fit) | planned — Phase 3 |
| 7 | Deadlock Detection (Banker's algorithm) | planned — Phase 3 |
| 8 | Resource Management (disk, network, sessions) | planned — Phase 4 |
| 9 | System Monitoring (history and alerts) | planned — Phase 4 |

Nothing in this repository pretends to do a job it has not been written to do.
Where a number cannot be read on your platform it prints `—`, never a guess.

---

## Requirements

Node.js 16 or newer. Nothing else — **zero npm dependencies**, so there is no
`npm install` step.

```bash
node --version
```

If that fails, install Node from https://nodejs.org (LTS build).

## Run it

```bash
cd campus-os
node campus.js
```

Or `npm start`. Or double-click `start.bat` on Windows / `./start.sh` on
macOS and Linux.

That opens an interactive shell:

```
  Intelligent Digital Campus Ecosystem  ·  terminal shell
  AkshatVinayak  ·  16 cores  ·  15.4 GB  ·  Windows_NT 10.0.26200
  Everything below is read live from this machine. Type `help`.

campus:campus-data$
```

Any command also works as a one-shot, which is useful in scripts:

```bash
node campus.js sys
node campus.js ps chrome
node campus.js ls Students
```

---

## Commands

### System

| Command | What it does |
|---|---|
| `sys` | hostname, CPU model, core count, physical memory, uptime, boot time |
| `stat` | one live reading — overall and per-core CPU, memory, load average, run queue |
| `watch [s]` | redraws that reading every `s` seconds (default 2); any key stops it |

### Processes

| Command | What it does |
|---|---|
| `ps` | the process table, top 20 by resident memory |
| `ps <text>` | filter by process name or PID |
| `ps -a` | every process |
| `ps -c` | sort by CPU share instead of memory |
| `pid <n>` | one process in full detail, with its state explained |

### Files — sandboxed to `campus-data/`

| Command | What it does |
|---|---|
| `ls [dir]` | listing with real inode number, mode bits, link count, size |
| `cd <dir>` | change directory; `cd ..` up, `cd /` back to the root |
| `pwd` | where you are |
| `cat <file>` | print a file |
| `mkdir <name>` | create a directory |
| `touch <name> [text]` | create a file, optionally with contents |
| `rm <name>` | delete a file or directory |
| `find <text>` | search the whole tree by name |

### Shell

`help`, `clear`, `exit` (Ctrl+C also works).

---

## What is real

Examiners ask this. Have the answer ready: **all of it, in this phase.** There
is no simulation anywhere in Phase 1 — the modelled parts of the syllabus
(fixed partitions, Banker's claim matrix) belong to modules that are not
built yet, and they will be labelled as models when they are.

| Data | Where it is read from |
|---|---|
| Process table: PID, PPID, state, threads, nice | `/proc/[pid]/stat` on Linux, `ps` on macOS, `Get-Process` on Windows |
| Per-process CPU % | Delta of `utime + stime` between two samples |
| Per-process memory (RSS) | Resident pages × page size |
| Context switches per process | `voluntary_ctxt_switches` in `/proc/[pid]/status` |
| Open file descriptors | Count of entries in `/proc/[pid]/fd` |
| Per-core CPU utilisation | Delta of `os.cpus()` tick counters |
| Physical memory | `os.totalmem()` and `MemAvailable` from `/proc/meminfo` |
| Run queue and blocked count | `procs_running`, `procs_blocked` in `/proc/stat` |
| System context switches/s | `ctxt` counter in `/proc/stat` |
| Load average | `os.loadavg()` |
| File metadata | `fs.stat` — real inode, blocks, permission bits, timestamps |

### Why CPU% needs two samples

A CPU percentage is not a value the kernel stores; it is a *rate*. The kernel
counts ticks spent in each state since boot, so a percentage only exists
between two readings. Every command here that shows a percentage takes a
throwaway first sample, waits 350 ms, and reports the difference. This is the
same thing `top` does, and it is why `top` also shows nothing useful on its
very first frame.

### Platform differences, stated honestly

| | Linux | macOS | Windows |
|---|---|---|---|
| Process table | `/proc` | `ps` | `Get-Process` |
| PPID | yes | yes | **no** — `Get-Process` does not report it |
| Process state letter | yes (`R S D T Z`) | yes | mapped from "Responding" only |
| Run queue / context switch rate | yes | no | no |
| Command line, open FDs, per-process switches | yes | no | no |

Linux gives the richest reading, because `/proc` is a filesystem view of kernel
data structures and the other two platforms have no equivalent. On macOS and
Windows those cells print `—`.

---

## Safety

- The process table is **read-only in this phase**. Nothing here can signal,
  suspend or kill a process — that is Phase 2, and it will ship with the
  guards it needs (no PID 1, no other users' processes, no critical system
  processes).
- File operations cannot escape `campus-data/`. Paths are resolved and then
  checked against the sandbox root, so `cat ../../package.json` is refused:

  ```
  campus:campus-data$ cat ../../package.json
  Path is outside the campus-data sandbox.
  ```
- Nothing listens on a network port. Nothing leaves your machine.

---

## Five-state process model

The point of the `pid` command is to connect the kernel's own state letter to
the five-state model from the lectures:

| Kernel says | Textbook state | Meaning |
|---|---|---|
| `R` | Running / Ready | On the CPU, or waiting in the run queue |
| `S` | Waiting | Interruptible sleep — waiting for an event or I/O |
| `D` | Waiting | Uninterruptible sleep — blocked on disk or device I/O |
| `T` | Suspended | Stopped by a signal (`SIGSTOP`) |
| `Z` | Terminated | Exited, but the parent has not reaped it — a zombie |

`pid <n>` prints the raw letter, the textbook state and a sentence of what it
means, together.

---

## Demo (about three minutes)

1. **`sys`** — point at the hostname and core count. This is your machine, not
   a fixture.
2. **`stat`** — read the per-core bars out loud, then watch memory. Say that
   the percentage is a delta between two samples, not a stored value.
3. **`watch`** — open a browser or a compiler in another window and watch the
   bars move.
4. **`ps -c`** — the busiest processes right now. Then `ps chrome` to filter.
5. **`pid <n>`** on something you started — its state letter, what the letter
   means, its CPU time, its thread count.
6. **`touch Students/roll-42.txt Akshat`** then, in a normal terminal,
   `ls -li campus-data/Students/` on Linux/macOS or `dir campus-data\Students`
   on Windows. Same file, same inode. This is the moment that shows it is not
   a mock.
7. **`cat ../../package.json`** — refused. Show the sandbox holding.

---

## Project layout

```
campus-os/
  campus.js        the terminal shell — commands, prompt, one-shot mode
  lib/
    platform.js    cross-platform shell helper
    metrics.js     CPU, memory, load, kernel counters
    processes.js   process table reader  (read-only in Phase 1)
    files.js       sandboxed real file operations
    render.js      tables, bars, colours, byte and duration formatting
  campus-data/     the real folder the File module operates on
  archive/         an earlier browser version, kept for reference only
  package.json
  start.sh         launcher for macOS and Linux
  start.bat        launcher for Windows
```

`campus-data/` is in `.gitignore` — it is scratch data, and the program
recreates the seven campus directories on startup if they are missing.

---

## Troubleshooting

**CPU shows 0% and per-process CPU shows `—`** — a percentage needs two
samples. Every command takes both, so this should not happen; if it does, the
process started between the two samples and there is nothing to compare.

**`PPID` is `—` on Windows** — `Get-Process` does not report parent PIDs.
Expected, not a bug.

**Run queue, blocked count and context switches show `—`** — those come from
`/proc/stat`, which is Linux-only.

**`watch` prints one reading and stops** — output is being piped or
redirected, so there is no terminal to redraw. Run it interactively.

**Colours look like garbage characters** — an old Windows console without ANSI
support. Use Windows Terminal or PowerShell 7, or set `NO_COLOR=1`.

**Can I deploy this to Netlify?** — No, and that is the point. A host would
show you *its* container's stats, not your machine's. Real OS data means
running it locally.
