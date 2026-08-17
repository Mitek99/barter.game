"""Browser UI tests for the barter.game web app (Playwright, headless Chromium).

Covers the vouchers rework and, above all, ASYNC LOADING: with a pinned peer
bank that takes 5s to answer anything (slowbank.py on :8201), the local
content must still paint fast and sections must fill in independently.

Run:  python3 scripts/ui-test/ui_test.py   (bank on :8100, slowbank on :8201)
"""
import sys
import threading
import time

from playwright.sync_api import sync_playwright

import slowbank

BASE = "http://localhost:8100/alice/ui/"
HANDLE = "uitest" + str(int(time.time()))[-6:]
PASSWORD = "testpassword123"
VOUCHER = "1 test credit"

pass_all = True


def check(label, ok, detail=""):
    global pass_all
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        pass_all = False


threading.Thread(target=lambda: slowbank.HTTPServer(("127.0.0.1", 8201), slowbank.Handler).serve_forever(),
                 daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch()

    # ---------------- desktop flow ----------------
    page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()

    # Register a fresh identity through the real form.
    page.goto(BASE + "#/register")
    page.fill("#r-handle", HANDLE)
    page.fill("#r-pass", PASSWORD)
    page.fill("#r-pass2", PASSWORD)
    page.check("#r-ack")
    page.click("#r-form button[type=submit]")
    page.wait_for_selector("text=Quick actions", timeout=15000)
    check("register → dashboard", True)

    # The dashboard shell paints before any data: placeholder cards exist
    # immediately, then fill in.
    check("dashboard balances section present", page.locator("#dash-bal").count() == 1)
    page.wait_for_selector("#dash-bal >> text=No balances yet", timeout=15000)
    check("dashboard balances fill in", True)
    page.wait_for_selector("#dash-act >> text=No activity", timeout=15000)
    check("dashboard activity fills in", True)

    # Mint a voucher through the real form.
    page.goto(BASE + "#/vouchers/new")
    page.fill("#v-name", VOUCHER)
    page.click("button:has-text('Create & sign')")
    page.wait_for_selector("#v-mine >> text=" + VOUCHER, timeout=15000)
    check("voucher minted, 'Issued by you' tile", True)

    # Pin the slow bank (its discovery doc takes 5s).
    page.goto(BASE + "#/network")
    page.fill("#n-bank-url", "http://localhost:8201")
    page.click("button:has-text('Pin bank')")
    page.wait_for_selector("text=Pinned slowbank", timeout=20000)
    check("slow bank pinned", True)

    # THE test: vouchers screen with a 5s peer — own tiles must paint fast.
    t0 = time.time()
    page.goto(BASE + "#/vouchers")
    page.wait_for_selector("#v-mine >> text=" + VOUCHER, timeout=10000)
    dt = time.time() - t0
    check("own vouchers paint despite slow pinned bank", dt < 4.0, f"{dt:.1f}s (peer needs 5s)")

    # The holdings section shows its in-progress note while the peer is slow…
    page.wait_for_selector("#v-hold >> text=Checking pinned banks", timeout=4000)
    check("holdings show 'checking pinned banks' while peer pending", True)
    # …and the note goes away once the peer has answered (or failed).
    page.wait_for_selector("#v-hold >> text=Checking pinned banks", state="detached", timeout=30000)
    check("holdings settle after peer answers", True)
    page.wait_for_selector("#v-follow >> p.small", timeout=15000)
    check("followed section settles", True)

    # Dashboard with the slow peer: shell + local content fast. The user now
    # holds their own issuer account, so the balance tile shows the voucher.
    t0 = time.time()
    page.goto(BASE + "#/")
    page.wait_for_selector("text=Quick actions", timeout=5000)
    page.wait_for_selector("#dash-bal >> text=" + VOUCHER, timeout=5000)
    dt = time.time() - t0
    check("dashboard local content paints despite slow peer", dt < 4.0, f"{dt:.1f}s")

    # Voucher detail screen: head card fast, actions fill in.
    page.goto(BASE + "#/vouchers")
    page.wait_for_selector("#v-mine >> text=" + VOUCHER, timeout=10000)
    t0 = time.time()
    page.click(f"#v-mine a:has-text('{VOUCHER}')")
    page.wait_for_selector("#v-head >> text=" + VOUCHER, timeout=10000)
    dt = time.time() - t0
    check("voucher detail head paints fast", dt < 4.0, f"{dt:.1f}s")
    page.wait_for_selector("#v-act >> text=Actions", timeout=15000)
    for label in ["Trade", "Invoice", "Cheque", "Post about it", "Voucher QR"]:
        check(f"action available: {label}", page.locator(f"#v-act >> text='{label}'").count() >= 1)
    # QR modal opens.
    page.click("#v-act >> button:has-text('Voucher QR')")
    page.wait_for_selector(".modal img.qr", timeout=5000)
    check("voucher QR modal opens", True)
    page.click("#share-close")

    # ---------------- mobile flow ----------------
    mctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mp = mctx.new_page()
    mp.goto(BASE + "#/unlock")
    mp.fill("#u-handle", HANDLE)
    mp.fill("#u-pass", PASSWORD)
    mp.click("#u-form button[type=submit]")
    mp.wait_for_selector("text=Quick actions", timeout=15000)
    labels = [t.strip() for t in mp.locator(".bottomnav .bn-item").all_text_contents()]
    check("mobile bottom bar items", labels == ["Home", "Vouchers", "New", "Scan"], str(labels))
    mp.goto(BASE + "#/vouchers")
    mp.wait_for_selector("#v-mine >> text=" + VOUCHER, timeout=10000)
    active = mp.locator(".bottomnav .bn-item.active").inner_text()
    check("mobile bottom bar highlights Vouchers", active.strip() == "Vouchers", active)

    browser.close()

print("UI TESTS OK ✅" if pass_all else "UI TESTS FAILED ❌")
sys.exit(0 if pass_all else 1)
