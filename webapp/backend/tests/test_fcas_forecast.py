import unittest

from app.fcas_forecast import MAX_FCAS_FORECAST_HOURS, build_fcas_forecast


class FCASForecastTests(unittest.TestCase):
    def test_allows_seven_day_horizon(self):
        self.assertEqual(MAX_FCAS_FORECAST_HOURS, 168)

    def test_prefers_p5min_and_calculates_product_stats(self):
        rows = [
            {
                "regionid": "NSW1",
                "interval_datetime": "2026-07-09 16:05:00",
                "source": "PREDISPATCH",
                "run_datetime": "2026-07-09 15:30:00",
                "raisereg": 4.0,
                "raise6sec": 2.0,
                "lowerreg": 1.0,
            },
            {
                "regionid": "NSW1",
                "interval_datetime": "2026-07-09 16:05:00",
                "source": "P5MIN",
                "run_datetime": "2026-07-09 16:00:00",
                "raisereg": 8.0,
                "raise6sec": 3.0,
                "lowerreg": 1.0,
            },
            {
                "regionid": "NSW1",
                "interval_datetime": "2026-07-09 16:10:00",
                "source": "P5MIN",
                "run_datetime": "2026-07-09 16:00:00",
                "raisereg": 10.0,
                "raise6sec": 4.0,
                "lowerreg": 2.0,
            },
        ]

        out = build_fcas_forecast(rows, focus_region="NSW1", power_mw=10.0)

        self.assertEqual(out["region"], "NSW1")
        self.assertEqual(out["interval_count"], 2)
        self.assertEqual(out["run_datetime"], "2026-07-09T16:00:00")
        self.assertEqual(out["intervals"][0]["source"], "P5MIN")
        self.assertEqual(out["intervals"][0]["prices"]["raisereg"], 8.0)

        rreg = next(p for p in out["products"] if p["market"] == "raisereg")
        self.assertEqual(rreg["code"], "RREG")
        self.assertAlmostEqual(rreg["avg_price"], 9.0)
        self.assertAlmostEqual(rreg["peak_price"], 10.0)
        self.assertAlmostEqual(rreg["revenue_aud"], 15.0)
        self.assertEqual(rreg["trend"], "up")

        self.assertEqual(out["recommendation"]["market"], "raisereg")
        self.assertEqual(out["recommendation"]["code"], "RREG")

    def test_region_summaries_pick_best_average_market(self):
        rows = [
            {
                "regionid": "NSW1",
                "interval_datetime": "2026-07-09 16:05:00",
                "source": "P5MIN",
                "run_datetime": "2026-07-09 16:00:00",
                "raisereg": 5.0,
                "raise6sec": 12.0,
                "lowerreg": 1.0,
            },
            {
                "regionid": "QLD1",
                "interval_datetime": "2026-07-09 16:05:00",
                "source": "P5MIN",
                "run_datetime": "2026-07-09 16:00:00",
                "raisereg": 18.0,
                "raise6sec": 4.0,
                "lowerreg": 2.0,
            },
        ]

        out = build_fcas_forecast(rows, focus_region="NSW1", power_mw=5.0)

        summaries = {r["regionid"]: r for r in out["regions"]}
        self.assertEqual(summaries["NSW1"]["best_market"], "raise6sec")
        self.assertEqual(summaries["NSW1"]["best_code"], "R6")
        self.assertAlmostEqual(summaries["NSW1"]["avg_best_price"], 12.0)
        self.assertEqual(summaries["QLD1"]["best_market"], "raisereg")
        self.assertEqual(summaries["QLD1"]["best_code"], "RREG")
        self.assertAlmostEqual(summaries["QLD1"]["revenue_aud"], 7.5)


if __name__ == "__main__":
    unittest.main()
