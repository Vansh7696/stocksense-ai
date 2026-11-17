"""
StockSense AI — Phase 5C.4.3 Hyperparameter Tuning Runner Script
Executes the systematic 810-configuration tuning campaign across Random Forest
and XGBoost for horizons h1, h3, and h5 using the approved 23 technical features.
"""

import os
import sys
import argparse
import time

# Ensure ml-service root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.tuning import AdvancedTuningOrchestrator


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 5C.4.3 Advanced Model Tuning Campaign")
    parser.add_argument(
        "--experiment-id",
        type=str,
        default="phase_5c4_3_tuning_campaign",
        help="Unique experiment identifier",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=min(4, os.cpu_count() or 1),
        help="Maximum CPU worker threads for tree training",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=True,
        help="Resume existing experiment if checkpoints exist",
    )
    args = parser.parse_args()

    t_start = time.perf_counter()
    orchestrator = AdvancedTuningOrchestrator(
        experiment_id=args.experiment_id,
        max_workers=args.max_workers,
        resume=args.resume,
    )

    summary = orchestrator.run_tuning(
        horizons=(1, 3, 5),
        models=("random_forest", "xgboost"),
    )

    t_total = time.perf_counter() - t_start
    print(f"\nTotal Wall-Clock Time: {t_total:.2f} seconds ({t_total/60:.2f} minutes)")


if __name__ == "__main__":
    main()
