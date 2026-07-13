#!/usr/bin/env python3
"""Send a single email as adam@nadelio.com via the Resend API.

Standalone from app.py on purpose: this is Adam's manual outreach tool (agency
prospecting, one-off replies), not the product's automated alert sender
(app.py's _send_email, which runs on Render and sends as alerts@nadelio.com).
Keeping the two apart means a bug or a bad send here can never touch the
monitoring cron's email path, and vice versa.

Reads RESEND_API_KEY from the environment — never hard-code it. Get one from
https://resend.com/api-keys (same account/domain already verified for the
product's alert emails).

Usage:
    RESEND_API_KEY=re_xxx python tools/send-email.py \
        --to prospect@agency.com \
        --subject "Settling AI-visibility work on results" \
        --body-file tools/outreach/draft.txt \
        --dry-run

Drop --dry-run to actually send. Always dry-run first.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request

FROM_EMAIL = os.environ.get("OUTREACH_FROM_EMAIL", "Adam Chabbi <adam@nadelio.com>")
RESEND_ENDPOINT = "https://api.resend.com/emails"


def send(to_email, subject, body_text, api_key, reply_to=None, dry_run=True, attach=None):
    if "@" not in to_email:
        raise ValueError("Invalid recipient: %r" % to_email)
    if not subject.strip():
        raise ValueError("Subject cannot be empty")
    if not body_text.strip():
        raise ValueError("Body cannot be empty")

    html = "<p>" + body_text.replace("\n\n", "</p><p>").replace("\n", "<br>") + "</p>"
    payload = {
        "from": FROM_EMAIL,
        "to": [to_email],
        "subject": subject,
        "html": html,
        "text": body_text,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    # Attachments: Resend takes each file base64-encoded with its filename.
    if attach:
        atts = []
        for path in attach:
            with open(path, "rb") as f:
                content = base64.b64encode(f.read()).decode("ascii")
            atts.append({"filename": os.path.basename(path), "content": content})
        payload["attachments"] = atts

    print("--- Preview ---")
    print("From:   %s" % FROM_EMAIL)
    print("To:     %s" % to_email)
    print("Subject: %s" % subject)
    if attach:
        print("Attach: %s" % ", ".join(os.path.basename(a) for a in attach))
    print("---")
    print(body_text)
    print("---")

    if dry_run:
        print("\n[DRY RUN] Nothing sent. Drop --dry-run to actually send.")
        return None

    if not api_key:
        print("\nERROR: RESEND_API_KEY is not set. Nothing sent.", file=sys.stderr)
        sys.exit(1)

    body = json.dumps(payload).encode("utf-8")
    # Resend sits behind Cloudflare, which rejects requests with no User-Agent
    # (Cloudflare error 1010, a 403). A plain urllib request sends none, so we
    # set one explicitly. Without this, every send is refused before it reaches
    # Resend at all.
    req = urllib.request.Request(
        RESEND_ENDPOINT, data=body, method="POST",
        headers={"Authorization": "Bearer " + api_key,
                 "Content-Type": "application/json",
                 "User-Agent": "nadelio-outreach/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as he:
        detail = he.read().decode(errors="replace")
        print("\nENVOI REFUSE par Resend (HTTP %d)." % he.code, file=sys.stderr)
        print("Reponse de Resend : %s" % detail, file=sys.stderr)
        raise SystemExit(1)
    print("\nSent. Resend id: %s" % result.get("id"))
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--to", required=True, help="Recipient email address")
    ap.add_argument("--subject", required=True, help="Email subject")
    ap.add_argument("--body-file", help="Path to a text file with the email body")
    ap.add_argument("--body", help="Inline body text (alternative to --body-file)")
    ap.add_argument("--reply-to", default="adam.chabbi94@gmail.com",
                     help="Reply-To header, defaults to Adam's Gmail so replies land where he reads")
    ap.add_argument("--attach", action="append", default=[],
                     help="Path to a file to attach (repeatable). Use for the guide PDF.")
    ap.add_argument("--dry-run", action="store_true", default=True,
                     help="Preview only, do not send (default)")
    ap.add_argument("--send", dest="dry_run", action="store_false",
                     help="Actually send the email")
    args = ap.parse_args()

    if args.body_file:
        body_text = open(args.body_file, encoding="utf-8").read()
    elif args.body:
        body_text = args.body
    else:
        print("ERROR: provide --body-file or --body", file=sys.stderr)
        sys.exit(1)

    for path in args.attach:
        if not os.path.isfile(path):
            print("ERROR: attachment not found: %s" % path, file=sys.stderr)
            sys.exit(1)

    send(args.to, args.subject, body_text,
         api_key=os.environ.get("RESEND_API_KEY"),
         reply_to=args.reply_to, dry_run=args.dry_run, attach=args.attach)


if __name__ == "__main__":
    main()
