# 2026-11-13 — `apps/desktop unit` worker SIGSEGV: captured stack

**Verdict: the crash is inside Node/V8 worker-isolate teardown, not in Cindy code.**
The faulting thread is a vitest worker thread that is destroying its isolate; a
garbage collection started by `CppHeap::DetachIsolate()` jumps to a function pointer
that is a data address (`pc == x8 ==` an unmapped heap page).

## How it was captured

Developer mode had to be enabled first (`sudo DevToolsSecurity -enable`); without it
`lldb` refuses to debug homebrew `node` and `run` hangs with the inferior suspended.

```bash
cd "<repo>/apps/desktop"
lldb --batch \
  -K /tmp/proofs/crash-cmds.lldb \
  -o run -o quit \
  -- /opt/homebrew/opt/node@22/bin/node ../../node_modules/vitest/vitest.mjs \
     run --pool=threads --maxWorkers=8 --project standard
```

Two debuggers were run in parallel (each on its own 515-file run) to keep the machine
loaded; both faulted within one attempt, ~3.5 min in.

Two lldb details cost time and are worth remembering:

- lldb cannot expand argv that contains this repo's spaced, `=`-heavy path
  (`lldb-argdumper exited with error 1`). Run from `apps/desktop` with a **relative**
  `../../node_modules/vitest/vitest.mjs`.
- `-o "thread backtrace all"` after a crash prints nothing: the process finishes exiting
  as soon as lldb stops it. Commands must be attached with **`-K` (source-on-crash)**,
  which runs *at* the fault.
- `MallocScribble=1 MallocGuardEdges=1` makes the fault more frequent but also fails 17
  tests (heap poisoning breaks tests that assume zeroed memory), so the clean capture
  runs without it.

## The crash (`lane-2`, three independent captures agree)

```
* thread #1340, stop reason = EXC_BAD_ACCESS (code=1, address=0x159338280)
  frame #0: 0x0000000159338280                      <- pc is a heap address, unmapped
  frame #1: 0x0000000102f884ec libnode.127.dylib`v8::internal::Heap::CollectGarbage(...)::$_1::...
  frame #2: 0x0000000102f829b8 libnode.127.dylib`void heap::base::Stack::SetMarkerAndCallbackImpl<...>
  frame #3: 0x000000010345dc48 libnode.127.dylib`PushAllRegistersAndIterateStack + 40
  frame #4: 0x0000000102f71e84 libnode.127.dylib`v8::internal::Heap::CollectGarbage(...) + 596
  frame #5: 0x0000000102f516ec libnode.127.dylib`v8::internal::CppHeap::DetachIsolate() + 72
  frame #6: 0x0000000102b59118 libnode.127.dylib`node::IsolateData::~IsolateData() + 88
  frame #7: 0x0000000102b591d4 libnode.127.dylib`node::IsolateData::~IsolateData() + 12
  frame #8: 0x0000000102ca2c80 libnode.127.dylib`node::worker::Worker::Run() + 3200
  frame #9: 0x0000000102ca6c94 libnode.127.dylib`node::worker::Worker::StartThread(...)::$_0::__invoke(void*) + 56
  frame #10: 0x0000000185b04ce4 libsystem_pthread.dylib`_pthread_start + 136
```

Registers at the fault: `pc = 0x159338280`, `x8 = 0x159338280` (the jump target),
`lr = libnode … Heap::CollectGarbage`, `sp = 0x175639cd0` (valid stack).

Observations:

- The process had **already printed its test summary** (`Duration 207.39s`, `Test Files
  10 failed | 952 passed`) before the fault: nothing in the suite failed *because* of it.
- The crashing thread is `#1340` (another capture: `#1149`, `#1055`, `#399`), i.e. there
  are hundreds of live threads by the time the run ends — one isolate per test file, each
  with its own V8 platform threads.
- Every crash lands on the same chain: `Worker::Run` → `~IsolateData` →
  `CppHeap::DetachIsolate` → `CollectGarbage` → stack-marking callback → bad PC.

## What this rules out and what it means

- Not a Cindy test file: the fault is in isolate destruction, after the tests; shard
  membership changes only *how many* isolates are destroyed per run.
- Not a native addon finalizer: ~2 000 synthetic `worker_threads` teardowns that load
  `better-sqlite3`, `sharp` or `node-pty` never faulted (see STATUS 2026-11-13 (u)).
- This is the same code path as [nodejs/node#51129 / PR #51138](https://github.com/nodejs/node/commit/54dd978400)
  ("enter isolate before destructing IsolateData"), where a GC started by
  `Isolate::DetachCppHeap` expects an entered isolate. Node 22.23.4 carries that fix and
  still faults, so what is left is a *concurrency* variant of the same defect: with 8
  parallel vitest workers, one isolate's teardown GC races another isolate's platform
  threads. A related, still-open class is described in
  [nodejs/node#55325](https://github.com/phillipring.com/nodejs/node/issues/55325)
  (isolate lifetime vs. shared static state).

## Mitigation in place (not a fix)

`scripts/test-workspaces.mjs` classifies this as `WORKER_CRASHED` (it used to be reported
as `TEST_ASSERTION_FAILED` because pnpm's message contains `FAIL`) and retries the leg
once, loudly, with `PASS … [retried after a worker SIGSEGV]` in the summary. The
structural escapes are known and rejected for now: `--pool=forks` for desktop (the churn
that once took down `launchservicesd`, and which Node 24+ already forces) and
`isolate=false` (737 tests rely on per-file isolation).
