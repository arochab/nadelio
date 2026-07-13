#!/usr/bin/env python3
"""Send the 5 prepared agency outreach emails in one run, guide PDF attached.

Reads a CSV of recipients (tools/outreach/recipients.csv) with columns:
    slug,email,firstname
Each slug maps to a body file tools/outreach/mail-<slug>.txt and a subject on
its first line (a line starting with "Objet:"). The rest of the file is the
body. The {Prenom} placeholder is replaced with the firstname column.

DRY RUN BY DEFAULT. It previews every email and sends NOTHING until you pass
--send. This is deliberate: a cold email is irreversible, so the safe path is
the default. Reuses send-email.py's send() so the from address, the reply-to,
and the attachment handling are identical to the single-send tool.

Usage:
    python tools/send-batch.py                 # preview all 5, sends nothing
    RESEND_API_KEY=re_xxx python tools/send-batch.py --send   # actually send

Every recipient email in the CSV must be a REAL, verified address. The tool
refuses a row whose email is empty or lacks an @, so a missing address can
never turn into a bad send.
"""
import argparse
import csv
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# Read RESEND_API_KEY (and any other keys) from the project .env if present, so
# Adam never has to paste a secret into the terminal. Environment wins over the
# file, so an explicitly-exported key still takes precedence.
def _load_dotenv():
    env_path = os.path.abspath(os.path.join(HERE, "..", ".env"))
    if not os.path.isfile(env_path):
        return
    for line in open(env_path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

_load_dotenv()
import importlib.util
_spec = importlib.util.spec_from_file_location("send_email", os.path.join(HERE, "send-email.py"))
send_email = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(send_email)

OUTREACH = os.path.abspath(os.path.join(HERE, "..", "outreach"))
GUIDE = os.path.abspath(os.path.join(HERE, "..", "Nadelio-Guide.pdf"))


def load_mail(slug, firstname):
    path = os.path.join(OUTREACH, "mail-%s.txt" % slug)
    if not os.path.isfile(path):
        raise FileNotFoundError("Missing body file: %s" % path)
    lines = open(path, encoding="utf-8").read().splitlines()
    subject = ""
    body_lines = lines
    if lines and lines[0].lower().startswith("objet:"):
        subject = lines[0].split(":", 1)[1].strip()
        body_lines = lines[1:]
    body = "\n".join(body_lines).strip()
    body = body.replace("{Prenom}", firstname).replace("{Prénom}", firstname)
    subject = subject.replace("{Prenom}", firstname).replace("{Prénom}", firstname)
    return subject, body


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=os.path.join(OUTREACH, "recipients.csv"),
                     help="CSV with columns slug,email,firstname")
    ap.add_argument("--send", action="store_true",
                     help="Actually send. Without this flag, previews only.")
    ap.add_argument("--attach-guide", action="store_true",
                     help="Attach the guide PDF. Off by default: cold emails link to nadelio.com instead of attaching a file, which is safer for the recipient and better for deliverability.")
    ap.add_argument("--delay", type=float, default=4.0,
                     help="Seconds to wait between sends, to look human and respect limits.")
    args = ap.parse_args()

    if not os.path.isfile(args.csv):
        print("ERROR: recipients CSV not found: %s" % args.csv, file=sys.stderr)
        print("Create it with columns: slug,email,firstname", file=sys.stderr)
        sys.exit(1)

    attach = [GUIDE] if args.attach_guide else None
    if attach and not os.path.isfile(GUIDE):
        print("ERROR: guide PDF not found at %s. Regenerate it or drop --attach-guide." % GUIDE, file=sys.stderr)
        sys.exit(1)

    rows = []
    with open(args.csv, encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f), 1):
            slug = (row.get("slug") or "").strip()
            email = (row.get("email") or "").strip()
            first = (row.get("firstname") or "").strip()
            if not slug:
                continue
            if "@" not in email:
                print("REFUSED row %d (%s): email missing or invalid, skipping." % (i, slug), file=sys.stderr)
                continue
            rows.append((slug, email, first))

    if not rows:
        print("No valid recipient rows. Fill in real emails in the CSV first.", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("RESEND_API_KEY")
    if args.send and not api_key:
        print("ERROR: --send requires RESEND_API_KEY in the environment.", file=sys.stderr)
        sys.exit(1)

    print("=== %s %d email(s) ===\n" % ("SENDING" if args.send else "PREVIEW (dry run,",
                                        len(rows)) + ("" if args.send else " nothing sent)"))
    sent = 0
    for idx, (slug, email, first) in enumerate(rows):
        subject, body = load_mail(slug, first)
        print("\n[%d/%d] %s -> %s" % (idx + 1, len(rows), slug, email))
        send_email.send(email, subject, body, api_key=api_key,
                        reply_to="adam.chabbi94@gmail.com",
                        dry_run=not args.send, attach=attach)
        sent += 1
        if args.send and idx < len(rows) - 1:
            time.sleep(args.delay)

    print("\n=== %s: %d email(s) %s ===" % (
        "DONE" if args.send else "PREVIEW DONE", sent,
        "sent" if args.send else "previewed, none sent"))
    if not args.send:
        print("To actually send, re-run with:  RESEND_API_KEY=re_xxx python tools/send-batch.py --send")


if __name__ == "__main__":
    main()
