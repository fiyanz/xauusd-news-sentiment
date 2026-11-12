"""Live inference engine: generate 4H XAUUSD return and directional forecast using the trained model."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
import yaml


def load_config() -> dict:
    for path in [Path("config.yaml"), Path("services/sentiment-analysis/config.yaml")]:
        if path.exists():
            with open(path, "r") as f:
                return yaml.safe_load(f)
    return {}


def generate_live_prediction(
    features_parquet: str = "data/processed/bucketed_features.parquet",
    model_bundle_path: str = "models/champion_fair_model.joblib",
    output_json_path: str = "data/processed/latest_prediction.json",
    current_gold_price: float = None,
) -> dict:
    """Read latest market data, run inference with champion model, and emit real-time prediction payload."""
    os.makedirs(os.path.dirname(output_json_path), exist_ok=True)
    df = pd.read_parquet(features_parquet)

    # Get latest row
    latest_row = df.sort_values("time_bucket").iloc[-1]
    bucket_time = latest_row["time_bucket"]
    base_p0 = float(latest_row["p0"]) if current_gold_price is None else current_gold_price

    bundle = joblib.load(model_bundle_path)
    model = bundle["champion_model"]
    feature_cols = bundle["champion_feature_cols"]
    champion_name = bundle.get("champion_name", "Random_Forest")

    # Extract feature vector. The fitted reducer (scaler + PCA per block) is
    # applied so the live row matches the training representation; NaN (e.g. no
    # macro event in the news window) is imputed with 0.0 — the same neutral
    # encoding used during training.
    reducer = bundle.get("reducer")
    if reducer is not None:
        X_live = reducer.transform_row(latest_row)
    else:
        X_live = latest_row[feature_cols].fillna(0.0).values.reshape(1, -1).astype(float)
    pred_return_4h = float(model.predict(X_live)[0])

    # Convert to expected target price and pips
    expected_price_change = base_p0 * pred_return_4h
    target_price_4h = round(base_p0 + expected_price_change, 2)
    expected_pips = round(expected_price_change * 10, 1)

    # Determine signal classification
    vol_pre = float(latest_row["vol_pre"])
    threshold = 0.5 * vol_pre

    if pred_return_4h > threshold:
        signal = "BULLISH"
        sentiment_label = "Menguat (Bullish)"
    elif pred_return_4h < -threshold:
        signal = "BEARISH"
        sentiment_label = "Melemah (Bearish)"
    else:
        signal = "NEUTRAL"
        sentiment_label = "Datar (Netral)"

    # Confidence calculation: magnitude relative to normal volatility band.
    # No artificial floor -- a low-conviction prediction must report low confidence.
    confidence = min(round(float(abs(pred_return_4h) / (vol_pre * 1.5 + 1e-8)) * 100, 1), 95.0)

    # Top Macro Drivers breakdown
    macro_drivers = []
    if "macro_dxy_delta1d" in latest_row:
        dxy_d1 = float(latest_row["macro_dxy_delta1d"])
        macro_drivers.append({
            "driver": "US Dollar Index (DXY Δ1D)",
            "value": f"{dxy_d1:+.2f}",
            "impact_on_gold": "Bearish Emas" if dxy_d1 > 0 else "Bullish Emas",
        })
    if "macro_us10y_lag1d" in latest_row:
        us10y = float(latest_row["macro_us10y_lag1d"])
        macro_drivers.append({
            "driver": "US 10Y Yield",
            "value": f"{us10y:.2f}%",
            "impact_on_gold": "Opportunity cost tinggi" if us10y > 4.0 else "Normal",
        })
    if "z_score" in latest_row and pd.notna(latest_row["z_score"]):
        z = float(latest_row["z_score"])
        macro_drivers.append({
            "driver": "Kejutan Kalender Makro",
            "value": f"Z={z:+.2f} ({latest_row.get('related_event', 'Macro Event')})",
            "impact_on_gold": "Deviasi rilis terhadap konsensus",
        })

    payload = {
        "status": "success",
        "timestamp_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "bucket_time_utc": str(bucket_time),
        "model_champion": champion_name,
        "current_price": round(base_p0, 2),
        "prediction_horizon": "4 Jam (4H)",
        "predicted_return_pct": round(pred_return_4h * 100, 4),
        "predicted_target_price": target_price_4h,
        "predicted_pips_delta": f"{expected_pips:+.1f} pips",
        "signal": signal,
        "sentiment_label": sentiment_label,
        "confidence_pct": confidence,
        "confidence_method": "abs(predicted_return_4h) / (1.5 * vol_pre), capped at 95%; no artificial floor",
        "threshold": round(float(threshold), 6),
        "threshold_pct": round(float(threshold) * 100, 4),
        "vol_pre": round(float(vol_pre), 6),
        "macro_drivers": macro_drivers,
        "compliance": "FR-10 Validated: Murni Analisis Informasi / Bukan Sinyal Trading Otomatis",
    }

    with open(output_json_path, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"[Predict] Live inference completed successfully!")
    print(f"          Signal: {signal} ({pred_return_4h*100:+.2f}%) | Target 4H: ${target_price_4h} ({expected_pips:+.1f}p)")
    print(f"          Saved to: {output_json_path}")
    return payload


if __name__ == "__main__":
    generate_live_prediction()
