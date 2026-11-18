"""
StockSense AI — Financial Sentiment & Market News Intelligence Service (Phase 5C.9)
High-performance domain-specific sentiment analysis for Indian financial news (NSE/BSE),
incorporating market terminology, negation dynamics, and multi-factor Bayesian fusion.
"""

import re
import math
import datetime
from typing import Dict, List, Tuple, Optional, Any
import numpy as np

from app.schemas.sentiment import (
    SentimentLabel,
    AlignmentStatus,
    HeadlineItem,
    AnalyzedHeadline,
    SentimentSummaryResponse,
    MultiFactorFusionRequest,
    MultiFactorFusionResponse,
)


# Domain-specific financial lexicon scored from -3.0 (extremely bearish) to +3.0 (extremely bullish)
FINANCIAL_LEXICON: Dict[str, float] = {
    # Bullish financial terms & Indian market phrases
    "surge": 2.2,
    "surges": 2.2,
    "surged": 2.2,
    "jump": 2.0,
    "jumps": 2.0,
    "jumped": 2.0,
    "profit": 1.5,
    "profits": 1.5,
    "growth": 1.6,
    "grow": 1.4,
    "grows": 1.4,
    "record high": 2.8,
    "all-time high": 2.8,
    "outperform": 2.2,
    "outperformed": 2.2,
    "outperforms": 2.2,
    "beat": 2.0,
    "beats": 2.0,
    "beating": 1.8,
    "dividend": 1.4,
    "bonus issue": 1.8,
    "buyback": 2.0,
    "expansion": 1.6,
    "fii buying": 2.4,
    "dii buying": 2.0,
    "inflow": 1.8,
    "inflows": 1.8,
    "bullish": 2.4,
    "rally": 2.0,
    "rallies": 2.0,
    "rallied": 2.0,
    "order win": 2.2,
    "order book expands": 2.5,
    "capacity expansion": 2.0,
    "guidance upgrade": 2.6,
    "upgraded": 2.2,
    "upgrade": 2.2,
    "margin expansion": 2.4,
    "operating leverage": 2.0,
    "debt reduction": 2.2,
    "robust demand": 2.2,
    "strong demand": 2.0,
    "strong": 1.4,
    "rebound": 1.8,
    "rebounds": 1.8,
    "multibagger": 2.6,
    "positive": 1.2,
    "turnaround": 2.2,
    "synergy": 1.6,

    # Bearish financial terms & Indian market phrases
    "plunge": -2.6,
    "plunges": -2.6,
    "plunged": -2.6,
    "slump": -2.4,
    "slumps": -2.4,
    "slumped": -2.4,
    "loss": -2.0,
    "losses": -2.0,
    "drop": -1.8,
    "drops": -1.8,
    "dropped": -1.8,
    "fall": -1.6,
    "falls": -1.6,
    "fallen": -1.6,
    "decline": -1.8,
    "declines": -1.8,
    "declined": -1.8,
    "down": -1.2,
    "downgrade": -2.4,
    "downgraded": -2.4,
    "downgrades": -2.4,
    "miss": -2.0,
    "misses": -2.0,
    "missed": -2.0,
    "probe": -2.5,
    "sebi probe": -2.8,
    "rbi penalty": -2.6,
    "fraud": -3.0,
    "scam": -3.0,
    "fii selling": -2.4,
    "outflow": -2.0,
    "outflows": -2.0,
    "bearish": -2.4,
    "margin compression": -2.5,
    "promoter pledge": -2.4,
    "pledge increase": -2.2,
    "default": -3.0,
    "defaults": -3.0,
    "headwind": -1.8,
    "headwinds": -1.8,
    "weak": -1.6,
    "weakness": -1.8,
    "inflation surge": -1.8,
    "repo rate hike": -1.6,
    "crude surge": -1.4,  # High crude is a drag on Indian CAD/equities
    "debt spike": -2.2,
    "audit qualification": -2.8,
    "investigation": -2.4,
    "subpoena": -2.6,
    "litigation": -1.8,
    "lawsuit": -2.0,
    "underperform": -2.2,
    "sluggish": -1.6,
}

NEGATION_TERMS = {
    "not", "never", "no", "without", "barely", "hardly", "scarcely",
    "failed", "fails", "failing", "unable", "denies", "denied"
}

BOOSTER_TERMS = {
    "sharp": 1.5,
    "sharply": 1.5,
    "massive": 1.8,
    "drastic": 1.6,
    "significant": 1.4,
    "significantly": 1.4,
    "substantial": 1.4,
    "huge": 1.5,
    "slight": 0.6,
    "slightly": 0.6,
    "marginal": 0.5,
    "marginally": 0.5,
}

DEFAULT_SAMPLE_NEWS: Dict[str, List[Dict[str, str]]] = {
    "RELIANCE": [
        {
            "title": "Reliance Retail expansion accelerates as quarterly revenue beats analyst estimates",
            "source": "Economic Times",
            "published_at": "2026-11-18T04:30:00Z",
        },
        {
            "title": "Jio adds record 4G/5G subscribers with solid ARPU expansion",
            "source": "Mint",
            "published_at": "2026-11-17T11:15:00Z",
        },
        {
            "title": "Oil-to-Chemicals segment sees slight margin compression amid global crude volatility",
            "source": "Business Standard",
            "published_at": "2026-11-16T08:00:00Z",
        },
        {
            "title": "FII buying in Reliance surges to multi-month high ahead of AGM announcements",
            "source": "Reuters India",
            "published_at": "2026-11-15T14:20:00Z",
        },
    ],
    "TCS": [
        {
            "title": "TCS bags mega $1.2B digital transformation deal with European financial major",
            "source": "Economic Times",
            "published_at": "2026-11-18T05:00:00Z",
        },
        {
            "title": "Attrition drops to lowest level in 8 quarters as operating margin expands to 25.5%",
            "source": "Mint",
            "published_at": "2026-11-17T09:30:00Z",
        },
        {
            "title": "IT sector discretionary spending headwinds show signs of steady recovery",
            "source": "CNBC-TV18",
            "published_at": "2026-11-16T12:00:00Z",
        },
    ],
    "INFY": [
        {
            "title": "Infosys raises full-year constant currency revenue growth guidance on strong deal pipeline",
            "source": "Business Standard",
            "published_at": "2026-11-18T03:45:00Z",
        },
        {
            "title": "Large deal wins cross $3 billion in Q2 with AI-first Topaz platform adoption",
            "source": "Mint",
            "published_at": "2026-11-17T10:15:00Z",
        },
    ],
    "HDFCBANK": [
        {
            "title": "HDFC Bank deposit growth outpaces credit growth as merger synergies solidify",
            "source": "Financial Express",
            "published_at": "2026-11-18T06:10:00Z",
        },
        {
            "title": "Gross NPA improves to 1.24% while net interest income jumps 11% year-on-year",
            "source": "Economic Times",
            "published_at": "2026-11-17T13:40:00Z",
        },
    ],
    "ICICIBANK": [
        {
            "title": "ICICI Bank delivers record quarterly net profit driven by robust retail loan growth",
            "source": "Mint",
            "published_at": "2026-11-18T04:50:00Z",
        },
        {
            "title": "Asset quality remains pristine with domestic net interest margin steady at 4.36%",
            "source": "Business Standard",
            "published_at": "2026-11-16T15:00:00Z",
        },
    ],
}


class FinancialSentimentAnalyzer:
    """
    High-performance rule-based financial sentiment analyzer tailored for Indian market equities.
    """

    def __init__(self):
        # Compile multi-word phrases for greedy matching
        self._phrases = sorted(
            [k for k in FINANCIAL_LEXICON.keys() if " " in k],
            key=lambda x: len(x),
            reverse=True,
        )

    def analyze_text(self, text: str) -> Tuple[float, SentimentLabel, float, List[str]]:
        """
        Analyzes a single headline or commentary string.

        :param text: Raw text to analyze
        :return: (polarity in [-1.0, 1.0], label, confidence in [0.0, 1.0], key_drivers)
        """
        if not text or not text.strip():
            return 0.0, SentimentLabel.NEUTRAL, 0.0, []

        normalized = text.lower()
        key_drivers: List[str] = []
        raw_score = 0.0
        term_count = 0

        # 1. Match multi-word phrases first
        remaining_text = normalized
        for phrase in self._phrases:
            if phrase in remaining_text:
                score = FINANCIAL_LEXICON[phrase]
                # Check for negation in 3 words preceding phrase
                negated = False
                pattern = rf"(?:(?:not|never|no|failed to|unable to)\s+){{1,2}}{re.escape(phrase)}"
                if re.search(pattern, normalized):
                    score = -score * 0.8
                    negated = True

                raw_score += score
                term_count += 1
                key_drivers.append(f"{'not ' if negated else ''}{phrase}")
                remaining_text = remaining_text.replace(phrase, " ")

        # 2. Tokenize remaining words
        tokens = re.findall(r"\b[a-z0-9_-]+\b", remaining_text)

        for i, token in enumerate(tokens):
            if token in FINANCIAL_LEXICON:
                score = FINANCIAL_LEXICON[token]
                # Check for negation within previous 3 tokens
                prev_tokens = tokens[max(0, i - 3):i]
                is_negated = any(t in NEGATION_TERMS for t in prev_tokens)
                if is_negated:
                    score = -score * 0.8

                # Check for booster word immediately preceding
                if i > 0 and tokens[i - 1] in BOOSTER_TERMS:
                    booster = BOOSTER_TERMS[tokens[i - 1]]
                    score = score * booster

                raw_score += score
                term_count += 1
                driver_text = f"{'not ' if is_negated else ''}{token}"
                if driver_text not in key_drivers:
                    key_drivers.append(driver_text)

        if term_count == 0:
            return 0.0, SentimentLabel.NEUTRAL, 0.5, []

        # Squashing function to map raw score into [-1.0, 1.0]
        # Using hyperbolic tangent with scaling
        polarity = float(np.tanh(raw_score / 3.0))
        polarity = round(max(-1.0, min(1.0, polarity)), 4)

        # Classification thresholds
        if polarity >= 0.15:
            label = SentimentLabel.BULLISH
        elif polarity <= -0.15:
            label = SentimentLabel.BEARISH
        else:
            label = SentimentLabel.NEUTRAL

        confidence = round(min(1.0, 0.5 + abs(polarity) * 0.5), 4)
        return polarity, label, confidence, key_drivers[:5]

    def analyze_headlines(
        self,
        headlines: List[HeadlineItem],
        symbol: str = "EQUITY",
    ) -> SentimentSummaryResponse:
        """
        Analyzes a batch of headlines, computing weighted average polarity and ratios.
        """
        analyzed: List[AnalyzedHeadline] = []
        total_polarity = 0.0
        bullish_count = 0
        bearish_count = 0
        neutral_count = 0

        for h in headlines:
            pol, lbl, conf, drivers = self.analyze_text(h.title)
            analyzed.append(
                AnalyzedHeadline(
                    id=h.id,
                    title=h.title,
                    source=h.source,
                    published_at=h.published_at,
                    polarity=pol,
                    label=lbl,
                    confidence=conf,
                    key_drivers=drivers,
                )
            )
            total_polarity += pol
            if lbl == SentimentLabel.BULLISH:
                bullish_count += 1
            elif lbl == SentimentLabel.BEARISH:
                bearish_count += 1
            else:
                neutral_count += 1

        n = len(headlines)
        if n == 0:
            overall_pol = 0.0
            overall_lbl = SentimentLabel.NEUTRAL
            overall_conf = 0.5
            b_ratio = 0.0
            be_ratio = 0.0
            neu_ratio = 1.0
        else:
            overall_pol = round(total_polarity / n, 4)
            b_ratio = round(bullish_count / n, 4)
            be_ratio = round(bearish_count / n, 4)
            neu_ratio = round(neutral_count / n, 4)

            if overall_pol >= 0.15:
                overall_lbl = SentimentLabel.BULLISH
            elif overall_pol <= -0.15:
                overall_lbl = SentimentLabel.BEARISH
            else:
                overall_lbl = SentimentLabel.NEUTRAL

            overall_conf = round(min(1.0, 0.5 + abs(overall_pol) * 0.5), 4)

        return SentimentSummaryResponse(
            symbol=symbol,
            overall_polarity=overall_pol,
            overall_label=overall_lbl,
            confidence=overall_conf,
            sample_count=n,
            bullish_ratio=b_ratio,
            bearish_ratio=be_ratio,
            neutral_ratio=neu_ratio,
            headlines=analyzed,
            analyzed_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        )

    def get_summary_for_symbol(self, symbol: str) -> SentimentSummaryResponse:
        """
        Returns an analyzed sentiment summary using curated recent news for blue chips
        or generated domain news.
        """
        raw_items = DEFAULT_SAMPLE_NEWS.get(symbol.upper(), [])
        if not raw_items:
            # Fallback for other tickers
            raw_items = [
                {
                    "title": f"{symbol} consolidates ahead of monthly derivatives expiry",
                    "source": "Market News",
                    "published_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                }
            ]

        items = [
            HeadlineItem(
                id=f"news-{i}",
                title=item["title"],
                source=item["source"],
                published_at=item["published_at"],
            )
            for i, item in enumerate(raw_items)
        ]
        return self.analyze_headlines(items, symbol=symbol.upper())

    def fuse_prediction_with_sentiment(
        self,
        req: MultiFactorFusionRequest,
    ) -> MultiFactorFusionResponse:
        """
        Fuses quantitative technical probabilities with news sentiment polarity
        using Bayesian probability updates.
        """
        tech_probs = req.technical_probabilities
        p_down = tech_probs.get("DOWN", 0.33)
        p_neu = tech_probs.get("NEUTRAL", 0.34)
        p_up = tech_probs.get("UP", 0.33)

        s = req.sentiment_polarity  # range [-1.0, 1.0]
        alpha = req.fusion_weight   # range [0.0, 0.5], default 0.25

        # Bayesian-inspired multiplicative updates
        if s > 0:
            # Bullish sentiment boosts UP and dampens DOWN/NEUTRAL
            w_up = p_up * (1.0 + alpha * s)
            w_down = p_down * max(0.05, 1.0 - alpha * s)
            w_neu = p_neu * max(0.05, 1.0 - (alpha * 0.5) * s)
        elif s < 0:
            # Bearish sentiment boosts DOWN and dampens UP/NEUTRAL
            s_abs = abs(s)
            w_up = p_up * max(0.05, 1.0 - alpha * s_abs)
            w_down = p_down * (1.0 + alpha * s_abs)
            w_neu = p_neu * max(0.05, 1.0 - (alpha * 0.5) * s_abs)
        else:
            w_up = p_up
            w_down = p_down
            w_neu = p_neu

        # Normalize to strictly sum to 1.0
        total = w_up + w_down + w_neu
        fused_up = round(w_up / total, 4)
        fused_down = round(w_down / total, 4)
        fused_neu = round(1.0 - fused_up - fused_down, 4)

        fused_probs = {
            "DOWN": fused_down,
            "NEUTRAL": fused_neu,
            "UP": fused_up,
        }

        # Determine dominant fused label and confidence
        max_class = max(fused_probs, key=fused_probs.get)
        confidence = round(fused_probs[max_class], 4)

        # Technical dominant class
        tech_dominant = max(tech_probs, key=tech_probs.get)

        # Classify alignment between technical and sentiment
        if tech_dominant == "UP" and s >= 0.15:
            alignment = AlignmentStatus.CONFIRMING
            desc = f"Qualitative news sentiment (+{s:.2f}) confirms the quantitative bullish forecast for T+{req.horizon}."
        elif tech_dominant == "DOWN" and s <= -0.15:
            alignment = AlignmentStatus.CONFIRMING
            desc = f"Qualitative news sentiment ({s:.2f}) confirms the quantitative bearish forecast for T+{req.horizon}."
        elif (tech_dominant == "UP" and s <= -0.15) or (tech_dominant == "DOWN" and s >= 0.15):
            alignment = AlignmentStatus.CONTRADICTING
            desc = f"News sentiment ({s:+.2f}) contradicts technical forecast ({tech_dominant}), indicating heightened divergence risk."
        else:
            alignment = AlignmentStatus.NEUTRAL_ALIGNMENT
            desc = f"News sentiment ({s:+.2f}) is in a neutral regime, leaving quantitative technical indicators as the primary driver."

        return MultiFactorFusionResponse(
            symbol=req.symbol,
            horizon=req.horizon,
            technical_probabilities=tech_probs,
            sentiment_polarity=s,
            fused_probabilities=fused_probs,
            fused_label=max_class,
            confidence=confidence,
            alignment=alignment,
            alignment_description=desc,
        )
