#!/usr/bin/env python3
# MIT License. Shared helpers for the docx skill scripts.
# Modified by AporiaX: bounded original-text replacement and shared-part deduplication.
"""Shared helpers: paragraph iteration and run-preserving text replacement."""
from __future__ import annotations


def iter_all_paragraphs(doc, include_headers_footers: bool = True):
    """Yield every paragraph in body, tables (recursively), headers, footers."""
    seen = set()

    def unique(container):
        for para in _iter_container(container):
            if para._p not in seen:
                seen.add(para._p)
                yield para

    yield from unique(doc)
    if include_headers_footers:
        for section in doc.sections:
            for part in (
                section.header, section.footer,
                section.first_page_header, section.first_page_footer,
                section.even_page_header, section.even_page_footer,
            ):
                if part is not None:
                    yield from unique(part)


def _iter_container(container):
    for para in container.paragraphs:
        yield para
    for table in container.tables:
        yield from _iter_table(table)


def _iter_table(table):
    for row in table.rows:
        for cell in row.cells:
            for para in cell.paragraphs:
                yield para
            for nested in cell.tables:
                yield from _iter_table(nested)


def iter_part_roots(doc):
    """Yield the XML root of the body plus every header/footer part."""
    yield doc.element.body
    seen = set()
    for section in doc.sections:
        for part in (
            section.header, section.footer,
            section.first_page_header, section.first_page_footer,
            section.even_page_header, section.even_page_footer,
        ):
            if part is not None and id(part._element) not in seen:
                seen.add(id(part._element))
                yield part._element


def replace_in_paragraph(para, old: str, new: str) -> int:
    """Replace `old` with `new` in a paragraph, preserving run formatting.

    Match the ORIGINAL run text once, then apply non-overlapping edits from
    right to left. Newly inserted text is never searched again, even when
    `new` contains `old`. A spanning replacement inherits the first run's
    format; text outside matches keeps its original runs and formatting.
    """
    if not old:
        return 0
    runs = para.runs
    full = "".join(run.text for run in runs)
    matches = []
    offset = 0
    while True:
        start = full.find(old, offset)
        if start < 0:
            break
        matches.append((start, start + len(old)))
        offset = start + len(old)
    positions = []
    offset = 0
    for run in runs:
        positions.append((offset, offset + len(run.text)))
        offset += len(run.text)
    for start, end in reversed(matches):
        spans = []  # (run_idx, cut_start, cut_end) portions inside the match
        for i, (r_start, r_end) in enumerate(positions):
            if r_end > start and r_start < end:
                spans.append((i, max(start, r_start) - r_start,
                              min(end, r_end) - r_start))
        first = True
        for i, cs, ce in spans:
            t = runs[i].text
            if first:
                runs[i].text = t[:cs] + new + t[ce:]
                first = False
            else:
                runs[i].text = t[:cs] + t[ce:]
    return len(matches)
