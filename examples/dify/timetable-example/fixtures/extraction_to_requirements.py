import json
import re
from collections import Counter


def prolog_atom(value):
    escaped = value.replace("\\", "\\\\").replace("'", "''")
    return "'" + escaped + "'"


def main(extracted_text: str) -> dict:
    text = extracted_text.strip()

    # Accept an optional Markdown code fence.
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[-1].strip() != "```":
            raise ValueError("Incomplete JSON code fence.")
        text = "\n".join(lines[1:-1])

    data = json.loads(text)
    class_name = data.get("class")
    days = data.get("days")
    rows = data.get("rows")
    uncertainties = data.get("uncertainties", [])

    if not isinstance(class_name, str) or not class_name.strip():
        raise ValueError("Missing class identifier.")

    if (
        not isinstance(days, list)
        or not days
        or any(not isinstance(day, str) or not day.strip() for day in days)
        or len(set(days)) != len(days)
    ):
        raise ValueError("Invalid or duplicate day labels.")

    if not isinstance(rows, list) or not rows:
        raise ValueError("No timetable rows found.")

    if not isinstance(uncertainties, list):
        raise ValueError("uncertainties must be a list.")

    # Remove a duplicated header only when it exactly matches days.
    normalize = lambda value: value.strip().casefold()

    if (
        rows
        and isinstance(rows[0], list)
        and all(isinstance(cell, str) for cell in rows[0])
        and [normalize(cell) for cell in rows[0]]
        == [normalize(day) for day in days]
    ):
        rows = rows[1:]
        uncertainties = uncertainties + [
            "A duplicated weekday header was removed from rows."
        ]

    # Reject any remaining weekday labels inside teaching cells.
    day_labels = {normalize(day) for day in days}
    for row in rows:
        if isinstance(row, list):
            for cell in row:
                if isinstance(cell, str) and normalize(cell) in day_labels:
                    raise ValueError(
                        "A weekday header appears inside the teaching grid. "
                        "Review the extraction."
                    )

    counts = Counter()

    for period, row in enumerate(rows, start=1):
        if not isinstance(row, list) or len(row) != len(days):
            raise ValueError(
                f"Period {period}: expected {len(days)} cells."
            )

        for subject in row:
            if subject is None:
                continue
            if not isinstance(subject, str) or not subject.strip():
                raise ValueError(f"Invalid subject in period {period}.")
            if subject.strip().upper() == "UNREADABLE":
                raise ValueError(
                    "Unreadable cell: review the extraction first."
                )
            counts[subject.strip()] += 1

    # Numbered identifiers avoid collisions between subject abbreviations.
    class_id = re.sub(
        r"[^a-z0-9]+", "_", class_name.lower()
    ).strip("_") or "class"

    facts = [
        "% Teacher identifiers are placeholders; replace before scheduling.",
        f"slots_per_day({len(rows)}).",
        f"slots_per_week({len(rows) * len(days)}).",
        ""
    ]

    for index, subject in enumerate(sorted(counts), start=1):
        teacher = f"teacher_{class_id}_{index:02d}"
        facts.append(
            "class_subject_teacher_times("
            f"{prolog_atom(class_name)}, "
            f"{prolog_atom(subject)}, "
            f"{prolog_atom(teacher)}, "
            f"{counts[subject]})."
        )

    return {
        "prolog_facts": "\n".join(facts),
        "subject_counts": json.dumps(
            dict(sorted(counts.items())), ensure_ascii=False
        ),
        "total_lessons": sum(counts.values()),
        "review_notes": json.dumps(
            uncertainties, ensure_ascii=False
        )
    }
