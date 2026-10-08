from .schema import RoomObject, RoomSpec

ROOMS = {
    "kitchen": ("Kitchen", "Counters, cabinets, and everyday objects", "#c28b50"),
    "living-room": ("Living room", "A place to move, arrange, and explore", "#7f9a83"),
    "bedroom": ("Bedroom", "Drawers, books, and bedside essentials", "#9495b6"),
    "bathroom": ("Bathroom", "Shelves, storage, and small objects", "#75a5b0"),
}


def obj(id, label, kind, pos, size, color="#ba9474", movable=False, mass=.3):
    return RoomObject(id=id, label=label, kind=kind, position=pos, size=size,
                      color=color, movable=movable, mass=mass)


def example_room(room_id: str) -> RoomSpec:
    common = [obj("storage", "Storage cabinet", "cabinet", [-1.45, .85, 0], [.85, .6, 1.2]),
              obj("drawer", "Pull-out drawer", "drawer", [1.4, .9, 0], [.8, .6, .85])]
    if room_id == "kitchen":
        objects = common + [
            obj("counter", "Kitchen counter", "counter", [0, 1.35, 0], [1.8, .65, .95], "#e4d8bf"),
            obj("table", "Prep table", "table", [0, -.35, 0], [1.5, .85, .75]),
            obj("cup", "Ceramic cup", "cup", [-.35, -.35, .76], [.13, .13, .16], "#e9ddc5", True),
            obj("bowl", "Serving bowl", "bowl", [.35, -.35, .76], [.32, .32, .1], "#78948a", True, .5),
        ]
    elif room_id == "living-room":
        objects = common + [
            obj("sofa", "Sofa", "sofa", [0, 1.2, 0], [1.8, .8, .8], "#849b88"),
            obj("table", "Coffee table", "table", [0, -.35, 0], [1.4, .75, .45]),
            obj("remote", "Remote control", "box", [-.35, -.35, .46], [.08, .2, .035], "#393e44", True),
            obj("book", "Book", "book", [.32, -.35, .46], [.2, .26, .055], "#bc754d", True),
        ]
    elif room_id == "bedroom":
        objects = common + [
            obj("bed", "Bed", "bed", [0, 1.05, 0], [1.3, 1.5, .65], "#a6a0ba"),
            obj("table", "Bedside table", "table", [0, -.6, 0], [1.15, .7, .65]),
            obj("book", "Bedside book", "book", [-.25, -.6, .66], [.2, .25, .05], "#aa765f", True),
            obj("bottle", "Water bottle", "bottle", [.27, -.6, .66], [.09, .09, .23], "#87a9b2", True),
        ]
    else:
        objects = common + [
            obj("counter", "Vanity surface", "counter", [0, -.35, 0], [1.5, .65, .8], "#d8e2de"),
            obj("shelf", "Bathroom shelves", "shelf", [0, 1.5, 0], [1.2, .4, 1.5], "#94b3b8"),
            obj("bottle", "Soap bottle", "bottle", [-.35, -.35, .81], [.1, .1, .22], "#88b2a5", True),
            obj("tray", "Vanity tray", "tray", [.3, -.35, .81], [.35, .25, .06], "#c6b699", True),
        ]
    return RoomSpec(room_id=room_id, name=ROOMS[room_id][0], objects=objects,
                    notes=["Example scene. Upload your room footage to reconstruct its visible layout."])
