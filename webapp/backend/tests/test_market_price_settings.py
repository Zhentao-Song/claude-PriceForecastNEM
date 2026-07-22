import unittest

from app.config import APC_PRICE_AUD, CPT_THRESHOLD_AUD
from app.paper import MPC, _validate_bands


class MarketPriceSettingsTests(unittest.TestCase):
    def test_fy2026_27_reliability_settings_are_current(self):
        self.assertEqual(CPT_THRESHOLD_AUD, 2_225_900.0)
        self.assertEqual(APC_PRICE_AUD, 600.0)

    def test_paper_bids_accept_current_mpc_and_reject_above_it(self):
        bands = _validate_bands([
            {"price": -1000, "mw": 0},
            {"price": 0, "mw": 10},
            {"price": MPC, "mw": 0},
        ])
        self.assertEqual(bands[-1]["price"], 23_200.0)

        with self.assertRaisesRegex(ValueError, "23200"):
            _validate_bands([
                {"price": -1000, "mw": 0},
                {"price": 0, "mw": 10},
                {"price": 23_200.01, "mw": 0},
            ])


if __name__ == "__main__":
    unittest.main()
