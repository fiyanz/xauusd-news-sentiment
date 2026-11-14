"""Model dua-fase: prediksi pra-event dan trend pasca-event.

Konsep:
- **Fase PRA-event**: berita yang terbit SEBELUM rilis makro (CPI/FOMC/NFP/PCE).
  Berita membentuk ekspektasi -> dipakai untuk memprediksi arah setelah rilis.
- **Fase PASCA-event**: berita yang terbit SESUDAH rilis. Berita mendorong trend
  -> dipakai untuk menentukan arah lanjutan.

Label 3 kelas (naik/turun/netral):
- naik  : berita relevan (emas|makro) DAN return > +ambang
- turun : berita relevan DAN return < -ambang
- netral: return kecil ATAU berita tidak relevan

Fase ditentukan oleh posisi berita terhadap event makro terdekat:
- pra  : event dalam 0..window jam ke depan
- pasca: event dalam -window..0 jam ke belakang
- di luar jendela -> tidak dipakai untuk model fase
"""

import re
from dataclasses import dataclass

import numpy as np
import pandas as pd

GOLD_RE = re.compile(r"\b(gold|xauusd|bullion|precious metal)\b", re.IGNORECASE)
MACRO_RE = re.compile(
    r"\b(cpi|fomc|fed|federal reserve|interest rate|payroll|nfp|jobs report|"
    r"inflation|pce|rate decision|powell)\b",
    re.IGNORECASE,
)


@dataclass
class PhaseConfig:
    window_hours: int = 72
    threshold_k: float = 0.5


def add_relevance(df: pd.DataFrame, title_col: str = "title") -> pd.DataFrame:
    """Tambah kolom gold/macro/relevant ke DataFrame artikel."""
    out = df.copy()
    title = out[title_col].fillna("")
    out["gold"] = title.str.contains(GOLD_RE)
    out["macro"] = title.str.contains(MACRO_RE)
    out["relevant"] = out["gold"] | out["macro"]
    return out


def label_3class(
    df: pd.DataFrame,
    ret_col: str = "ret_4h",
    vol_col: str = "vol_pre",
    threshold_k: float = 0.5,
    relevance_col: str = "relevant",
) -> pd.Series:
    """Label naik(1)/turun(-1)/netral(0).

    netral bila return kecil ATAU berita tidak relevan.
    """
    thr = threshold_k * df[vol_col]
    label = pd.Series(0, index=df.index, dtype=int)
    rel = df[relevance_col].astype(bool)
    label.loc[rel & (df[ret_col] > thr)] = 1
    label.loc[rel & (df[ret_col] < -thr)] = -1
    return label


def assign_phase(
    df: pd.DataFrame,
    events: pd.DataFrame,
    time_col: str = "time_published_utc",
    event_col: str = "timestamp_utc",
    window_hours: int = 72,
) -> pd.Series:
    """Assign fase pra/pasca/luar untuk tiap artikel.

    pra   : event dalam 0..window jam ke depan
    pasca : event dalam -window..0 jam ke belakang
    luar  : tidak ada event dalam jendela
    """
    ev = pd.to_datetime(events[event_col], utc=True).sort_values().reset_index(drop=True)
    times = pd.to_datetime(df[time_col], utc=True)
    phases = pd.Series("luar", index=df.index, dtype=object)

    ev_arr = ev.values
    for idx, t in times.items():
        diffs_h = (ev_arr - t.to_datetime64()) / np.timedelta64(1, "h")
        if ((diffs_h > 0) & (diffs_h <= window_hours)).any():
            phases.loc[idx] = "pra"
        elif ((diffs_h < 0) & (diffs_h >= -window_hours)).any():
            phases.loc[idx] = "pasca"
    return phases


def build_phase_dataset(
    articles: pd.DataFrame,
    events: pd.DataFrame,
    config: PhaseConfig | None = None,
) -> pd.DataFrame:
    """Bangun dataset siap-model: relevansi, label, fase."""
    config = config or PhaseConfig()
    df = add_relevance(articles)
    df["label3"] = label_3class(df, threshold_k=config.threshold_k)
    df["phase"] = assign_phase(df, events, window_hours=config.window_hours)
    return df


def phase_summary(df: pd.DataFrame) -> dict:
    """Ringkasan distribusi fase dan label."""
    out = {"n": int(len(df))}
    out["phase"] = df["phase"].value_counts().to_dict()
    out["label"] = df["label3"].value_counts().to_dict()
    for ph in ["pra", "pasca"]:
        sub = df[df["phase"] == ph]
        if len(sub):
            out[f"label_{ph}"] = sub["label3"].value_counts().to_dict()
    return out
