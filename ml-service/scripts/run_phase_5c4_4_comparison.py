"""
StockSense AI — Phase 5C.4.4 Model Comparison Runner Script
Executes multi-horizon model comparison, eligibility gate evaluations,
and validation-stage research candidate selection using frozen validation artifacts.
Saves the deterministic comparison report JSON artifact.
"""

import os
import sys
import argparse

# Ensure ml-service root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.comparison import ModelComparisonService


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 5C.4.4 Advanced Model Comparison")
    parser.add_argument(
        "--report-id",
        type=str,
        default="phase_5c4_4_model_comparison_report",
        help="Unique report identifier",
    )
    parser.add_argument(
        "--output-path",
        type=str,
        default=os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "..",
                "models",
                "evaluations",
                "phase_5c4_4",
                "model_comparison_report.json",
            )
        ),
        help="Destination path for serialized report JSON",
    )
    args = parser.parse_args()

    service = ModelComparisonService()
    report = service.generate_full_comparison_report(report_id=args.report_id)
    saved_path = service.export_report_json(report, args.output_path)

    print("=" * 80)
    print("StockSense AI — Phase 5C.4.4 Model Comparison Report Generated")
    print("=" * 80)
    print(f"Report ID: {report.report_id}")
    print(f"Saved Report JSON: {saved_path}")
    print(f"Canonical Dataset SHA-256: {report.dataset_sha256}")
    print(f"Validation Window: {report.validation_start_date} to {report.validation_end_date}")
    print(f"Quarantined Test Window: {report.quarantined_test_start_date} to {report.quarantined_test_end_date}")
    print("\n" + service.generate_markdown_table(report))
    print("\nPreferred Research Candidates:")
    for h in [1, 3, 5]:
        summary = report.horizons[h]
        print(f"  h={h}: {summary.preferred_candidate_family} ({summary.preferred_candidate_id})")
    print("\n" + report.governance_notes)
    print("=" * 80)


if __name__ == "__main__":
    main()
