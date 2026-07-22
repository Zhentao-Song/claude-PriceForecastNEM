import tempfile
import unittest
from unittest.mock import patch
import zipfile

import app.bess_benchmarks as benchmarks
from app.scrapers import bess_actuals


class BessBenchmarkTests(unittest.TestCase):
    def tearDown(self):
        benchmarks.target_bess_benchmark.cache_clear()

    def test_target_range_uses_observed_operating_margin_and_cycles(self):
        observed = {
            "available": True,
            "entries": [
                {
                    "operational_comparable": True,
                    "mlf": 1.0,
                    "discharge_mwh_observed": 1.0,
                    "discharge_revenue_settled_aud": 100.0,
                    "charge_cost_settled_aud": 0.0,
                    "equivalent_cycles_per_day": 0.4,
                },
                {
                    "operational_comparable": True,
                    "mlf": 1.0,
                    "discharge_mwh_observed": 1.0,
                    "discharge_revenue_settled_aud": 200.0,
                    "charge_cost_settled_aud": 0.0,
                    "equivalent_cycles_per_day": 0.8,
                },
                {
                    "operational_comparable": True,
                    "mlf": 1.0,
                    "discharge_mwh_observed": 1.0,
                    "discharge_revenue_settled_aud": 300.0,
                    "charge_cost_settled_aud": 0.0,
                    "equivalent_cycles_per_day": 1.2,
                },
            ],
            "observed_fcas_per_mw_year": {
                "p25": 10.0, "median": 20.0, "p75": 30.0, "n": 3,
            },
        }
        upper = {
            "annual_captured_market_revenue_aud": 1_000.0,
            "captured_market_margin_per_mwh": 50.0,
            "mean_cycles_per_day": 1.5,
        }

        with (
            patch.object(benchmarks, "observed_bess_benchmarks", return_value=observed),
            patch.object(benchmarks, "run_energy_backtest", return_value=upper) as solve,
        ):
            result = benchmarks.target_bess_benchmark(
                "SA1", 10.0, 2.0, 88.0, 1.0, 1.5, 35.0, 2.0,
            )

        solve.assert_called_once()
        base = result["scenarios"]["base"]
        self.assertEqual(base["energy_revenue_aud"], 1_168_000.0)
        self.assertEqual(base["fcas_revenue_aud"], 200.0)
        self.assertEqual(base["combined_revenue_aud"], 1_168_200.0)
        self.assertEqual(base["mean_cycles_per_day"], 0.8)
        expected_margin = 200.0
        self.assertAlmostEqual(base["energy_cash_margin_per_mwh"], expected_margin, places=3)

    def test_dispatchload_parser_accepts_new_unit_solution_version(self):
        columns = [
            "SETTLEMENTDATE", "DUID", "INTERVENTION", "INITIALMW", "TOTALCLEARED",
            *bess_actuals.FCAS_FIELDS,
            "INITIAL_ENERGY_STORAGE", "ENERGY_STORAGE",
        ]
        header = ["I", "DISPATCH", "UNIT_SOLUTION", "6", *columns]
        values = [
            "2026/01/01 00:05:00", "HPR1", "0", "10", "11",
            *[str(index + 1) for index in range(len(bess_actuals.FCAS_FIELDS))],
            "120", "118",
        ]
        data = ["D", "DISPATCH", "UNIT_SOLUTION", "6", *values]
        csv_payload = ",".join(header) + "\n" + ",".join(data) + "\n"

        with tempfile.NamedTemporaryFile(suffix=".zip") as tmp:
            with zipfile.ZipFile(tmp.name, "w") as archive:
                archive.writestr("PUBLIC_DISPATCHLOAD.csv", csv_payload)
            captured = []
            with patch.object(
                bess_actuals, "_upsert_rows",
                side_effect=lambda rows: captured.extend(rows) or len(rows),
            ):
                count = bess_actuals.ingest_archive(tmp.name, {"HPR1"})

        self.assertEqual(count, 1)
        self.assertEqual(captured[0][1], "HPR1")
        self.assertEqual(captured[0][4:14], tuple(float(i) for i in range(1, 11)))


if __name__ == "__main__":
    unittest.main()
