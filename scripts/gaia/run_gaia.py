#!/usr/bin/env python3
"""GAIA benchmark harness for dcode.

Runs dcode as the agent against the GAIA validation split, extracts each task's
final answer, and scores against the ground truth. This is a standalone bench
harness kept out of the agent code.

Setup:
    pip install -r requirements.txt
    export OPENAI_API_KEY=...        # dcode reads this from the environment

Usage:
    # run levels 1-3 on the validation split, score at the end
    python run_gaia.py --out predictions.jsonl --score

    # quick smoke test on a few level-1 tasks
    python run_gaia.py --level 1 --max-tasks 5 \
        --dcode-cmd "node /abs/path/to/dcode/src/index.ts" --score

    # resume an interrupted run (skips task_ids already in --out)
    python run_gaia.py --out predictions.jsonl --resume --score

Notes:
    - dcode is invoked one-shot with cwd = a per-task directory that holds the
      task's attachment (if any), so dcode can read it via read_file.
    - The scorer is a faithful port of GAIA's question_scorer (numeric equality,
      comma/semicolon list equality, normalized string equality, and the
      "3,676" -> two-element-list quirk). For leaderboard-submission numbers,
      run the official gaia-benchmark/GAIA validate.py to be byte-identical.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from huggingface_hub import hf_hub_download

try:
    from datasets import load_dataset
except ImportError:  # pragma: no cover
    sys.stderr.write("datasets not installed; run: pip install -r requirements.txt\n")
    raise

GAIA_REPO = "gaia-benchmark/GAIA"
DEFAULT_CONFIG = "2023_all"
DEFAULT_SPLIT = "validation"


def parse_args():
    p = argparse.ArgumentParser(description="Run dcode against the GAIA benchmark.")
    p.add_argument("--out", default="predictions.jsonl", help="predictions JSONL path")
    p.add_argument(
        "--dataset",
        default=GAIA_REPO,
        help="HF dataset repo id (default: gaia-benchmark/GAIA)",
    )
    p.add_argument("--config", default=DEFAULT_CONFIG, help="dataset config (e.g. 2023_all, 2023_level1)")
    p.add_argument("--split", default=DEFAULT_SPLIT, help="dataset split (validation | test)")
    p.add_argument("--level", type=int, choices=[1, 2, 3], help="restrict to one GAIA level")
    p.add_argument("--max-tasks", type=int, help="cap number of tasks (smoke test)")
    p.add_argument(
        "--dcode-cmd",
        default="dcode",
        help="how to invoke dcode (default: 'dcode' on PATH; or 'node /path/src/index.ts')",
    )
    p.add_argument("--model", help="model id passed to dcode via --model")
    p.add_argument("--work-root", default="gaia_tasks", help="dir for per-task working dirs")
    p.add_argument("--timeout", type=int, default=900, help="per-task subprocess timeout (s)")
    p.add_argument("--resume", action="store_true", help="skip task_ids already present in --out")
    p.add_argument("--score", action="store_true", help="score predictions against ground truth")
    return p.parse_args()


def load_rows(args):
    ds = load_dataset(args.dataset, args.config, split=args.split)
    rows = []
    for r in ds:
        level = r.get("Level")
        if args.level and str(level) != str(args.level):
            continue
        rows.append(
            {
                "task_id": r["task_id"],
                "question": r["Question"],
                "final_answer": r.get("Final answer"),
                "level": level,
                "file_name": r.get("file_name") or "",
                "file_path": r.get("file_path") or "",
            }
        )
    return rows


def prepare_attachment(row, task_dir):
    """Download the task attachment (if any) into task_dir so dcode can read it."""
    if not row["file_name"] or not row["file_path"]:
        return
    local = hf_hub_download(
        repo_id=args_holder.dataset,
        filename=row["file_path"],
        repo_type="dataset",
    )
    shutil.copy(local, os.path.join(task_dir, row["file_name"]))


def build_prompt(row):
    parts = [
        "You are a general AI assistant. Solve the task using the tools available "
        "to you: read files in your working directory, run shell commands (e.g. to "
        "execute Python/pandas), and search or fetch the web.",
    ]
    if row["file_name"]:
        parts.append(
            f'An attachment is provided in your working directory: "{row["file_name"]}". '
            "Read it as needed."
        )
    parts.append(f"Task:\n{row['question']}")
    parts.append(
        "When you have the answer, put it on its own line as:\nFINAL ANSWER: <your answer>"
    )
    return "\n\n".join(parts)


def extract_final_answer(text):
    # dcode prints tool-status lines (`› name: ✓/✗ ...`) and rule fences
    # (`── name output ──`) to stdout in one-shot mode; strip those and any ANSI
    # so they don't pollute the answer when the model skips the FINAL ANSWER: tag.
    text = ANSI_RE.sub("", text)
    m = re.search(r"FINAL ANSWER:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
    if m:
        ans = m.group(1).strip()
        if ans:
            return ans
    lines = _clean_lines(text)
    if not lines:
        return ""
    return lines[-1]


# Strip ANSI escapes and the noisy status/fence lines dcode emits around its
# streamed answer, leaving only the model's own prose lines.
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _clean_lines(text):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("›"):
            continue
        if s.startswith("──") or s.endswith("──"):
            continue
        out.append(s)
    return out


def run_dcode(task_dir, prompt, args):
    cmd = args.dcode_cmd.split()
    cmd += ["--no-color"]
    if args.model:
        cmd += ["--model", args.model]
    cmd.append(prompt)
    res = subprocess.run(
        cmd,
        cwd=task_dir,
        capture_output=True,
        text=True,
        timeout=args.timeout,
        env=os.environ,
    )
    if res.returncode != 0:
        sys.stderr.write(f"dcode exited {res.returncode}: {res.stderr[-500:]}\n")
    return res.stdout


# --- scoring (faithful port of GAIA question_scorer) ---


def gaia_normalize(s):
    s = s.lower()
    s = re.sub(r"[^a-z0-9]", " ", s)
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def gaia_score(pred, ref):
    if not pred:
        return False
    pred = pred.strip()
    ref = (ref or "").strip()
    if "," in ref or ";" in ref:
        ps = [gaia_normalize(x) for x in re.split(r"[,;]", pred)]
        rs = [gaia_normalize(x) for x in re.split(r"[,;]", ref)]
        return ps == rs
    try:
        return float(pred.replace(",", "")) == float(ref.replace(",", ""))
    except ValueError:
        pass
    return gaia_normalize(pred) == gaia_normalize(ref)


def score_predictions(predictions, references):
    correct = total = 0
    per_level = {}
    for p in predictions:
        ref = references.get(p["task_id"])
        if ref is None:
            continue
        total += 1
        ok = gaia_score(p["final_answer"], ref)
        correct += int(ok)
        lvl = str(p.get("level"))
        d = per_level.setdefault(lvl, {"correct": 0, "total": 0})
        d["total"] += 1
        d["correct"] += int(ok)
    accuracy = correct / total if total else 0.0
    return {"total": total, "correct": correct, "accuracy": round(accuracy, 4), "per_level": per_level}


def main():
    args = parse_args()
    global args_holder
    args_holder = args

    rows = load_rows(args)
    if args.max_tasks:
        rows = rows[: args.max_tasks]

    done = set()
    if args.resume and os.path.exists(args.out):
        with open(args.out) as f:
            for line in f:
                line = line.strip()
                if line:
                    done.add(json.loads(line)["task_id"])

    predictions = []
    references = {}
    with open(args.out, "a") as out_f:
        for row in rows:
            references[row["task_id"]] = row["final_answer"]
            if row["task_id"] in done:
                continue
            task_dir = os.path.join(args.work_root, row["task_id"])
            os.makedirs(task_dir, exist_ok=True)
            prepare_attachment(row, task_dir)
            prompt = build_prompt(row)
            try:
                out = run_dcode(task_dir, prompt, args)
            except subprocess.TimeoutExpired:
                sys.stderr.write(f"timeout: {row['task_id']}\n")
                out = ""
            ans = extract_final_answer(out)
            pred = {"task_id": row["task_id"], "final_answer": ans, "level": row["level"]}
            predictions.append(pred)
            out_f.write(json.dumps(pred) + "\n")
            out_f.flush()
            print(f"{row['task_id']} (L{row['level']}) -> {ans[:80]!r}", file=sys.stderr)

    if args.score:
        report = score_predictions(predictions, references)
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
