import unittest
from unittest.mock import patch

import app.bess_backtest as bess_backtest
from app.bess_backtest import _optimise_day, _optimise_days, _optimise_days_resilient
from app.bess_finance import BessFinanceInputs, project_cashflow, tornado


class BessBacktestTests(unittest.TestCase):
    def test_flat_positive_prices_do_not_force_unprofitable_dispatch(self):
        solved = _optimise_day(
            [100.0] * 288,
            power_mw=10.0,
            energy_mwh=20.0,
            rte_pct=88.0,
            mlf=0.965,
            aux=0.015,
            capture=0.80,
            deg_cost_per_mwh=35.0,
            max_cycles_per_day=2.0,
        )

        self.assertAlmostEqual(solved["charge_mwh"], 0.0, delta=1e-7)
        self.assertAlmostEqual(solved["discharge_mwh"], 0.0, delta=1e-7)
        self.assertAlmostEqual(solved["net_revenue"], 0.0, delta=1e-7)

    def test_dispatch_is_chronological_soc_constrained_and_net_of_degradation(self):
        # One low-price hour followed by one high-price hour.  The optimiser
        # must charge before it sells and return to starting SOC at day end.
        solved = _optimise_day(
            [0.0] * 12 + [200.0] * 12,
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=81.0,
            mlf=1.0,
            aux=0.0,
            capture=1.0,
            deg_cost_per_mwh=20.0,
            max_cycles_per_day=2.0,
        )

        self.assertGreater(solved["discharge_mwh"], 0)
        self.assertLessEqual(max(solved["soc_mwh"]), 1.0 + 1e-7)
        self.assertGreaterEqual(min(solved["soc_mwh"]), -1e-7)
        self.assertAlmostEqual(solved["soc_mwh"][-1], 0.5, delta=1e-7)
        self.assertTrue(all(
            charge + discharge <= 1.0 + 1e-7
            for charge, discharge in zip(solved["charge_mw"], solved["discharge_mw"])
        ))
        self.assertAlmostEqual(
            solved["degradation_cost"], solved["discharge_mwh"] * 20.0
        )
        self.assertAlmostEqual(
            solved["net_revenue"],
            solved["captured_market_revenue"] - solved["degradation_cost"],
        )

    def test_batched_days_match_independent_daily_solutions(self):
        days = [
            ("low-then-high", [0.0] * 12 + [200.0] * 12),
            ("negative-then-high", [-50.0] * 12 + [150.0] * 12),
        ]
        kwargs = dict(
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=88.0,
            mlf=0.98,
            aux=0.015,
            capture=0.8,
            deg_cost_per_mwh=35.0,
            max_cycles_per_day=2.0,
        )
        batched = _optimise_days(days, **kwargs)
        for day, prices in days:
            separate = _optimise_day(prices, **kwargs)
            self.assertAlmostEqual(
                batched[day]["net_revenue"], separate["net_revenue"], places=6
            )
            self.assertAlmostEqual(
                batched[day]["discharge_mwh"], separate["discharge_mwh"], places=6
            )

    def test_transient_batch_solver_failure_is_retried(self):
        days = [("day-1", [0.0] * 12 + [200.0] * 12)]
        kwargs = dict(
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=88.0,
            mlf=0.98,
            aux=0.015,
            capture=0.8,
            deg_cost_per_mwh=35.0,
            max_cycles_per_day=2.0,
        )
        real_optimise = bess_backtest._optimise_days
        calls = 0

        def fail_once(*args, **inner_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("HiGHS status Unknown")
            return real_optimise(*args, **inner_kwargs)

        with patch.object(bess_backtest, "_optimise_days", side_effect=fail_once):
            solved = _optimise_days_resilient(days, **kwargs)

        self.assertEqual(calls, 2)
        self.assertIn("day-1", solved)

    def test_persistently_failing_batch_is_split_without_changing_results(self):
        days = [
            ("day-1", [0.0] * 12 + [200.0] * 12),
            ("day-2", [10.0] * 12 + [180.0] * 12),
        ]
        kwargs = dict(
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=88.0,
            mlf=0.98,
            aux=0.015,
            capture=0.8,
            deg_cost_per_mwh=35.0,
            max_cycles_per_day=2.0,
        )
        expected = _optimise_days(days, **kwargs)
        real_optimise = bess_backtest._optimise_days

        def reject_multi_day(batch, *args, **inner_kwargs):
            if len(batch) > 1:
                raise RuntimeError("HiGHS status Unknown")
            return real_optimise(batch, *args, **inner_kwargs)

        with patch.object(bess_backtest, "_optimise_days", side_effect=reject_multi_day):
            solved = _optimise_days_resilient(days, **kwargs)

        for day, _ in days:
            self.assertAlmostEqual(
                solved[day]["net_revenue"], expected[day]["net_revenue"], places=6
            )

    def test_persistently_failing_single_day_uses_exact_milp_fallback(self):
        days = [("day-1", [0.0] * 12 + [200.0] * 12)]
        kwargs = dict(
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=88.0,
            mlf=0.98,
            aux=0.015,
            capture=0.8,
            deg_cost_per_mwh=35.0,
            max_cycles_per_day=2.0,
        )
        fallback = {"net_revenue": 123.0, "used_milp_complementarity": True}

        with (
            patch.object(
                bess_backtest,
                "_optimise_days",
                side_effect=RuntimeError("HiGHS status Unknown"),
            ),
            patch.object(
                bess_backtest,
                "_optimise_day_milp",
                return_value=fallback,
            ) as exact_fallback,
        ):
            solved = _optimise_days_resilient(days, **kwargs)

        exact_fallback.assert_called_once()
        self.assertIs(solved["day-1"], fallback)

    def test_extreme_negative_price_cannot_create_simultaneous_charge_discharge(self):
        solved = _optimise_day(
            [-1_000.0],
            power_mw=1.0,
            energy_mwh=1.0,
            rte_pct=80.0,
            mlf=0.95,
            aux=0.015,
            capture=1.0,
            deg_cost_per_mwh=0.0,
            max_cycles_per_day=2.0,
        )

        self.assertTrue(solved["used_milp_complementarity"])
        self.assertFalse(any(
            charge > 1e-7 and discharge > 1e-7
            for charge, discharge in zip(solved["charge_mw"], solved["discharge_mw"])
        ))
        self.assertAlmostEqual(solved["net_revenue"], 0.0, delta=1e-7)

    def test_finance_uses_backtested_net_margin_without_second_loss_haircut(self):
        base = dict(
            power_mw=10.0,
            duration_h=2.0,
            capex_aud=1_000_000.0,
            debt_pct=0.0,
            project_life_years=1,
            cycles_per_day=1.0,
            degradation_pct_year=0.0,
            arb_spread_per_mwh=100.0,
            fcas_revenue_per_mw_year=0.0,
        )
        model_a = project_cashflow(BessFinanceInputs(**base, rte_pct=88.0, mlf=0.965, aux_load_pct=1.5))
        model_b = project_cashflow(BessFinanceInputs(**base, rte_pct=70.0, mlf=0.80, aux_load_pct=8.0))

        expected = 10.0 * 2.0 * 365.0 * 100.0
        self.assertAlmostEqual(model_a["yearly"][1]["energy_revenue"], expected)
        self.assertAlmostEqual(model_b["yearly"][1]["energy_revenue"], expected)

    def test_finance_tornado_does_not_double_count_rte_sensitivity(self):
        inputs = BessFinanceInputs(
            arb_spread_per_mwh=100.0,
            fcas_revenue_per_mw_year=20_000.0,
        )
        drivers = {row["driver"] for row in tornado(inputs)}
        self.assertNotIn("RTE (pp)", drivers)
        self.assertIn("Captured energy cash margin $/MWh", drivers)


if __name__ == "__main__":
    unittest.main()
