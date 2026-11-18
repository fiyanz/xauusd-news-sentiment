"""Build 4H buckets from the FULL price history.

The news-only path (``bucket_harmonize.harmonize_buckets``) creates a bucket only
when an article falls inside it, so the sample is capped by news coverage (~14
days of RSS). That makes CV/evaluation pure noise.

This module instead creates a bucket for every 4H window in the price series.
News features are aggregated per bucket and are neutral (0) when no article falls
in it, so the sample size is independent of news coverage and the model can
actually be evaluated on tens of thousands of buckets.

Point-in-time rules are preserved:
- ``ret_4h`` / ``ret_24h`` use closes at/after the bucket start (no look-ahead).
- ``vol_pre`` uses a shifted rolling volatility.
- the macro merge is ``merge_asof backward`` on date.
- the surprise is a backward carry-forward of the last *released* event, with
  ``surprise_age_hours`` so stale values are distinguishable.
"""

import os

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer

from src.process.bucket_harmonize import TOPIC_PATTERNS

SESSIONS = ["session_Asia", "session_London", "session_NewYork"]

VALID_SPLIT_MODES = ("chronological", "news_era")


def _assign_session(h: int) -> str:
    if 0 <= h < 7:
        return "Asia"
    if 7 <= h < 13:
        return "London"
    return "NewYork"


def _news_era_boundaries(
    news_period: tuple[pd.Timestamp, pd.Timestamp] | None,
    buckets: pd.DataFrame,
    train_ratio: float,
    val_ratio: float,
    embargo_delta: pd.Timedelta,
) -> tuple[pd.Timestamp, pd.Timestamp]:
    """Return (t_train_end, t_val_end) for the news-era split.

    The news corpus is divided by *news mass* (article count): train gets the
    first ``train_ratio`` of articles, val the next ``val_ratio``, test the rest.
    Boundaries are then snapped to bucket edges and the embargo is applied, so
    the split stays strictly out-of-time. A pure time-proportional split is used
    as a starting estimate, then corrected by news mass.

    Falls back to a chronological split when the news corpus is missing or too
    thin to give the test period any articles.
    """
    n_total = len(buckets)
    fallback_train = int(n_total * train_ratio)
    fallback_val = min(int(n_total * val_ratio), n_total - fallback_train)

    def _chronological() -> tuple[pd.Timestamp, pd.Timestamp]:
        return (
            buckets.iloc[fallback_train]["time_bucket"],
            buckets.iloc[fallback_train + fallback_val]["time_bucket"],
        )

    if news_period is None:
        print("[PriceBuckets] news_era: korpus berita tidak ada; fallback chronological.")
        return _chronological()

    news_start, news_end = news_period
    span = news_end - news_start
    if span <= pd.Timedelta(0):
        print("[PriceBuckets] news_era: rentang berita nol; fallback chronological.")
        return _chronological()

    times = buckets["time_bucket"]
    counts = buckets["article_count"]
    total_articles = float(counts.sum())
    if total_articles <= 0:
        print("[PriceBuckets] news_era: tidak ada artikel; fallback chronological.")
        return _chronological()

    # News-mass split: train gets the first ``train_ratio`` of articles, val the
    # next ``val_ratio``, test the rest. Cumulative share is monotonic in time,
    # so the resulting boundaries are strictly out-of-time.
    cum = counts.cumsum() / total_articles

    def _first_bucket_reaching(target: float) -> pd.Timestamp:
        reached = buckets[cum >= target]
        if reached.empty:
            return times.iloc[-1]
        return reached["time_bucket"].iloc[0]

    t_train_end = _first_bucket_reaching(train_ratio)
    t_val_end = _first_bucket_reaching(train_ratio + val_ratio)

    # Time-proportional sanity guard: a news-mass split can push the test period
    # into the 2026 tail (only ~40 news buckets) when the corpus has a long gap.
    # If the test period would start after the time-proportional val end, prefer
    # the time-proportional boundary so test keeps a usable span.
    def _snap(t: pd.Timestamp) -> pd.Timestamp:
        """First bucket strictly after ``t`` (keeps test out-of-time)."""
        idx = int(times.searchsorted(t, side="right"))
        idx = min(idx, n_total - 1)
        return times.iloc[idx]

    raw_val_end = news_start + span * (train_ratio + val_ratio)
    if t_val_end > _snap(raw_val_end):
        t_val_end = _snap(raw_val_end)
        # Re-derive train end from news mass but never past the val end.
        train_candidates = buckets[(cum >= train_ratio) & (times < t_val_end)]
        if not train_candidates.empty:
            t_train_end = train_candidates["time_bucket"].iloc[0]

    # Guard: test period must actually contain news.
    test_mask = times >= t_val_end
    if not (counts.loc[test_mask] > 0).any():
        print("[PriceBuckets] news_era: test period tidak berisi berita; fallback chronological.")
        return _chronological()

    # Guard: train strictly before val, val strictly before test.
    if not (t_train_end < t_val_end):
        print("[PriceBuckets] news_era: batas train/val tidak valid; fallback chronological.")
        return _chronological()

    return t_train_end, t_val_end


def report_split_coverage(df: pd.DataFrame) -> dict:
    """Per-split coverage: bucket count, bucket count with news, start/end.

    Returns ``{split: {"n_buckets": int, "n_buckets_with_news": int,
    "start": str|None, "end": str|None}}`` for every split present in ``df``.
    """
    out: dict[str, dict] = {}
    for split, grp in df.groupby("split"):
        has_news = grp["article_count"] > 0 if "article_count" in grp.columns else False
        start = grp["time_bucket"].min() if "time_bucket" in grp.columns else None
        end = grp["time_bucket"].max() if "time_bucket" in grp.columns else None
        out[str(split)] = {
            "n_buckets": int(len(grp)),
            "n_buckets_with_news": int(has_news.sum()) if hasattr(has_news, "sum") else 0,
            "start": start.isoformat() if start is not None and pd.notna(start) else None,
            "end": end.isoformat() if end is not None and pd.notna(end) else None,
        }
    return out


def build_price_history_buckets(
    price_csv: str = "data/raw/price/xauusd_h1_complete.csv",
    article_parquet: str = "data/processed/dataset_article.parquet",
    calendar_csv: str = "data/raw/calendar/economic_calendar_enriched.csv",
    macro_csv: str = "data/raw/macro/macro_context.csv",
    output_parquet: str = "data/processed/bucketed_features.parquet",
    bucket_freq: str = "4h",
    embargo_hours: int = 24,
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    tfidf_max_features: int = 50,
    vol_lookback_days: int = 20,
    sentiment_col: str = "overall_sentiment_score",
    split_mode: str = "chronological",
    topic_weighting: bool = False,
    gold_weighting: bool = False,
    embeddings: bool = True,
    embedding_n_components: int = 16,
    embedding_cache_dir: str = "models/embeddings",
) -> pd.DataFrame:
    """Create 4H buckets covering the whole price history, with sparse news.

    ``split_mode``:
    - ``"chronological"`` (default): split by position in the full price
      history (old behaviour).
    - ``"news_era"``: split by the era covered by the news corpus, so the test
      period actually contains articles. Still strictly out-of-time.

    ``embedding_cache_dir`` menyimpan cache embedding + reducer train-only.
    Build di luar produksi (tes, eksperimen) HARUS memberi direktori sendiri
    supaya tidak menimpa reducer produksi di ``models/embeddings/``.
    """
    if split_mode not in VALID_SPLIT_MODES:
        raise ValueError(f"split_mode must be one of {VALID_SPLIT_MODES}, got {split_mode!r}")
    print(f"[PriceBuckets] Building 4H buckets from {price_csv} (split_mode={split_mode})...")

    # 1. Price -> 4H buckets -------------------------------------------------
    df_price = pd.read_csv(price_csv)
    df_price["time"] = pd.to_datetime(df_price["time"], utc=True)
    df_price = df_price.sort_values("time").drop_duplicates("time").reset_index(drop=True)
    df_price["hourly_ret"] = df_price["close"].pct_change()
    lookback_hours = vol_lookback_days * 24
    df_price["rolling_vol"] = (
        df_price["hourly_ret"].shift(1).rolling(window=lookback_hours, min_periods=48).std()
    )
    default_vol = float(df_price["hourly_ret"].std())
    if not np.isfinite(default_vol) or default_vol <= 0:
        default_vol = 0.0035
    df_price["rolling_vol"] = df_price["rolling_vol"].fillna(default_vol)
    df_price["time_bucket"] = df_price["time"].dt.floor(bucket_freq)

    buckets = (
        df_price.groupby("time_bucket")
        .agg(p0=("close", "first"), vol_pre=("rolling_vol", "first"))
        .reset_index()
    )

    close_by_time = df_price.set_index("time")["close"]

    def _close_at(t: pd.Timestamp) -> float:
        idx = close_by_time.index.searchsorted(t)
        if idx >= len(close_by_time):
            return np.nan
        return float(close_by_time.iloc[idx])

    buckets["p_4h"] = buckets["time_bucket"].apply(lambda t: _close_at(t + pd.Timedelta(hours=4)))
    buckets["p_24h"] = buckets["time_bucket"].apply(lambda t: _close_at(t + pd.Timedelta(hours=24)))
    buckets["ret_4h"] = (buckets["p_4h"] - buckets["p0"]) / buckets["p0"]
    buckets["ret_24h"] = (buckets["p_24h"] - buckets["p0"]) / buckets["p0"]
    buckets = buckets.dropna(subset=["ret_4h", "ret_24h"]).reset_index(drop=True)
    print(f"[PriceBuckets] {len(buckets)} buckets ({buckets['time_bucket'].min()} .. {buckets['time_bucket'].max()}).")

    # 2. News aggregated per bucket (sparse: neutral 0 when no article) -------
    news_period: tuple[pd.Timestamp, pd.Timestamp] | None = None
    if os.path.exists(article_parquet):
        df_art = pd.read_parquet(article_parquet)
        df_art["time_published_utc"] = pd.to_datetime(df_art["time_published_utc"], utc=True)
        if not df_art.empty:
            news_period = (
                df_art["time_published_utc"].min(),
                df_art["time_published_utc"].max(),
            )
        df_art["time_bucket"] = df_art["time_published_utc"].dt.floor(bucket_freq)
        text_corpus = (
            df_art["title"].fillna("") + " " + df_art["summary"].fillna("") + " " + df_art["related_event"].fillna("")
        ).str.lower()
        if sentiment_col not in df_art.columns:
            print(f"[PriceBuckets] kolom sentimen {sentiment_col!r} tidak ada; memakai overall_sentiment_score.")
            sentiment_col = "overall_sentiment_score"
        # Relevansi emas: berita yang benar-benar soal emas dibobot penuh,
        # berita umum dikurangi (floor) supaya tidak "mengotori" fitur sentimen.
        if gold_weighting:
            from src.features.gold_relevance import add_gold_relevance, apply_relevance_to_sentiment

            df_art = add_gold_relevance(df_art)
            df_art = apply_relevance_to_sentiment(df_art, sentiment_col=sentiment_col)
            sentiment_col = f"{sentiment_col}_weighted"
            print(f"[PriceBuckets] Gold relevance weighting aktif (kolom {sentiment_col!r}).")
        for topic_col, pattern in TOPIC_PATTERNS.items():
            df_art[topic_col] = text_corpus.str.contains(pattern, regex=True).astype(float)
            short = topic_col.replace("topic_", "")
            df_art[f"sentiment_x_{short}"] = df_art[sentiment_col] * df_art[topic_col]
            df_art[f"{topic_col}_x_sentiment"] = df_art[f"sentiment_x_{short}"]

        agg_spec = {
            "id": "count",
            sentiment_col: ["mean", "min", "max"],
            "title": lambda s: " ".join(s.dropna()),
            "summary": lambda s: " ".join(s.dropna()),
            "related_event": lambda s: " ".join(s.dropna()),
        }
        for topic_col in TOPIC_PATTERNS:
            agg_spec[topic_col] = "max"
            short = topic_col.replace("topic_", "")
            agg_spec[f"sentiment_x_{short}"] = "mean"
            agg_spec[f"{topic_col}_x_sentiment"] = "mean"

        news_b = df_art.groupby("time_bucket").agg(agg_spec)
        flat = []
        for c in news_b.columns:
            if isinstance(c, tuple):
                if c[0] == sentiment_col:
                    flat.append("sentiment_score" if c[1] == "mean" else f"sentiment_{c[1]}")
                elif c[0] == "id":
                    flat.append("article_count")
                else:
                    flat.append(c[0])
            else:
                flat.append(c)
        news_b.columns = flat
        news_b = news_b.reset_index()
        buckets = buckets.merge(news_b, on="time_bucket", how="left")
    else:
        buckets["article_count"] = 0
        buckets["sentiment_score"] = 0.0
        buckets["sentiment_min"] = 0.0
        buckets["sentiment_max"] = 0.0
        buckets["title"] = ""
        buckets["summary"] = ""
        buckets["related_event"] = ""
        for topic_col in TOPIC_PATTERNS:
            buckets[topic_col] = 0.0
            short = topic_col.replace("topic_", "")
            buckets[f"sentiment_x_{short}"] = 0.0
            buckets[f"{topic_col}_x_sentiment"] = 0.0

    news_cols = (
        ["article_count", "sentiment_score", "sentiment_min", "sentiment_max"]
        + [c for c in buckets.columns if c.startswith("topic_") or c.startswith("sentiment_x_")]
    )
    for c in news_cols:
        buckets[c] = buckets[c].fillna(0.0)
    for c in ("title", "summary", "related_event"):
        buckets[c] = buckets[c].fillna("")

    # 3. Calendar: carry-forward surprise + in-window event flag -------------
    df_cal = pd.read_csv(calendar_csv)
    df_cal["timestamp_utc"] = pd.to_datetime(df_cal["timestamp_utc"], utc=True)
    real_cal = df_cal.copy()
    if "is_simulated" in real_cal.columns:
        real_cal = real_cal[~real_cal["is_simulated"].fillna(True).astype(bool)]
    real_cal = real_cal.dropna(subset=["surprise_val"])

    if not real_cal.empty:
        cf_right = (
            real_cal[["timestamp_utc", "event_name", "surprise_val", "z_score"]]
            .sort_values("timestamp_utc")
            .rename(
                columns={
                    "timestamp_utc": "cf_timestamp_utc",
                    "event_name": "cf_event_name",
                    "surprise_val": "surprise_val_cf",
                    "z_score": "z_score_cf",
                }
            )
        )
        buckets = pd.merge_asof(
            buckets.sort_values("time_bucket"),
            cf_right,
            left_on="time_bucket",
            right_on="cf_timestamp_utc",
            direction="backward",
        )
        buckets["surprise_age_hours"] = (
            buckets["time_bucket"] - buckets["cf_timestamp_utc"]
        ).dt.total_seconds() / 3600.0
        buckets["surprise_val"] = buckets["surprise_val_cf"]
        buckets["z_score"] = buckets["z_score_cf"]
        buckets["related_event"] = buckets["cf_event_name"].fillna("") + buckets["related_event"].fillna("")
        buckets = buckets.drop(columns=["cf_timestamp_utc", "cf_event_name", "surprise_val_cf", "z_score_cf"])

        def _has_event(t: pd.Timestamp) -> int:
            nxt = t + pd.Timedelta(hours=4)
            return int(((real_cal["timestamp_utc"] >= t) & (real_cal["timestamp_utc"] < nxt)).any())

        buckets["has_event"] = buckets["time_bucket"].apply(_has_event)
    else:
        buckets["surprise_val"] = np.nan
        buckets["z_score"] = np.nan
        buckets["surprise_age_hours"] = np.nan
        buckets["has_event"] = 0

    # 3b. Interaksi sentimen × surprise makro.
    # Temuan: sentimen hanya membawa sinyal saat surprise makro POSITIF
    # (z > 0.5): return berita positif +0,0408% vs negatif -0,1788% (p=0,005).
    # Saat surprise negatif, sentimen tidak ada sinyal (p=0,955) — jadi
    # interaksi ini memisahkan "sentimen yang relevan" dari "sentimen yang
    # tidak relevan", bukan mencampur keduanya.
    z = buckets["z_score"].fillna(0.0)
    sent = buckets["sentiment_score"].fillna(0.0)
    buckets["sentiment_x_surprise_pos"] = sent * (z > 0.5).astype(float)
    buckets["sentiment_x_surprise_neg"] = sent * (z < -0.5).astype(float)

    # 4. Temporal / session --------------------------------------------------
    buckets["hour_utc"] = buckets["time_bucket"].dt.hour
    buckets["dayofweek"] = buckets["time_bucket"].dt.day_of_week
    buckets["session"] = buckets["hour_utc"].apply(_assign_session)
    session_dummies = pd.get_dummies(buckets["session"], prefix="session", dtype=float)
    for col in SESSIONS:
        if col not in session_dummies.columns:
            session_dummies[col] = 0.0
    buckets = pd.concat([buckets, session_dummies[SESSIONS]], axis=1)

    # 5. Point-in-Time lagged macro context ---------------------------------
    if os.path.exists(macro_csv):
        df_m = pd.read_csv(macro_csv)
        df_m["date"] = pd.to_datetime(df_m["date"], utc=True)
        buckets["date_key"] = buckets["time_bucket"].dt.floor("1D")
        macro_keep_cols = [
            "date",
            "macro_us10y_lag1d", "macro_us10y_delta1d", "macro_us10y_delta5d",
            "macro_dxy_lag1d", "macro_dxy_delta1d", "macro_dxy_delta5d",
            "macro_oil_lag1d", "macro_oil_delta1d", "macro_oil_delta5d",
        ]
        df_m_clean = df_m[[c for c in macro_keep_cols if c in df_m.columns]].sort_values("date")
        buckets = pd.merge_asof(
            buckets.sort_values("time_bucket"),
            df_m_clean,
            left_on="date_key",
            right_on="date",
            direction="backward",
        ).drop(columns=["date_key", "date"])

    # 6. Split (chronological by default, or news-era) -----------------------
    buckets = buckets.sort_values("time_bucket").reset_index(drop=True)
    n_total = len(buckets)
    embargo_delta = pd.Timedelta(hours=embargo_hours)

    if split_mode == "news_era":
        t_train_end, t_val_end = _news_era_boundaries(
            news_period=news_period,
            buckets=buckets,
            train_ratio=train_ratio,
            val_ratio=val_ratio,
            embargo_delta=embargo_delta,
        )
    else:
        n_train = int(n_total * train_ratio)
        n_val = int(n_total * val_ratio)
        n_val = min(n_val, n_total - n_train)
        t_train_end = buckets.iloc[n_train]["time_bucket"]
        t_val_end = buckets.iloc[n_train + n_val]["time_bucket"]

    splits = []
    for _, row in buckets.iterrows():
        t = row["time_bucket"]
        if t < t_train_end - embargo_delta:
            splits.append("train")
        elif t < t_train_end:
            splits.append("embargo")
        elif t < t_val_end - embargo_delta:
            splits.append("val")
        elif t < t_val_end:
            splits.append("embargo")
        else:
            splits.append("test")
    buckets["split"] = splits

    if split_mode == "news_era":
        coverage = report_split_coverage(buckets)
        print(f"[PriceBuckets] news_era coverage: {coverage}")

    # 6b. Topic weighting (anti look-ahead: fit on train only) ---------------
    if topic_weighting:
        from src.features.topic_weights import apply_topic_weights, fit_and_save_topic_weights

        weights_path = os.path.join(
            os.path.dirname(output_parquet) or ".", "topic_weights.json"
        )
        topic_weights = fit_and_save_topic_weights(buckets, weights_path)
        buckets = apply_topic_weights(buckets, topic_weights)
        # overall_sentiment_score mirrors sentiment_score -> keep them in sync.
        buckets["overall_sentiment_score"] = buckets["sentiment_score"]
        print(f"[PriceBuckets] Topic weights applied: {topic_weights}")

    # 7. TF-IDF fitted strictly on train ------------------------------------
    buckets["text_full"] = buckets["title"].fillna("") + " " + buckets["summary"].fillna("")
    train_mask = buckets["split"] == "train"
    train_texts = buckets.loc[train_mask, "text_full"]
    train_texts = train_texts[train_texts.str.strip().str.len() > 0]
    if train_texts.empty:
        # Berita belum ada di periode training (mis. RSS hanya ~14 hari terakhir
        # dan jatuh di split test). Fitur teks dilewati, bukan diisi karangan.
        print("[PriceBuckets] Tidak ada teks berita di train; fitur TF-IDF dilewati.")
    else:
        tfidf = TfidfVectorizer(
            max_features=tfidf_max_features, ngram_range=(1, 2), stop_words="english", lowercase=True
        )
        tfidf.fit(train_texts)
        tfidf_mat = tfidf.transform(buckets["text_full"]).toarray()
        tfidf_cols = [f"tfidf_{i}" for i in range(tfidf_mat.shape[1])]
        df_tfidf = pd.DataFrame(tfidf_mat, columns=tfidf_cols, index=buckets.index)
        buckets = pd.concat([buckets, df_tfidf], axis=1)

    # 7b. Embedding kalimat (MiniLM -> PCA fit on train only) -----------------
    #     Bucket tanpa berita dapat nilai netral (0), bukan NaN liar. Bila
    #     encoder gagal, fitur ini dilewati dan status tercatat sebagai
    #     "unavailable" — pipeline tidak crash dan tidak mengarang pengganti.
    emb_meta: dict = {"status": "unavailable", "reason": "embeddings=False"}
    if embeddings:
        from src.features.embeddings import build_bucket_embeddings

        df_emb, emb_meta = build_bucket_embeddings(
            buckets,
            text_col="text_full",
            split_col="split",
            n_components=embedding_n_components,
            cache_dir=embedding_cache_dir,
        )
        if emb_meta.get("status") == "ok":
            buckets = pd.concat([buckets, df_emb], axis=1)
            print(
                f"[PriceBuckets] Embedding: {emb_meta['n_components']} komponen "
                f"(explained_variance={emb_meta['explained_variance']}, "
                f"fit pada {emb_meta['n_train_fit']} bucket train berteks, "
                f"{emb_meta['n_neutral']} bucket netral)."
            )
        else:
            print(f"[PriceBuckets] Embedding dilewati: {emb_meta.get('reason')}")
    buckets["embedding_status"] = str(emb_meta.get("status"))
    buckets["embedding_reason"] = str(emb_meta.get("reason") or "")

    # 8. Direction / provenance ---------------------------------------------
    buckets["sign_4h"] = np.sign(buckets["ret_4h"]).astype(int)
    buckets["sign_24h"] = np.sign(buckets["ret_24h"]).astype(int)
    buckets["direction_4h"] = buckets["sign_4h"]
    buckets["direction_24h"] = buckets["sign_24h"]
    buckets["binary_direction_4h"] = (buckets["ret_4h"] > 0).astype(int)
    buckets["binary_direction_24h"] = (buckets["ret_24h"] > 0).astype(int)
    buckets["overall_sentiment_score"] = buckets["sentiment_score"]
    buckets["is_event_window"] = buckets["has_event"]
    buckets["event_name"] = buckets["related_event"]
    buckets["data_source"] = (
        "yfinance GC=F | rss_feeds+vader | bls_api_v2+fred_csv | yfinance ^TNX/DX-Y.NYB/CL=F"
    )
    buckets["generated_at"] = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M:%S+00:00")

    os.makedirs(os.path.dirname(output_parquet), exist_ok=True)
    buckets.to_parquet(output_parquet, index=False)
    print(
        f"[PriceBuckets] Output saved: {output_parquet} "
        f"({len(buckets)} rows, {len(buckets.columns)} cols). "
        f"Split counts: {dict(buckets['split'].value_counts())}"
    )
    return buckets


if __name__ == "__main__":
    build_price_history_buckets()
