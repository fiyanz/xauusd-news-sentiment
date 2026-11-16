"""Visualisasi hasil training model XAUUSD.

Menghasilkan 4 panel:
1. Rank IC per model (dengan p-value)
2. Hit ratio per model vs baseline 50%
3. Baseline vs Full: rank IC + delta
4. Trajektori riset (baseline -> H1 -> H2)
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

OUT = Path("research/to_human")
OUT.mkdir(parents=True, exist_ok=True)

metrics = json.load(open("reports/full_metrics_evaluation.json"))
fair = json.load(open("reports/fair_comparison_results.json"))
sig = json.load(open("reports/significance.json"))

models = metrics["models"]
names = list(models.keys())
ics = [models[m]["spearman_rank_ic"] for m in names]
ps = [models[m]["spearman_pval"] for m in names]
hits = [models[m]["hit_ratio_sig"] for m in names]
overfit = [models[m]["overfit_gap_hit"] for m in names]

fig, axes = plt.subplots(2, 2, figsize=(13, 9))
fig.suptitle("XAUUSD News Sentiment — Hasil Training Model", fontsize=14, fontweight="bold")

# 1. Rank IC per model
ax = axes[0, 0]
colors = ["#4C72B0" if n != metrics["champion_name"] else "#DD8452" for n in names]
bars = ax.bar(names, ics, color=colors)
ax.set_title("Rank IC per Model (test, n=5.189)")
ax.set_ylabel("Spearman Rank IC")
for b, ic, p in zip(bars, ics, ps):
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.0008, f"{ic:.4f}\np={p:.4f}",
            ha="center", fontsize=8)
ax.set_ylim(0, max(ics) * 1.35)
ax.axhline(0, color="black", lw=0.6)

# 2. Hit ratio
ax = axes[0, 1]
bars = ax.bar(names, hits, color=colors)
ax.axhline(50, color="red", ls="--", lw=1, label="50% (chance)")
ax.set_title("Hit Ratio Signifikan (%)")
ax.set_ylabel("Hit ratio (%)")
for b, h in zip(bars, hits):
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.15, f"{h:.2f}", ha="center", fontsize=8)
ax.set_ylim(48, max(hits) * 1.08)
ax.legend(fontsize=8)

# 3. Baseline vs Full
ax = axes[1, 0]
base_ic = fair["models"]["baseline"]["spearman_rank_ic"]
full_ic = fair["models"]["full"]["spearman_rank_ic"]
delta = fair["delta_alpha"]["rank_ic_improvement"]
vals = [base_ic, full_ic]
bars = ax.bar(["Baseline (makro)", "Full (+berita)"], vals, color=["#55A868", "#C44E52"])
ax.set_title(f"Baseline vs Full — delta IC {delta:+.4f}")
ax.set_ylabel("Rank IC")
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.0006, f"{v:.4f}", ha="center", fontsize=9)
ax.set_ylim(0, max(vals) * 1.3)
ax.text(0.5, 0.04, f"sentiment_adds_value = {sig['sentiment_adds_value']}\n"
                   f"paired bootstrap p = {sig['paired_ic_test']['p_value']:.3f}",
        transform=ax.transAxes, ha="center", fontsize=9,
        bbox=dict(boxstyle="round", fc="#FFF3CD", ec="#888"))

# 4. Trajektori riset
ax = axes[1, 1]
labels = ["Baseline\n(produksi)", "H1 embedding\n(bucket berita)", "H2 body\n(bucket berita)"]
ic_traj = [0.0569, 0.1091, 0.1091]
p_traj = [None, 0.013, 0.166]
bars = ax.bar(labels, ic_traj, color=["#55A868", "#4C72B0", "#8172B3"])
ax.set_title("Trajektori Riset — Rank IC pada Bucket Berita")
ax.set_ylabel("Rank IC")
for b, ic, p in zip(bars, ic_traj, p_traj):
    txt = f"{ic:.4f}" + (f"\np={p}" if p is not None else "")
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.002, txt, ha="center", fontsize=8)
ax.set_ylim(0, max(ic_traj) * 1.3)

plt.tight_layout()
out = OUT / "training_results.png"
plt.savefig(out, dpi=130, bbox_inches="tight")
print(f"tersimpan: {out}")

# versi SVG juga
out_svg = OUT / "training_results.svg"
plt.savefig(out_svg, bbox_inches="tight")
print(f"tersimpan: {out_svg}")
