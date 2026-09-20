# Intelligent Digital Campus Ecosystem

An Operating Systems course prototype that reads **live data from the machine it
runs on**. The process table, memory counters, per-core CPU load, disk usage,
network throughput and file system are all real. Nothing on the dashboard is
mock data.

The campus is the computer: its processes are the campus services, its memory is
the campus memory, its files are the campus records.

---

## Requirements

Node.js 16 or newer. Nothing else — the server has **zero npm dependencies**, so
there is no `npm install` step.

Check with:

```bash
node --version
```

If that fails, install Node from https://nodejs.org (LTS build).

## Run it

**Windows** — double-click `start.bat`

**macOS / Linux** — double-click `start.sh`, or in a terminal:

```bash
cd campus-os
./start.sh
```

**Any platform, manually:**

```bash
cd campus-os
node server.js
```

Then open **http://127.0.0.1:4173**

The terminal prints your hostname, CPU model, core count and memory on startup,
which is a good thing to show before you even open the browser.

To use a different port: `PORT=8080 node server.js`

---

## What is real, and what is a model

Examiners ask this. Have the answer ready.

### Read live from the kernel

| Data | Source |
|---|---|
| Process table: PID, PPID, state, threads, nice | `/proc/[pid]/stat` on Linux, `ps` on macOS, `Get-Process` on Windows |
| Per-process CPU % | Delta of `utime + stime` between samples |
| Per-process memory (RSS) | Resident pages × page size |
| Context switches per process | `/proc/[pid]/status` voluntary and non-voluntary counters |
| Open file descriptors | Count of `/proc/[pid]/fd` |
| Per-core CPU utilisation | Delta of `os.cpus()` tick counters |
| Physical memory | `os.totalmem()` and `MemAvailable` from `/proc/meminfo` |
| Run queue and blocked count | `procs_running`, `procs_blocked` in `/proc/stat` |
| System context switches/s | `ctxt` counter in `/proc/stat` |
| Disk usage | `df` on Unix, `Win32_LogicalDisk` on Windows |
| Network throughput | `/proc/net/dev` byte counters, converted to Mbps |
| File metadata | `fs.stat` — real inode, blocks, permission bits, timestamps |
| Blocked processes | Processes the kernel has in state `D` (uninterruptible sleep) |
| Process births and deaths | Diffed between one-second samples |
| Signals (suspend, resume, terminate) | Real `SIGSTOP`, `SIGCONT`, `SIGTERM` |

### Deliberately modelled, on top of real data

Two things are models, and saying so clearly is the strongest answer you can
give:

1. **Fixed memory partitions** on the Memory page. A modern kernel uses paging,
   not fixed partitions, so first/best/worst fit cannot be measured directly.
   The partitions are carved from your real free memory and the allocation
   requests are the real resident sizes of your largest processes.
2. **The Banker's claim matrix** on the Deadlock page. Processes do not declare
   their maximum future resource needs to an OS, so the maximum and allocation
   columns are editable inputs. The rows are real processes, and the blocked
   list above it is live kernel data.

---

## Safety

The server is deliberately restrictive:

- Binds to `127.0.0.1` only — nothing outside your machine can reach it
- Refuses signals to PID 1, to itself, to critical system processes
  (`systemd`, `init`, `launchd`, `csrss`, `lsass` and others) and to any
  process owned by a different user
- Every signal asks for confirmation in the browser first
- File operations cannot escape the `campus-data` folder; `../` is rejected
- Suspend and resume are Linux/macOS only, since Windows has no `SIGSTOP`

Terminating a process you own is a real terminate. Do not `SIGTERM` your editor
mid-demo unless you have saved your work.

---

## Modules

| Module | What it shows |
|---|---|
| Dashboard | Live CPU, memory, run queue, load average, context switch rate, real process births and deaths |
| Process Management | Live process table with real states, signal controls, real state letters mapped onto the five-state model |
| CPU Scheduling | FCFS, SJF, SRTF, Round Robin, Priority run over a **real** workload, with a generated Gantt chart |
| Memory Management | Real memory figures with first/best/worst fit placement of real process footprints |
| Deadlock Detection | Live list of processes blocked on I/O, plus a Banker's algorithm what-if |
| Resource Management | Per-core load, mounted volumes, network interfaces, who holds what |
| File Management | Real file CRUD with real inode metadata |
| System Monitoring | Sixty seconds of real CPU, memory, network and context-switch history |
| OS Concepts | The real-vs-modelled mapping, one card per concept |

---

## Suggested viva demo (about five minutes)

1. **Start the server in a terminal.** Point at the hostname and core count it
   prints. This proves it is reading your machine.
2. **Dashboard.** Open any app on your computer — a browser tab, a calculator —
   and watch the process appear in the Kernel activity feed within a second.
3. **Process Management.** Filter for something you started. Show its real
   state letter, its voluntary vs involuntary context switches, its open file
   descriptors. Suspend it and show the state change to `T`, then resume it.
4. **CPU Scheduling.** Press "Reload live", run Round Robin, then SRTF on the
   same real workload, and compare average waiting time.
5. **Memory Management.** Toggle first / best / worst fit. Say out loud which
   part is measured and which part is modelled.
6. **Deadlock Detection.** Show the live blocked list, then press the Unsafe
   preset on the Banker's table.
7. **File Management.** Create a file in the browser, then in a terminal run
   `ls -li campus-data/` and show the same inode number. This is the moment that
   convinces people it is not a mock.
8. **Role switcher.** Drop to Student and show the signal buttons disappear.

---

## Verified algorithm results

The scheduling, memory and Banker's engines were checked against textbook cases:

- Banker's with the classic dataset returns the safe sequence
  `P1 → P3 → P4 → P0 → P2`
- Round Robin on P1(0,5) P2(1,3) P3(2,8), quantum 2 → average waiting time 6.00
- SRTF on the same set → 3.00, preempting P1 at t=1
- First fit on blocks [200,400,300,600,100] with requests [212,417,112,426]
  → 212→B2, 417→B4, 112→B1, 426 fails

---

## Project layout

```
campus-os/
  server.js          HTTP + SSE server, zero dependencies
  lib/
    platform.js      cross-platform shell helper
    metrics.js       CPU, memory, disk, network, kernel counters
    processes.js     process table reader and signal sender
    files.js         sandboxed real file operations
  public/
    index.html       the dashboard (React via CDN, compiled in-browser)
  campus-data/       the real folder the File module operates on
  package.json
  start.sh           launcher for macOS and Linux
  start.bat          launcher for Windows
```

## Troubleshooting

**"Not connected to the campus OS server"** — the page is open but `node
server.js` is not running, or it is on a different port. Start it and the page
reconnects on its own.

**Port already in use** — `PORT=8080 node server.js`, then open
http://127.0.0.1:8080

**CPU shows 0% and per-process CPU shows dashes** — the first sample has no
previous sample to compare against. It fills in after one second.

**Fonts and layout look plain** — React and Tailwind load from a CDN, so the
page needs internet the first time. Open it once before the viva so the browser
caches them.

**Suspend and Resume are greyed out** — you are on Windows, which has no
`SIGSTOP`. Terminate still works.

**Can I deploy this to Netlify?** — Not this version. Netlify hosts static
files only, and even on a host that runs Node you would see that server's
container stats, not your own machine. Real OS data means running it locally.
That is the point of the project, and it is worth saying so if asked.
