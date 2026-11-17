"""What the text in an image says about it. RapidOCR reads screenshots, documents, receipts and notes,
and these lists decide what that text means. Edit them freely, and add the documents, bills and apps of
your own country:

- Each entry is a word or phrase, matched as whole words. Upper/lower case and accents don't matter
  ("reçu" also matches "recu").
- An entry starting with "re:" is a regular expression instead, for patterns like "50% off".
- RapidOCR's default models read Latin letters (English and most European languages) and Chinese.

How they're used (see rules.py):
  IMPORTANT     anything that mentions one of these is kept: IDs, legal, medical, money, tax and education papers
  RECEIPT       two or more of these words mean the image is a receipt or bill
  RECEIPT_KEEP  a bill that mentions one of these may be worth keeping (warranty, medical, fees): Unsure
  CHECK         tickets, bookings, orders, parcels: you may still need them, so they go to Unsure
  THROWAWAY     temporary screen content (codes, delivery updates, chats, feeds, ads): suggested for deletion
"""
import re
import unicodedata

IMPORTANT = [
    # identity, anywhere
    "passport", "national id", "identity card", "id card", "residence permit", "residence card", "visa number",
    "visa no", "visa type", "entry visa", "work visa", "student visa",
    "driving licence", "driving license", "driver license", "driver's license", "drivers license", "licence no",
    "license no", "state id", "real id", "permanent resident", "green card", "work permit",
    "citizenship certificate", "certificate of naturalization", "voter id", "voter registration",
    "birth certificate", "death certificate", "marriage certificate", "divorce decree", "adoption certificate",
    # United States
    "social security", "ssn", "medicare", "medicaid", "w-2", "w2", "1099", "form 1040", "irs", "tax return",
    "explanation of benefits", "member id", "group number", "immunization record", "vehicle registration",
    "certificate of title", "routing number", "mortgage statement", "mortgage agreement", "deed of trust",
    "401k", "401(k)",
    # United Kingdom and Ireland
    "national insurance", "nhs number", "hmrc", "p60", "p45", "council tax", "biometric residence permit",
    "brp", "v5c", "mot certificate", "tenancy agreement", "pps number",
    # Europe (also in local languages)
    "iban", "bic", "tax id", "tax number", "steuernummer", "steuer-id", "steuerbescheid", "lohnsteuer",
    "sozialversicherung", "krankenversicherung", "krankenkasse", "reisepass", "personalausweis",
    "aufenthaltstitel", "fuhrerschein", "meldebescheinigung", "carte vitale", "carte d'identite",
    "carte nationale d'identite", "passeport", "titre de sejour", "permis de conduire", "avis d'imposition",
    "securite sociale", "pasaporte", "dni", "permiso de conducir", "seguridad social", "codice fiscale",
    "carta d'identita", "passaporto", "patente di guida", "tessera sanitaria", "bsn", "paspoort",
    "rijbewijs", "personnummer", "ehic", "european health insurance card",
    # India
    "aadhaar", "aadhar", "uidai", "unique identification", "pan card", "permanent account number",
    "income tax department", "ration card", "election commission", "form 16", "ifsc", "caste certificate",
    "domicile", "overseas citizen",
    # education
    "certificate", "diploma", "degree certificate", "transcript", "marksheet", "mark sheet", "grade sheet",
    "grade card", "report card", "provisional certificate", "migration certificate", "leaving certificate",
    "zeugnis", "abitur", "baccalaureat",
    # work and money
    "employment contract", "arbeitsvertrag", "offer letter", "appointment letter", "relieving letter",
    "experience letter", "reference letter", "payslip", "pay slip", "pay stub", "paystub", "salary slip",
    "lohnabrechnung", "bulletin de salaire", "nomina", "bank statement", "kontoauszug", "passbook",
    "account number", "account no", "a/c no", "cheque", "check no", "loan account", "loan agreement",
    "fixed deposit", "pension statement", "nominee",
    # insurance and health
    "insurance policy", "policy no", "policy number", "health insurance", "insurance card", "prescription",
    "diagnosis", "discharge summary", "lab report", "lab results", "test report", "test results",
    "medical report", "medical record", "vaccination", "vaccination certificate", "vaccine card", "covid certificate",
    "ordonnance", "arztbrief", "receta medica",
    # property and legal
    "deed", "sale deed", "title deed", "rent agreement", "lease agreement", "rental agreement", "mietvertrag",
    "affidavit", "power of attorney", "notary", "notarized", "registration certificate", "rc book",
    "property tax", "legal notice", "court order", "court notice", "summons", "will and testament", "last will",
]

RECEIPT = [
    # English
    "total", "subtotal", "sub total", "sub-total", "grand total", "total due", "amount due", "balance due",
    "amount paid", "net amount", "qty", "quantity", "unit price", "tax", "sales tax", "vat",
    "vat no", "gst", "gstin", "cgst", "sgst", "igst", "hst", "pst", "tip", "gratuity", "invoice", "tax invoice",
    "invoice no", "bill no", "bill number", "receipt", "receipt no", "receipt #", "cash", "change due",
    "card no", "visa", "mastercard", "amex", "payment method", "payment mode", "txn", "transaction id",
    "auth code", "approval code", "cashier", "store #", "mrp",
    "discount", "thank you for shopping", "thank you for your purchase", "visit again", "customer copy",
    # German, French, Spanish, Italian, Dutch
    "summe", "gesamt", "gesamtbetrag", "betrag", "zwischensumme", "mwst", "ust", "rechnung", "quittung",
    "kassenbon", "ec-karte", "facture", "recu", "total ttc", "ttc", "ht", "tva", "montant",
    "ticket de caisse", "factura", "recibo", "importe", "iva", "subtotal", "efectivo", "scontrino", "ricevuta",
    "totale", "importo", "kassabon", "totaal", "btw", "bedrag",
]

RECEIPT_KEEP = [
    "warranty", "guarantee", "garantie", "garantia", "garanzia", "extended warranty", "applecare", "imei",
    "serial no", "serial number", "seriennummer", "insurance premium", "premium receipt", "tuition",
    "school fee", "tuition fee", "college fee", "hospital", "clinic", "pharmacy", "apotheke", "pharmacie",
    "farmacia", "medical", "doctor", "dental", "rent receipt", "utility bill", "electricity bill", "gas bill",
    "water bill", "property tax", "council tax", "donation", "tax deductible", "spendenquittung",
]

CHECK = [
    # travel
    "ticket", "e-ticket", "eticket", "boarding pass", "pnr", "confirmation number",
    "confirmation code", "booking reference", "booking id", "booking confirmed", "reservation", "itinerary",
    "check-in", "gate no", "seat no", "flight", "record locator", "train no", "coach no", "gleis",
    "fahrkarte", "billet", "biglietto", "billete", "irctc", "amtrak", "eurostar", "greyhound", "flixbus",
    "hotel booking", "airbnb",
    # events and appointments
    "admission", "admit card", "hall ticket", "event ticket", "ticketmaster", "appointment", "token no",
    # orders, parcels and returns
    "order id", "order number", "order #", "tracking id", "tracking number", "awb", "return label",
    "return window", "refund", "ups", "fedex", "dhl", "usps", "royal mail", "hermes", "dpd", "colissimo",
]

THROWAWAY = [
    # codes and phone alerts
    "otp", "one time password", "one-time password", "verification code", "is your code", "your code is",
    "security code", "login code", "sign-in code", "authentication code", "2fa", "do not share",
    "bestatigungscode", "code de verification", "codigo de verificacion", "codice di verifica",
    "low battery", "battery", "low storage", "storage almost full", "update available", "screen time",
    # deliveries and payments
    "delivered", "out for delivery", "arriving today", "arriving tomorrow", "your package", "order placed",
    "order confirmed", "shipped", "zugestellt", "colis livre", "entregado", "consegnato", "bezorgd",
    "payment successful", "payment received", "payment done", "payment sent", "paid to", "sent to",
    "you sent", "you received", "money sent", "received from", "venmo", "zelle", "cash app",
    "cashback", "scratch card", "coupon", "promo code", "free shipping", "offer ends", "sale",
    "re:\\d+\\s*%\\s*off",
    # chats, social media and forwards
    "typing", "last seen", "online", "forwarded", "forwarded many times", "followers", "following",
    "likes", "retweet", "repost", "reels", "subscribe", "swipe up", "good morning", "good night",
    "wi-fi", "wifi",
]


def fold(text):
    """Lower case, accents removed: 'Reçu' -> 'recu', 'FÜHRERSCHEIN' -> 'fuhrerschein'."""
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


def compile_list(words):
    """One pattern that matches any entry as a whole word or phrase (in folded text)."""
    parts = []
    for w in dict.fromkeys(words):  # drop repeats, keep order
        if w.startswith("re:"):
            parts.append(w[3:])
        else:  # whole words: not glued to other letters or digits; spaces match any run of whitespace
            parts.append(r"(?<![a-z0-9])" + r"\s+".join(re.escape(p) for p in fold(w).split()) + r"(?![a-z0-9])")
    return re.compile("|".join(parts))


PATTERNS = {name: compile_list(words) for name, words in
            {"important": IMPORTANT, "receipt": RECEIPT, "receipt_keep": RECEIPT_KEEP,
             "check": CHECK, "throwaway": THROWAWAY}.items()}


def first(name, text):
    """The first entry of a list found in the text, or None."""
    m = PATTERNS[name].search(fold(text))
    return " ".join(m.group(0).split()) if m else None


def count(name, text):
    """How many different entries of a list appear in the text."""
    return len({" ".join(m.group(0).split()) for m in PATTERNS[name].finditer(fold(text))})
