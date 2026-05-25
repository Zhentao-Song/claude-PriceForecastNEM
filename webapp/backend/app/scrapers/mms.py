"""Parser for AEMO MMS CSV format used in NEMWeb reports.

A file contains multiple tables. Each table is preceded by an `I` row
defining its schema, followed by `D` rows of data:

    C, comment header...
    I, REPORT, SUBREPORT, VERSION, COL1, COL2, ...
    D, REPORT, SUBREPORT, VERSION, val1, val2, ...
    D, REPORT, SUBREPORT, VERSION, val1, val2, ...
    I, REPORT, OTHER_SUBREPORT, ...
    ...
    C, end-of-report
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict


def parse_mms_csv(content: str) -> dict[str, list[dict[str, str]]]:
    tables: dict[str, list[dict[str, str]]] = defaultdict(list)
    schemas: dict[str, list[str]] = {}

    reader = csv.reader(io.StringIO(content))
    for row in reader:
        if not row:
            continue
        rtype = row[0]
        if rtype == "I" and len(row) >= 5:
            key = f"{row[1]}_{row[2]}"
            schemas[key] = row[4:]
        elif rtype == "D" and len(row) >= 5:
            key = f"{row[1]}_{row[2]}"
            cols = schemas.get(key)
            if not cols:
                continue
            values = row[4:]
            # Pad/truncate to schema length to be defensive against schema drift.
            if len(values) < len(cols):
                values = values + [""] * (len(cols) - len(values))
            tables[key].append(dict(zip(cols, values)))
    return dict(tables)
