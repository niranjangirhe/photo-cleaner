"""Every tag the tagger gives, with the short sentences SigLIP compares each photo against.
Each tag has a few phrasings; their fingerprints are averaged, which is steadier than one long sentence.

Change or add tags freely: tags are worked out from fingerprints saved during the first run,
so a change only needs another Continue, not a new pass over the photos.
"""

# What kind of image it is. Exactly one per photo (the best match).
TYPES = {
    "photo": ["a photo.", "a photograph taken with a camera.", "a photo of people.", "a photo of a place.",
              "a photo of an object."],
    "screenshot": ["a screenshot.", "a screenshot of a phone screen.", "a screenshot of an app.",
                   "a screenshot of a website."],
    "document": ["a photo of a document.", "a scanned document.", "a printed page of text.", "a certificate."],
    "id_card": ["an identity card.", "a passport.", "a driving licence.", "a bank card."],
    "receipt": ["a receipt.", "a shop bill.", "an invoice."],
    "note": ["handwritten notes.", "a whiteboard.", "a page of a notebook."],
    "meme": ["a meme.", "a funny meme with text.", "a cartoon."],
    "greeting": ["a good morning greeting image.", "a festival greeting card.", "a happy birthday wish image with text."],
    "artwork": ["a painting.", "a drawing.", "digital art.", "an abstract wallpaper."],
}

# What occasion it shows. "none" competes with the rest, so everyday photos get no event.
EVENTS = {
    "none": ["a photo.", "an everyday photo.", "a random photo.", "a photo of an ordinary day."],
    # weddings
    "wedding": ["a wedding.", "a photo of a wedding ceremony.", "a bride and groom.", "a wedding mandap.",
                "a wedding reception stage."],
    "pre_wedding": ["a haldi ceremony with yellow turmeric.", "mehndi henna on hands at a mehndi ceremony.",
                    "a sangeet dance night."],
    "engagement": ["an engagement ring ceremony.", "a couple exchanging rings."],
    # family celebrations
    "birthday": ["a birthday party.", "a birthday cake with candles.", "cutting a birthday cake."],
    "anniversary": ["a wedding anniversary celebration.", "a couple cutting an anniversary cake."],
    "baby_shower": ["a baby shower.", "a godh bharai ceremony for a pregnant woman."],
    "housewarming": ["a housewarming party.", "a griha pravesh puja in a new home."],
    "party": ["a party with friends.", "people celebrating at a party."],
    # festivals
    "diwali": ["diwali lamps and diyas.", "a rangoli with diyas.", "diwali fireworks and sparklers."],
    "holi": ["holi colours on faces.", "people playing holi with coloured powder."],
    "ganesh": ["a ganesh idol.", "ganesh chaturthi celebration.", "ganpati decoration at home."],
    "navratri": ["garba dance.", "navratri dandiya night."],
    "raksha_bandhan": ["a rakhi tied on a wrist.", "raksha bandhan celebration."],
    "eid": ["eid celebration.", "eid prayers and festive food."],
    "christmas": ["a christmas tree.", "christmas decorations."],
    "new_year": ["new year's eve countdown party.", "new year fireworks."],
    "festival": ["a festival celebration.", "festive decorations and lights."],
    # other occasions
    "religious": ["a temple.", "a religious ceremony.", "a puja.", "a church."],
    "concert": ["a concert.", "a stage performance."],
    "graduation": ["a graduation ceremony.", "a school function."],
    "sports": ["people playing sports.", "a cricket match.", "a football game."],
    "trip": ["a holiday trip.", "a tourist spot.", "a vacation."],
    "work": ["an office.", "a business meeting.", "a conference."],
}
EVENT_MIN = 0.5
# Similar events split the model's confidence between them. When a whole family clearly wins,
# the photo still gets its best event from that family (e.g. wedding 0.35 + pre_wedding 0.25).
EVENT_FAMILIES = {
    "wedding": {"wedding", "pre_wedding", "engagement"},
    "celebration": {"birthday", "anniversary", "baby_shower", "housewarming", "party"},
    "festival": {"diwali", "holi", "ganesh", "navratri", "raksha_bandhan", "eid", "christmas", "new_year", "festival"},
}
# Events that also get the "celebration" tag, so one filter finds them all
CELEBRATIONS = EVENT_FAMILIES["wedding"] | EVENT_FAMILIES["celebration"] | EVENT_FAMILIES["festival"]

# What's in it. Up to SCENE_MAX per photo; they compete with a plain "a photo." so weak matches drop out.
SCENES = {
    "selfie": ["a selfie."],
    "group": ["a group photo of several people.", "a group of friends."],
    "kids": ["a baby.", "a small child."],
    "dog": ["a dog."],
    "cat": ["a cat."],
    "food": ["a plate of food.", "a meal."],
    "beach": ["a beach.", "the sea."],
    "mountains": ["mountains.", "hills."],
    "nature": ["trees and a forest.", "a garden.", "green fields."],
    "city": ["a city street.", "buildings and traffic."],
    "monument": ["a famous monument.", "a historic building."],
    "sunset": ["a sunset.", "a sunrise."],
    "night": ["a photo taken at night."],
    "vehicle": ["a car.", "a motorbike."],
    "flowers": ["flowers."],
    "home": ["the inside of a home.", "a living room."],
    "shopping": ["a product photo.", "things for sale in a shop."],
    "chat": ["a chat conversation on a phone."],
    "social": ["a social media post."],
    "map": ["a map.", "directions on a map."],
}
SCENE_OTHER = ["a photo.", "a picture.", "an image."]
SCENE_MIN = 0.15
SCENE_MAX = 3
SCREEN_SCENES = {"chat", "social", "map", "shopping"}  # the only scene tags that make sense on a screenshot

# Photo problems: each is (problem phrasings, opposite phrasings). Only checked on camera photos.
PROBLEMS = {
    "blurry": (["a blurry photo.", "an out of focus photo.", "a photo with motion blur."],
               ["a sharp photo.", "an in focus photo."]),
    "dark": (["a very dark photo.", "a black photo where nothing can be seen."],
             ["a well lit photo.", "a bright photo."]),
    "accidental": (["an accidental photo of the floor.", "a photo taken inside a pocket.", "a finger covering the lens.",
                    "an accidental photo of the ceiling."],
                   ["a photo taken on purpose.", "a photo of a clear subject."]),
}
PROBLEM_MIN = 0.9


def all_prompts():
    """(group, key, sentence) for every sentence the text model needs to read."""
    out = [("type", k, s) for k, v in TYPES.items() for s in v]
    out += [("event", k, s) for k, v in EVENTS.items() for s in v]
    out += [("scene", k, s) for k, v in SCENES.items() for s in v]
    out += [("scene", "_other", s) for s in SCENE_OTHER]
    for k, (yes, no) in PROBLEMS.items():
        out += [("problem", k, s) for s in yes] + [("problem_no", k, s) for s in no]
    return out
