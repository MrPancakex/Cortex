#!/usr/bin/env python3
"""Convert Claude conversations.json export to individual Obsidian .md files."""
import json
import re
import os
import sys
from datetime import datetime

INPUT = "/home/mrpancakex/Cortex/data/vault-extract/conversations.json"
OUTPUT_DIR = "/home/mrpancakex/Obsidian/Claude/Raw"

def slugify(text, max_len=80):
    if not text:
        return "untitled"
    s = re.sub(r'[^\w\s-]', '', text.lower())
    s = re.sub(r'[\s_]+', '-', s).strip('-')
    return s[:max_len] or "untitled"

def format_message(msg):
    sender = msg.get("sender", "unknown")
    text = msg.get("text", "").strip()
    if not text:
        return ""
    label = "**Human**" if sender == "human" else "**Assistant**"
    return f"## {label}\n\n{text}\n"

def main():
    with open(INPUT, "r") as f:
        conversations = json.load(f)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    written = 0
    skipped = 0
    dates = []

    for conv in conversations:
        messages = conv.get("chat_messages", [])
        if not messages:
            skipped += 1
            continue

        name = conv.get("name") or "Untitled Conversation"
        created = conv.get("created_at", "")
        updated = conv.get("updated_at", "")
        uuid = conv.get("uuid", "unknown")
        summary = conv.get("summary") or ""

        # Parse date for filename prefix
        date_str = created[:10] if created else "unknown-date"
        dates.append(date_str)

        slug = slugify(name)
        filename = f"{date_str}--{slug}.md"
        filepath = os.path.join(OUTPUT_DIR, filename)

        # Handle duplicates
        counter = 1
        while os.path.exists(filepath):
            filename = f"{date_str}--{slug}-{counter}.md"
            filepath = os.path.join(OUTPUT_DIR, filename)
            counter += 1

        # Build frontmatter
        fm_lines = [
            "---",
            'title: "' + name.replace('"', "'") + '"',
            f"date: {date_str}",
            f"updated: {updated[:10] if updated else date_str}",
            f"source: claude",
            f"uuid: {uuid}",
            f"message_count: {len(messages)}",
        ]
        if summary:
            fm_lines.append('summary: "' + summary[:200].replace('"', "'") + '"')
        fm_lines.append("tags: []")
        fm_lines.append("category: unsorted")
        fm_lines.append("---")

        # Build body
        body_parts = ["\n".join(fm_lines), ""]
        body_parts.append(f"# {name}\n")

        for msg in messages:
            block = format_message(msg)
            if block:
                body_parts.append(block)

        with open(filepath, "w") as f:
            f.write("\n".join(body_parts))

        written += 1

    dates.sort()
    earliest = dates[0] if dates else "N/A"
    latest = dates[-1] if dates else "N/A"

    print(f"CONVERSION COMPLETE")
    print(f"Total in export: {len(conversations)}")
    print(f"Written: {written}")
    print(f"Skipped (empty): {skipped}")
    print(f"Date range: {earliest} to {latest}")
    print(f"Output: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
