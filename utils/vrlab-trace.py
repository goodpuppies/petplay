#!/usr/bin/env python3
"""Bounded scheduler/GPU capture in an owned tracefs instance; no global reset."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", required=True)
parser.add_argument("--seconds", type=float, default=30)
parser.add_argument("--signals-only", action="store_true", help="Low-volume startup signal attribution; no scheduler/GPU coverage")
parser.add_argument("--phase-file", type=Path, help="Preallocate, then wait for this native-route phase marker")
parser.add_argument("--phase-name", default="show-display")
args = parser.parse_args()
if not 0 < args.seconds <= (300 if args.signals_only else 60):
    parser.error("seconds must be in (0, 60], or (0, 300] for signals-only")
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=False)
root = Path("/sys/kernel/tracing")
instance_name = f"petplay-observe-{os.getpid()}"
instance = root / "instances" / instance_name
keys = ["tracing_on", "current_tracer", "events/enable", "trace_clock"]
before = {key: (root / key).read_text().strip() for key in keys}
required = ["sched:sched_switch", "sched:sched_wakeup", "signal:signal_generate", "amdgpu:amdgpu_cs_ioctl",
            "amdgpu:amdgpu_sched_run_job", "dma_fence:dma_fence_signaled"]
if args.signals_only:
    required = ["signal:signal_generate"]
metadata = {"instance": instance_name, "events": required, "seconds": args.seconds,
            "before": before, "clock": "mono", "bufferKiBPerCpu": 16384,
            "signalsOnly": args.signals_only,
            "note": "Observer overhead unquantified. SteamVR global trace markers are not copied into this instance."}


def marker(label):
    # The pair bounds the wall-clock/trace-clock correlation uncertainty.
    lower = time.monotonic_ns()
    wall = time.time_ns()
    upper = time.monotonic_ns()
    value = {"label": label, "monoLowerNs": lower, "realtimeNs": wall, "monoUpperNs": upper}
    (instance / "trace_marker").write_text(json.dumps(value) + "\n")
    return value


try:
    instance.mkdir()
    (instance / "tracing_on").write_text("0")
    (instance / "trace_clock").write_text("mono")
    (instance / "buffer_size_kb").write_text(str(metadata["bufferKiBPerCpu"]))
    for event in required:
        system, name = event.split(":")
        (instance / "events" / system / name / "enable").write_text("1")
    metadata["processesBefore"] = subprocess.check_output(
        ["ps", "-eLo", "pid,tid,ppid,comm"], text=True)
    (out / "ready.json").write_text(json.dumps({"instance": instance_name, "ready": True}))
    if args.phase_file:
        deadline = time.monotonic() + 60
        while True:
            try:
                phase = json.loads(args.phase_file.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                phase = None
            if phase and phase.get("phase") == args.phase_name:
                metadata["trigger"] = phase
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(f"No phase {args.phase_name} in {args.phase_file}")
            time.sleep(.002)
    (instance / "tracing_on").write_text("1")
    metadata["start"] = marker("petplay-observation-begin")
    print(f"Recording {instance_name} to {out}", flush=True)
    time.sleep(args.seconds)
    metadata["end"] = marker("petplay-observation-end")
    (instance / "tracing_on").write_text("0")
    metadata["cpuStats"] = {p.parent.name: p.read_text()
                            for p in (instance / "per_cpu").glob("cpu*/stats")}
    metadata["lostEvents"] = sum(
        int(line.split(":", 1)[1].strip())
        for value in metadata["cpuStats"].values() for line in value.splitlines()
        if line.split(":", 1)[0].strip() in ("overrun", "commit overrun", "dropped events"))
    subprocess.run(["trace-cmd", "extract", "-B", instance_name,
                    "-o", str(out / "trace.dat")], check=True)
    metadata["processesAfter"] = subprocess.check_output(
        ["ps", "-eLo", "pid,tid,ppid,comm"], text=True)
finally:
    if instance.exists():
        (instance / "tracing_on").write_text("0")
        (instance / "events/enable").write_text("0")
        instance.rmdir()
    metadata["after"] = {key: (root / key).read_text().strip() for key in keys}
    metadata["instanceRemoved"] = not instance.exists()
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2))
if before != metadata["after"]:
    raise SystemExit("Top-level tracing changed during capture; inspect metadata")
if metadata.get("lostEvents", 0):
    raise SystemExit("Trace lost events; do not use as complete tail evidence")
print("Capture complete; no lost events; owned instance removed", flush=True)
