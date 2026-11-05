"""Phase 0 PayPal sandbox spikes H1 (partial capture), H2 (capture + refunds), H3 (vault + merchant-initiated
authorization), H5 (payout to a third party). Prints ids and statuses only, never the token."""
import json, subprocess, sys, time, urllib.request, urllib.error

REPO = sys.argv[1]
B = "https://api-m.sandbox.paypal.com"
TOKEN = subprocess.check_output([f"{REPO}/scripts/paypal-token.sh"], text=True).strip()
T = str(int(time.time()))
CARD = {"name": "Milestone Spike", "number": "4012888888881881", "expiry": "2030-12", "security_code": "123",
        "billing_address": {"address_line_1": "1 Main St", "admin_area_2": "San Jose", "admin_area_1": "CA", "postal_code": "95131", "country_code": "US"}}
results = {}

def call(method, path, body=None, rid=None, prefer=True):
    h = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = "return=representation"
    if rid: h["PayPal-Request-Id"] = f"spike-{T}-{rid}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode(); return r.status, (json.loads(txt) if txt else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try: j = json.loads(txt)
        except Exception: j = {"raw": txt[:300]}
        return e.code, j

def err(j): return {k: j.get(k) for k in ("name", "message", "debug_id")} | {"issues": [d.get("issue") for d in j.get("details", [])]}

def auth_order(value, rid, source=None):
    s, j = call("POST", "/v2/checkout/orders", {"intent": "AUTHORIZE", "purchase_units": [{"amount": {"currency_code": "USD", "value": value}}],
                                                "payment_source": source or {"card": CARD}}, rid)
    if s >= 300: return s, None, err(j)
    a = j["purchase_units"][0]["payments"]["authorizations"][0]
    return s, a["id"], {"order": j["id"], "order_status": j["status"], "auth_status": a["status"], "expires": a.get("expiration_time")}

def auth_status(aid):
    s, j = call("GET", f"/v2/payments/authorizations/{aid}", prefer=False)
    return j.get("status"), j.get("status_details")

# H1: partial capture with final_capture true releases the rest
s, aid, info = auth_order("10.00", "h1-order")
h1 = {"order": info}
if aid:
    s, j = call("POST", f"/v2/payments/authorizations/{aid}/capture", {"amount": {"currency_code": "USD", "value": "8.00"}, "final_capture": True}, "h1-cap")
    h1["capture"] = {"http": s, "id": j.get("id"), "status": j.get("status"), "amount": j.get("amount"), "fee": (j.get("seller_receivable_breakdown") or {}).get("paypal_fee")} if s < 300 else err(j)
    h1["auth_after"] = auth_status(aid)
    s, j = call("POST", f"/v2/payments/authorizations/{aid}/capture", {"amount": {"currency_code": "USD", "value": "1.00"}}, "h1-cap2")
    h1["capture_after_final"] = {"http": s, **(err(j) if s >= 300 else {"status": j.get("status")})}
    h1["capture_id"] = (h1["capture"] or {}).get("id")
results["H1_partial_final"] = h1

# H1b: two captures (5 then 3 final) on one authorization
s, aid, info = auth_order("10.00", "h1b-order")
h1b = {"order": info}
if aid:
    s, j = call("POST", f"/v2/payments/authorizations/{aid}/capture", {"amount": {"currency_code": "USD", "value": "5.00"}, "final_capture": False}, "h1b-cap1")
    h1b["cap1"] = {"http": s, "status": j.get("status")} if s < 300 else err(j)
    h1b["auth_mid"] = auth_status(aid)
    s, j = call("POST", f"/v2/payments/authorizations/{aid}/capture", {"amount": {"currency_code": "USD", "value": "3.00"}, "final_capture": True}, "h1b-cap2")
    h1b["cap2"] = {"http": s, "status": j.get("status")} if s < 300 else err(j)
    h1b["auth_after"] = auth_status(aid)
results["H1b_multi_capture"] = h1b

# H2: intent CAPTURE, then partial refund 3, then refund the rest
s, j = call("POST", "/v2/checkout/orders", {"intent": "CAPTURE", "purchase_units": [{"amount": {"currency_code": "USD", "value": "10.00"}}], "payment_source": {"card": CARD}}, "h2-order")
h2 = {}
if s < 300:
    cap = j["purchase_units"][0]["payments"]["captures"][0]
    h2["capture"] = {"id": cap["id"], "status": cap["status"], "fee": (cap.get("seller_receivable_breakdown") or {}).get("paypal_fee")}
    s, r = call("POST", f"/v2/payments/captures/{cap['id']}/refund", {"amount": {"currency_code": "USD", "value": "3.00"}}, "h2-ref1")
    h2["refund_partial"] = {"http": s, "id": r.get("id"), "status": r.get("status"), "breakdown": r.get("seller_payable_breakdown")} if s < 300 else err(r)
    s, r = call("POST", f"/v2/payments/captures/{cap['id']}/refund", {}, "h2-ref2")
    h2["refund_rest"] = {"http": s, "id": r.get("id"), "status": r.get("status"), "amount": r.get("amount"), "breakdown": r.get("seller_payable_breakdown")} if s < 300 else err(r)
    s, c = call("GET", f"/v2/payments/captures/{cap['id']}", prefer=False)
    h2["capture_after"] = c.get("status")
else:
    h2 = err(j)
results["H2_capture_refund"] = h2

# H3: vault a card (setup token -> payment token), then authorize with vault_id and no buyer present
h3 = {}
s, st = call("POST", "/v3/vault/setup-tokens", {"payment_source": {"card": CARD}}, "h3-setup")
h3["setup_token"] = {"http": s, "id": st.get("id"), "status": st.get("status")} if s < 300 else err(st)
if s < 300:
    s, pt = call("POST", "/v3/vault/payment-tokens", {"payment_source": {"token": {"id": st["id"], "type": "SETUP_TOKEN"}}}, "h3-ptoken")
    h3["payment_token"] = {"http": s, "id": pt.get("id"), "customer": (pt.get("customer") or {}).get("id")} if s < 300 else err(pt)
    if s < 300:
        vid = pt["id"]
        for label, src in [
            ("mit_unscheduled", {"card": {"vault_id": vid, "stored_credential": {"payment_initiator": "MERCHANT", "payment_type": "UNSCHEDULED", "usage": "SUBSEQUENT"}}}),
            ("vault_id_only", {"card": {"vault_id": vid}}),
        ]:
            s, aid, info = auth_order("12.00", f"h3-{label}", src)
            h3[label] = {"http": s, "auth": aid, **info}
            if aid:
                vs, _ = call("POST", f"/v2/payments/authorizations/{aid}/void", None, f"h3-void-{label}", prefer=False)
                h3[label]["voided_http"] = vs
results["H3_vault_mit"] = h3

# H5: payout $1 to the sandbox client account as a stand-in arbitrator
s, j = call("POST", "/v1/payments/payouts", {"sender_batch_header": {"sender_batch_id": f"spike-{T}-h5", "email_subject": "Arbitration fee (spike)"},
                                             "items": [{"recipient_type": "EMAIL", "receiver": "sb-eg47t53461254@personal.example.com",
                                                        "amount": {"currency": "USD", "value": "1.00"}, "sender_item_id": f"h5-{T}"}]}, "h5-payout", prefer=False)
h5 = {"http": s, "batch": (j.get("batch_header") or {}).get("payout_batch_id"), "status": (j.get("batch_header") or {}).get("batch_status")} if s < 300 else err(j)
if s < 300:
    for _ in range(8):
        time.sleep(5)
        _, b = call("GET", f"/v1/payments/payouts/{h5['batch']}", prefer=False)
        h5["item_status"] = (b.get("items") or [{}])[0].get("transaction_status")
        if h5["item_status"] in ("SUCCESS", "FAILED", "UNCLAIMED", "RETURNED"): break
results["H5_payout_third_party"] = h5

print(json.dumps(results, indent=1))
