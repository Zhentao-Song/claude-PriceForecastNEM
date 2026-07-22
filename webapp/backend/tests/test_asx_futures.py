from __future__ import annotations

import unittest

from app.asx_energy import parse_asx_electricity_report


def _section(code: str, region: str) -> str:
    return f'''
    <TR class="Headbold"><TD align="left" colspan="10">{code} - ASX Electricity Base Load Quarterly Futures {region} (A$ per megawatt hour)</TD></TR>
    <TR class="Highlight"><TD align="left">Sep 2026</TD><TD align="right">75.25</TD><TD align="right">75.50</TD><TD align="right">75.00</TD><TD align="right">75.25</TD><TD align="right">75.25</TD><TD align="right">-1.25</TD><TD align="right">3,157</TD><TD align="right">12</TD><TD align="right">56</TD></TR>
    '''


class AsxFuturesParserTests(unittest.TestCase):
    def test_parses_four_nem_quarterly_curves(self) -> None:
        page = "".join((
            _section("BN", "NSW"),
            _section("BQ", "QLD"),
            _section("BS", "SA"),
            _section("BV", "VIC"),
        ))
        curves = parse_asx_electricity_report(page)

        self.assertEqual([curve["region"] for curve in curves], ["NSW", "QLD", "VIC", "SA"])
        nsw = curves[0]["contracts"][0]
        self.assertEqual(nsw["settlement"], 75.25)
        self.assertEqual(nsw["change"], -1.25)
        self.assertEqual(nsw["open_interest"], 3157)
        self.assertEqual(nsw["volume"], 56)
        self.assertEqual(nsw["contract_hours"], 2208)


if __name__ == "__main__":
    unittest.main()
