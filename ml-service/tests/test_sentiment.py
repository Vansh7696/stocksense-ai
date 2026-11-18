"""
StockSense AI — Financial Sentiment & Market News Intelligence Tests (Phase 5C.9)
Tests financial lexicon scoring, negation handling, headline aggregation,
Bayesian probability fusion, and FastAPI sentiment endpoints.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.schemas.sentiment import SentimentLabel, AlignmentStatus
from app.services.sentiment import FinancialSentimentAnalyzer


client = TestClient(app)


class TestFinancialSentimentAnalyzer:
    def setup_method(self):
        self.analyzer = FinancialSentimentAnalyzer()

    def test_bullish_headline_classification(self):
        """Verifies that positive corporate news produces a bullish polarity and label."""
        text = "Reliance Q2 net profit surges 28% as retail revenue beats analyst estimates"
        polarity, label, confidence, drivers = self.analyzer.analyze_text(text)

        assert polarity > 0.15
        assert label == SentimentLabel.BULLISH
        assert confidence > 0.5
        assert any("surge" in d or "profit" in d or "beat" in d for d in drivers)

    def test_bearish_headline_classification(self):
        """Verifies that negative corporate news produces a bearish polarity and label."""
        text = "Company reports steep loss amid margin compression and ongoing SEBI probe"
        polarity, label, confidence, drivers = self.analyzer.analyze_text(text)

        assert polarity < -0.15
        assert label == SentimentLabel.BEARISH
        assert confidence > 0.5
        assert any("loss" in d or "probe" in d or "margin compression" in d for d in drivers)

    def test_negation_inversion(self):
        """Verifies that negation terms invert the sign of positive terms."""
        pos_text = "Tech giant reports profit growth"
        neg_text = "Tech giant failed to report profit growth"

        pos_pol, pos_lbl, _, _ = self.analyzer.analyze_text(pos_text)
        neg_pol, neg_lbl, _, _ = self.analyzer.analyze_text(neg_text)

        assert pos_pol > 0
        assert neg_pol < pos_pol

    def test_neutral_headline(self):
        """Verifies that neutral statements produce polarity near zero."""
        text = "Board meeting scheduled for November 25 to consider unaudited financial results"
        polarity, label, confidence, drivers = self.analyzer.analyze_text(text)

        assert abs(polarity) < 0.15
        assert label == SentimentLabel.NEUTRAL

    def test_summary_for_known_symbol(self):
        """Verifies that summary generation for blue chips succeeds with structured headlines."""
        summary = self.analyzer.get_summary_for_symbol("RELIANCE")

        assert summary.symbol == "RELIANCE"
        assert summary.sample_count >= 3
        assert len(summary.headlines) >= 3
        assert 0.0 <= summary.bullish_ratio <= 1.0
        assert 0.0 <= summary.bearish_ratio <= 1.0
        assert 0.0 <= summary.neutral_ratio <= 1.0


class TestMultiFactorFusion:
    def setup_method(self):
        self.analyzer = FinancialSentimentAnalyzer()

    def test_confirming_bullish_fusion_boosts_up_probability(self):
        """When technical model is bullish and sentiment is positive, UP probability is boosted."""
        from app.schemas.sentiment import MultiFactorFusionRequest

        req = MultiFactorFusionRequest(
            symbol="RELIANCE",
            horizon=1,
            technical_probabilities={"DOWN": 0.20, "NEUTRAL": 0.35, "UP": 0.45},
            sentiment_polarity=0.60,
            fusion_weight=0.25,
        )
        fused = self.analyzer.fuse_prediction_with_sentiment(req)

        assert fused.alignment == AlignmentStatus.CONFIRMING
        assert fused.fused_probabilities["UP"] > 0.45
        assert fused.fused_probabilities["DOWN"] < 0.20
        assert abs(sum(fused.fused_probabilities.values()) - 1.0) < 0.001
        assert "confirms" in fused.alignment_description

    def test_contradicting_sentiment_detects_divergence_risk(self):
        """When technical model is bullish but sentiment is strongly negative, divergence is flagged."""
        from app.schemas.sentiment import MultiFactorFusionRequest

        req = MultiFactorFusionRequest(
            symbol="TCS",
            horizon=3,
            technical_probabilities={"DOWN": 0.15, "NEUTRAL": 0.35, "UP": 0.50},
            sentiment_polarity=-0.50,
            fusion_weight=0.25,
        )
        fused = self.analyzer.fuse_prediction_with_sentiment(req)

        assert fused.alignment == AlignmentStatus.CONTRADICTING
        assert fused.fused_probabilities["UP"] < 0.50
        assert fused.fused_probabilities["DOWN"] > 0.15
        assert "contradicts" in fused.alignment_description


class TestSentimentAPIEndpoints:
    def test_analyze_endpoint(self):
        """Verifies POST /api/sentiment/analyze."""
        payload = {
            "symbol": "INFY",
            "headlines": [
                {
                    "title": "Infosys raises revenue guidance on massive deal expansion",
                    "source": "Mint",
                    "published_at": "2026-11-18T08:00:00Z",
                },
                {
                    "title": "Global tech client consolidation continues",
                    "source": "Reuters",
                    "published_at": "2026-11-18T07:30:00Z",
                },
            ],
        }
        res = client.post("/api/sentiment/analyze", json=payload)
        assert res.status_code == 200, res.text
        data = res.json()

        assert data["symbol"] == "INFY"
        assert data["sample_count"] == 2
        assert len(data["headlines"]) == 2
        assert data["overall_polarity"] > 0

    def test_summary_endpoint(self):
        """Verifies GET /api/sentiment/summary/TCS."""
        res = client.get("/api/sentiment/summary/TCS")
        assert res.status_code == 200, res.text
        data = res.json()

        assert data["symbol"] == "TCS"
        assert data["sample_count"] >= 1
        assert "overall_polarity" in data
        assert "overall_label" in data

    def test_fuse_endpoint(self):
        """Verifies POST /api/sentiment/fuse."""
        payload = {
            "symbol": "HDFCBANK",
            "horizon": 1,
            "technical_probabilities": {"DOWN": 0.25, "NEUTRAL": 0.35, "UP": 0.40},
            "sentiment_polarity": 0.45,
            "fusion_weight": 0.2,
        }
        res = client.post("/api/sentiment/fuse", json=payload)
        assert res.status_code == 200, res.text
        data = res.json()

        assert data["symbol"] == "HDFCBANK"
        assert "fused_probabilities" in data
        assert "alignment" in data
        assert "alignment_description" in data
