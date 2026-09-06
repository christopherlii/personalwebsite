# favs photos

Drop photos here, one folder per category:

    static/images/favs/sports/
    static/images/favs/films/
    static/images/favs/friends/
    static/images/favs/side-quests/

Name files after the thing they show, numbered when there are several:

    barcelona-1.jpg
    barcelona-2.jpg
    
Then wire them in solaces/index.json — each item takes a photos array:

    { "name": "barcelona", "photos": [
        "/static/images/favs/sports/barcelona-1.jpg",
        "/static/images/favs/sports/barcelona-2.jpg" ] }

Rules the site enforces by itself:
- a tile = a thing; a category needs 6 things with photos for a full grid
- no two photos of the same thing ever appear in one set of six
- a category button turns on automatically once it has any photo

Or just drop the files in and ask Claude to wire them — filenames like the
above are enough to infer the JSON.
